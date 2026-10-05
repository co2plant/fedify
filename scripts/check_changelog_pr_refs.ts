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
 * forward-port) are excluded.  The merge commits on that chain are followed
 * only to keep track of the introduced entries they move, rewrite, or delete.
 * Every entry of a fragment that the pull request adds is introduced by it.
 * In a fragment that already existed, each commit's top-level list items are
 * matched with those of its first parent:
 *
 *  -  an item with the same content, even if moved, is the same entry;
 *  -  an item similar enough to one left unmatched is a rewrite of it (see
 *     {@link isRewrite}), so edits to historical entries, including their
 *     first lines, nested items, and later lines, are excluded; and
 *  -  any other item is inserted, and thus introduced.
 *
 * The check runs against the head revision, so later edits to introduced
 * entries made in the same pull request are checked as well.  A pull request
 * without any changelog fragment passes.
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
  /** Whether the commit is a merge; its changes are against the first parent. */
  readonly merge: boolean;
  /** The changes, in the order Git reported them. */
  readonly changes: readonly FragmentChange[];
}

function isFragmentPath(path: string): boolean {
  return path.startsWith(`${FRAGMENTS_DIRECTORY}/`) && path.endsWith(".md");
}

/**
 * Parse the output of `git log --name-status --format="commit %H %P"`.
 *
 * @param log The output of `git log` over the commits of the pull request.
 * @returns The changes to changelog fragments, grouped by commit, in the
 *          order the commits appear in `log`.
 */
export function parseNameStatusLog(log: string): CommitChanges[] {
  const commits: {
    commit: string;
    merge: boolean;
    changes: FragmentChange[];
  }[] = [];
  for (const line of log.split("\n")) {
    const header = /^commit ([0-9a-f]+)((?: [0-9a-f]+)*) ?$/.exec(line);
    if (header != null) {
      const parents = header[2].trim().split(" ").filter((p) => p !== "");
      commits.push({
        commit: header[1],
        merge: parents.length > 1,
        changes: [],
      });
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
   * 0-based indices of the top-level list items, as of the head revision,
   * that the pull request added.
   */
  readonly entries: "all" | ReadonlySet<number>;
}

/**
 * Determine which changelog entries a series of commits introduces.
 *
 * @param commits The changes of the commits on the first-parent chain of the
 *                pull request, oldest first.
 * @param readFile Reads a file at a revision.  It is only asked for files
 *                 that exist at that revision.
 * @returns The fragments holding introduced entries, sorted by path.
 */
export async function findIntroducedFragments(
  commits: readonly CommitChanges[],
  readFile: (revision: string, path: string) => Promise<string>,
): Promise<IntroducedFragment[]> {
  const introduced = new Map<string, "all" | ReadonlySet<number>>();
  for (const { commit, merge, changes } of commits) {
    for (const change of changes) {
      if (change.status === "D" || (change.status === "A" && merge)) {
        introduced.delete(change.path);
        continue;
      } else if (change.status === "A") {
        introduced.set(change.path, "all");
        continue;
      }
      const entries = introduced.get(change.oldPath);
      introduced.delete(change.oldPath);
      if (entries === "all" && !merge) {
        introduced.set(change.path, entries);
        continue;
      } else if (entries == null && merge) {
        continue;
      }
      const [before, after] = await Promise.all([
        readFile(`${commit}^`, change.oldPath).then(extractEntries),
        readFile(commit, change.path).then(extractEntries),
      ]);
      const followed = followEntries(
        before,
        after,
        // A merge may bring entries into a fragment the pull request added, so
        // its entries are tracked one by one from then on:
        entries === "all" ? new Set(before.keys()) : entries ?? new Set(),
        !merge,
      );
      if (followed.size > 0) introduced.set(change.path, followed);
    }
  }
  return [...introduced]
    .map(([path, entries]) => ({ path, entries }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Carry the introduced entries of a fragment across one change to it.
 *
 * @param before The entries before the change.
 * @param after The entries after the change.
 * @param introduced The indices of the introduced entries in `before`.
 * @param countInsertions Whether entries that the change inserts are
 *                        introduced, as opposed to carried in by a merge.
 * @returns The indices of the introduced entries in `after`.
 */
function followEntries(
  before: readonly Entry[],
  after: readonly Entry[],
  introduced: ReadonlySet<number>,
  countInsertions: boolean,
): Set<number> {
  // The index in `before` of the entry each entry in `after` derives from:
  const origins = new Array<number | undefined>(after.length);
  const matched = new Set<number>();
  // Pair the most similar entries first, so that unchanged entries, even if
  // moved, pair up before rewritten ones, and break ties, such as entries with
  // the same first paragraph, by the rest of their content:
  const candidates: { origin: number; index: number; score: number[] }[] = [];
  after.forEach((entry, index) => {
    before.forEach((candidate, origin) => {
      const similarity = isRewrite(candidate, entry);
      if (similarity <= 0) return;
      const score = [similarity, diceCoefficient(candidate.text, entry.text)];
      candidates.push({ origin, index, score });
    });
  });
  candidates.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1]);
  for (const { origin, index } of candidates) {
    if (matched.has(origin) || origins[index] != null) continue;
    origins[index] = origin;
    matched.add(origin);
  }
  const result = new Set<number>();
  for (let index = 0; index < after.length; index++) {
    const origin = origins[index];
    if (origin == null ? countInsertions : introduced.has(origin)) {
      result.add(index);
    }
  }
  return result;
}

/**
 * Tell whether an entry is a rewrite of another, rather than a new entry that
 * took its place.  The first paragraphs, without their trailing references,
 * have to be nearly the same, or at least similar if the entries share a
 * trailing reference: a rewritten entry keeps referring to the issue and the
 * pull request it describes, while a new one refers to its own.
 *
 * @returns The similarity of the entries if one is a rewrite of the other,
 *          or 0 otherwise.
 */
function isRewrite(original: Entry, rewritten: Entry): number {
  const similarity = diceCoefficient(
    stripTrailingReferences(original.paragraph),
    stripTrailingReferences(rewritten.paragraph),
  );
  if (similarity >= 0.8) return similarity;
  const references = extractTrailingReferences(rewritten.paragraph) ?? [];
  const shared = extractTrailingReferences(original.paragraph)
    ?.some((reference) => references.includes(reference));
  return shared && similarity >= 0.5 ? similarity : 0;
}

/** The Sørensen–Dice coefficient of the character bigrams of two strings. */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.slice(i, i + 2);
    const count = bigrams.get(bigram) ?? 0;
    if (count < 1) continue;
    bigrams.set(bigram, count - 1);
    shared++;
  }
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total < 1 ? 0 : 2 * shared / total;
}

/** A top-level list item of a changelog fragment. */
interface Entry {
  /** The first paragraph of the item, joined into one line. */
  readonly paragraph: string;
  /** The non-blank lines of the item, trimmed, to compare items with. */
  readonly text: string;
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
  const items: string[][] = [];
  for (const line of body.split("\n")) {
    if (/^ {0,3}[-*+] /.test(line)) items.push([line]);
    else items.at(-1)?.push(line);
  }
  return items.map((lines) => {
    const trimmed = lines.map((line) => line.trim());
    const blank = trimmed.indexOf("");
    return {
      paragraph: trimmed.slice(0, blank < 0 ? undefined : blank).join(" ")
        .replace(/^[-*+] +/, ""),
      text: trimmed.filter((line) => line !== "").join("\n"),
    };
  });
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

function stripTrailingReferences(paragraph: string): string {
  return paragraph.replace(TRAILING_REFERENCES_PATTERN, "").trimEnd();
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
 * @param entries The entries to check: `"all"`, or the 0-based indices of the
 *                introduced top-level list items as returned by
 *                {@link findIntroducedFragments}.
 * @returns The problems found, or an empty array if there are none.
 */
export function checkFragment(
  path: string,
  content: string,
  pullRequest: number,
  entries: "all" | ReadonlySet<number> = "all",
): Violation[] {
  const parsed = parseFragment(content);
  if (typeof parsed === "string") return [{ path, message: parsed }];
  const selected = parsed.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => entries === "all" || entries.has(index));

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
    "--diff-merges=first-parent",
    "--reverse",
    "--find-renames",
    "--name-status",
    "--format=commit %H %P",
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
    if (entries !== "all") {
      const count = extractEntries(content).length;
      const missing = [...entries].filter((index) => index >= count);
      if (missing.length > 0) {
        throw new Error(
          `${path}: could not find the introduced entries ${
            missing.map((index) => index + 1).join(", ")
          } at ${options.head}.`,
        );
      }
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
