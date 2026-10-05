/**
 * This script checks that every changelog entry introduced by a pull request
 * references that pull request.  For each fragment holding such an entry it
 * verifies that:
 *
 *  -  the trailing references at the end of the first paragraph of every
 *     introduced entry include the current pull request number, and
 *  -  the `links` frontmatter maps that number to
 *     `https://github.com/fedify-dev/fedify/pull/<number>`.
 *
 * Only the non-merge commits on the first-parent chain of the pull request
 * head count as the pull request's own work, so entries carried forward from
 * earlier pull requests through a merge (e.g., a maintenance branch
 * forward-port) are excluded.  Every entry of a fragment that the pull
 * request adds is introduced by it.  In a fragment that already existed, an
 * entry is introduced when one of those commits adds the first line of the
 * top-level list item, so the historical entries of that fragment, including
 * those whose nested items or later lines the pull request edits, are
 * excluded.  The check runs against the head revision, so later edits to
 * introduced entries made in the same pull request are checked as well.  A
 * pull request without any changelog fragment passes.
 *
 * Usage:
 *
 * ~~~~ bash
 * deno run --allow-read --allow-run=git scripts/check_changelog_pr_refs.ts \
 *   --pr <number> --base <revision> [--head <revision>]
 * ~~~~
 */
import { parseArgs } from "node:util";
import { dirname, fromFileUrl, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

/** The directory that holds changelog fragments, relative to the root. */
export const FRAGMENTS_DIRECTORY = "changes.d";

/** The URL prefix of pull requests in the upstream repository. */
export const PULL_REQUEST_URL_PREFIX =
  "https://github.com/fedify-dev/fedify/pull/";

/** A problem found in a changelog fragment. */
export interface Violation {
  /** The fragment path, relative to the project root. */
  readonly path: string;
  /** A human-readable description of the problem and how to correct it. */
  readonly message: string;
}

/** A change to a changelog fragment in one commit. */
export interface FragmentChange {
  /** Whether the fragment was added, modified, deleted, or renamed. */
  readonly status: "A" | "M" | "D" | "R";
  /** The path after the change. */
  readonly path: string;
  /** The path before the change; differs from `path` only for renames. */
  readonly oldPath: string;
}

/** The changes a commit made to changelog fragments. */
export interface CommitChanges {
  /** The commit hash. */
  readonly commit: string;
  /** The changes, in the order Git reported them. */
  readonly changes: readonly FragmentChange[];
}

function isFragmentPath(path: string): boolean {
  return path.startsWith(`${FRAGMENTS_DIRECTORY}/`) && path.endsWith(".md");
}

/**
 * Parse the output of `git log --name-status --format="commit %H"`.
 *
 * @param log The output of `git log` over the commits of the pull request.
 * @returns The changes to changelog fragments, grouped by commit, in the
 *          order the commits appear in `log`.
 */
export function parseNameStatusLog(log: string): CommitChanges[] {
  const commits: { commit: string; changes: FragmentChange[] }[] = [];
  for (const line of log.split("\n")) {
    const header = /^commit ([0-9a-f]+)$/.exec(line);
    if (header != null) {
      commits.push({ commit: header[1], changes: [] });
      continue;
    }
    const current = commits.at(-1);
    const [status, ...paths] = line.split("\t");
    if (current == null || status == null || paths.length < 1) continue;
    const [oldPath, newPath = oldPath] = paths;
    if (status === "A" || status === "M" || status === "D") {
      if (isFragmentPath(oldPath)) {
        current.changes.push({ status, path: oldPath, oldPath });
      }
    } else if (status.startsWith("R")) {
      // A rename into or out of the fragments directory is an addition or a
      // deletion as far as fragments are concerned:
      if (isFragmentPath(oldPath) && isFragmentPath(newPath)) {
        current.changes.push({ status: "R", path: newPath, oldPath });
      } else if (isFragmentPath(newPath)) {
        current.changes.push({ status: "A", path: newPath, oldPath: newPath });
      } else if (isFragmentPath(oldPath)) {
        current.changes.push({ status: "D", path: oldPath, oldPath });
      }
    }
  }
  return commits;
}

/** The changelog entries that a pull request introduces in one fragment. */
export interface IntroducedFragment {
  /** The fragment path as of the head revision. */
  readonly path: string;
  /**
   * `"all"` if the pull request added the fragment itself; otherwise, the
   * first lines of the top-level list items that the pull request added.
   */
  readonly entries: "all" | ReadonlySet<string>;
}

/**
 * Determine which changelog entries a series of commits introduces.
 *
 * @param commits The changes of the pull request's own commits, oldest first.
 * @param readFile Reads a file at a revision.  It is only asked for files
 *                 that exist at that revision.
 * @returns The fragments holding introduced entries, sorted by path.
 */
export async function findIntroducedFragments(
  commits: readonly CommitChanges[],
  readFile: (revision: string, path: string) => Promise<string>,
): Promise<IntroducedFragment[]> {
  const introduced = new Map<string, "all" | Set<string>>();
  for (const { commit, changes } of commits) {
    for (const change of changes) {
      if (change.status === "A") {
        introduced.set(change.path, "all");
        continue;
      } else if (change.status === "D") {
        introduced.delete(change.path);
        continue;
      }
      let entries = introduced.get(change.oldPath);
      introduced.delete(change.oldPath);
      if (entries !== "all") {
        const before = new Set(
          extractEntries(await readFile(`${commit}^`, change.oldPath))
            .map((entry) => entry.firstLine),
        );
        const added = extractEntries(await readFile(commit, change.path))
          .map((entry) => entry.firstLine)
          .filter((firstLine) => !before.has(firstLine));
        if (added.length > 0) entries = new Set([...entries ?? [], ...added]);
      }
      if (entries != null) introduced.set(change.path, entries);
    }
  }
  return [...introduced]
    .map(([path, entries]) => ({ path, entries }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** A top-level list item of a changelog fragment. */
interface Entry {
  /** The line holding the list marker, without trailing whitespace. */
  readonly firstLine: string;
  /** The first paragraph of the item, joined into one line. */
  readonly paragraph: string;
}

/** The pieces of a changelog fragment relevant to this check. */
interface ParsedFragment {
  readonly links: Readonly<Record<string, unknown>> | null;
  readonly entries: readonly Entry[];
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function parseFragment(content: string): ParsedFragment | string {
  const text = normalizeNewlines(content);
  const frontmatter = FRONTMATTER_PATTERN.exec(text);
  let links: Record<string, unknown> | null = null;
  if (frontmatter != null) {
    let metadata: unknown;
    try {
      metadata = parseYaml(frontmatter[1]);
    } catch (error) {
      return `could not parse the frontmatter: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (metadata != null && typeof metadata === "object") {
      const value = (metadata as Record<string, unknown>).links;
      if (value != null && typeof value === "object") {
        links = value as Record<string, unknown>;
      }
    }
  }
  return { links, entries: extractEntries(text) };
}

/** Return the top-level list items of a fragment, skipping frontmatter. */
function extractEntries(content: string): Entry[] {
  const text = normalizeNewlines(content);
  const frontmatter = FRONTMATTER_PATTERN.exec(text);
  const body = frontmatter == null ? text : text.slice(frontmatter[0].length);
  const entries: Entry[] = [];
  let current: { firstLine: string; lines: string[] } | null = null;
  let inFirstParagraph = false;
  const flush = () => {
    if (current == null) return;
    entries.push({
      firstLine: current.firstLine,
      paragraph: current.lines.join(" "),
    });
  };
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}[-*+] +(.*)$/.exec(line);
    if (marker != null) {
      flush();
      current = { firstLine: line.trimEnd(), lines: [marker[1].trim()] };
      inFirstParagraph = true;
    } else if (current != null && inFirstParagraph) {
      if (line.trim() === "") inFirstParagraph = false;
      else current.lines.push(line.trim());
    }
  }
  flush();
  return entries;
}

/**
 * Matches the trailing reference group of a paragraph, such as
 * `[[#123], [#456] by John Doe]`.
 */
const TRAILING_REFERENCES_PATTERN =
  /\[(\[#\d+\](?:\s*,\s*\[#\d+\])*)(?:\s+by\s+[^\[\]]+)?\]\s*$/;

function extractTrailingReferences(paragraph: string): number[] | null {
  const match = TRAILING_REFERENCES_PATTERN.exec(paragraph);
  if (match == null) return null;
  return Array.from(match[1].matchAll(/\[#(\d+)\]/g), (m) => Number(m[1]));
}

/** Return the numbers of the pull requests that `links` points to. */
function findLinkedPullRequests(
  links: Readonly<Record<string, unknown>>,
): number[] {
  const numbers: number[] = [];
  for (const [key, url] of Object.entries(links)) {
    const keyMatch = /^#(\d+)$/.exec(key);
    if (keyMatch == null || typeof url !== "string") continue;
    if (url === `${PULL_REQUEST_URL_PREFIX}${keyMatch[1]}`) {
      numbers.push(Number(keyMatch[1]));
    }
  }
  return numbers;
}

/**
 * Check that the introduced entries of a changelog fragment reference the
 * current pull request.
 *
 * @param path The fragment path, used in the returned violations.
 * @param content The fragment content.
 * @param pullRequest The number of the current pull request.
 * @param entries The entries to check: `"all"`, or the first lines of the
 *                introduced entries as returned by
 *                {@link findIntroducedFragments}.  If none of the given
 *                entries remain in `content`, nothing is checked.
 * @returns The problems found, or an empty array if there are none.
 */
export function checkFragment(
  path: string,
  content: string,
  pullRequest: number,
  entries: "all" | ReadonlySet<string> = "all",
): Violation[] {
  const parsed = parseFragment(content);
  if (typeof parsed === "string") return [{ path, message: parsed }];
  const selected = parsed.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entries === "all" || entries.has(entry.firstLine));
  if (entries !== "all" && selected.length < 1) return [];

  const ref = `#${pullRequest}`;
  const expectedUrl = `${PULL_REQUEST_URL_PREFIX}${pullRequest}`;
  const otherPullRequests = parsed.links == null
    ? []
    : findLinkedPullRequests(parsed.links)
      .filter((number) => number !== pullRequest);
  const predictionHint = otherPullRequests.length > 0
    ? `  It links to ${
      otherPullRequests.map((n) => `#${n}`).join(", ")
    } instead; if that number was predicted, replace it with ${ref} in both ` +
      "the links metadata and the trailing references."
    : "";

  const violations: Violation[] = [];
  const linked = parsed.links?.[ref];
  if (linked == null) {
    violations.push({
      path,
      message: `the links metadata has no entry for '${ref}'.  Add ` +
        `'${ref}': ${expectedUrl} under links.${predictionHint}`,
    });
  } else if (linked !== expectedUrl) {
    violations.push({
      path,
      message: `the links metadata maps '${ref}' to ${
        typeof linked === "string" ? linked : JSON.stringify(linked)
      }.  Change it to ${expectedUrl}.`,
    });
  }

  if (selected.length < 1) {
    violations.push({ path, message: "the fragment has no list entry." });
  }
  for (const { entry: { paragraph }, index } of selected) {
    const entry = parsed.entries.length > 1 ? `entry ${index + 1}` : "entry";
    const references = extractTrailingReferences(paragraph);
    if (references == null) {
      violations.push({
        path,
        message: `the ${entry} has no trailing references.  End its first ` +
          `paragraph with the accepted issue and the pull request, e.g., ` +
          `[[#123], [${ref}]].`,
      });
    } else if (!references.includes(pullRequest)) {
      violations.push({
        path,
        message:
          `the trailing references of the ${entry} (${
            references.map((n) => `[#${n}]`).join(", ")
          }) do not include the current pull request.  Add [${ref}] to ` +
          `them.${predictionHint}`,
      });
    }
  }
  return violations;
}

async function git(projectRoot: string, args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${decoder.decode(stderr)}`,
    );
  }
  return decoder.decode(stdout);
}

/** Options for {@link checkChangelogPrRefs}. */
export interface CheckOptions {
  /** The number of the current pull request. */
  readonly pullRequest: number;
  /** The base revision of the pull request. */
  readonly base: string;
  /** The head revision of the pull request. */
  readonly head: string;
}

/**
 * Check the changelog entries that a pull request introduces.
 *
 * @param projectRoot The root of the Git working tree.
 * @param options The pull request to check.
 * @returns The paths of the fragments holding introduced entries and the
 *          problems found in them.
 */
export async function checkChangelogPrRefs(
  projectRoot: string,
  options: CheckOptions,
): Promise<{ fragments: string[]; violations: Violation[] }> {
  const log = await git(projectRoot, [
    "-c",
    "core.quotePath=false",
    "log",
    "--first-parent",
    "--no-merges",
    "--reverse",
    "--find-renames",
    "--name-status",
    "--format=commit %H",
    `${options.base}..${options.head}`,
    "--",
    FRAGMENTS_DIRECTORY,
  ]);
  const readFile = (revision: string, path: string) =>
    git(projectRoot, ["show", `${revision}:${path}`]);
  const introduced = await findIntroducedFragments(
    parseNameStatusLog(log),
    readFile,
  );
  const fragments: string[] = [];
  const violations: Violation[] = [];
  for (const { path, entries } of introduced) {
    const content = await readFile(options.head, path);
    if (
      entries !== "all" &&
      !extractEntries(content).some((entry) => entries.has(entry.firstLine))
    ) {
      // The pull request added entries but removed or rewrote them later:
      continue;
    }
    fragments.push(path);
    violations.push(
      ...checkFragment(path, content, options.pullRequest, entries),
    );
  }
  return { fragments, violations };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Deno.args,
    options: {
      pr: { type: "string" },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
    },
  });
  const pullRequest = Number(values.pr);
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1 || !values.base) {
    console.error(
      "Usage: check_changelog_pr_refs.ts --pr <number> --base <revision> " +
        "[--head <revision>]",
    );
    Deno.exit(2);
  }
  const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
  const { fragments, violations } = await checkChangelogPrRefs(projectRoot, {
    pullRequest,
    base: values.base,
    head: values.head ?? "HEAD",
  });
  if (fragments.length < 1) {
    console.log("This pull request introduces no changelog entries.");
  }
  for (const { path, message } of violations) {
    console.error(`${path}: ${message}`);
  }
  if (violations.length > 0) Deno.exit(1);
  if (fragments.length > 0) {
    console.log(
      `All changelog entries introduced in ${fragments.length} fragment(s) ` +
        `reference #${pullRequest}.`,
    );
  }
}
