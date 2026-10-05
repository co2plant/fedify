import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "@std/path";
import {
  checkChangelogPrRefs,
  checkFragment,
  findIntroducedFragments,
  parseNameStatusLog,
} from "./check_changelog_pr_refs.ts";

const PATH = "changes.d/cli/foo.md";

function fragment(
  links: Record<string, string> | null,
  references: string,
): string {
  const frontmatter = links == null ? "" : [
    "---",
    "links:",
    ...Object.entries(links).map(([key, url]) => `  '${key}': ${url}`),
    "---",
    "",
  ].join("\n");
  return `${frontmatter} -  Fixed a bug where foo would bar.  ${references}\n`;
}

const issue = "https://github.com/fedify-dev/fedify/issues/123";
const pull = (n: number) => `https://github.com/fedify-dev/fedify/pull/${n}`;

describe("checkFragment()", () => {
  it("accepts a fragment that references the current pull request", () => {
    const content = fragment(
      { "#123": issue, "#456": pull(456) },
      "[[#123], [#456] by John Doe]",
    );
    deepStrictEqual(checkFragment(PATH, content, 456), []);
  });

  it("accepts references wrapped across lines", () => {
    const content = [
      "---",
      "links:",
      `  '#123': ${issue}`,
      `  '#456': ${pull(456)}`,
      "---",
      " -  Fixed a bug where foo would bar, which needs a long description",
      "    to wrap.  [[#123],",
      "    [#456]]",
      "",
      "    A second paragraph without references.",
      "",
    ].join("\n");
    deepStrictEqual(checkFragment(PATH, content, 456), []);
  });

  it("reports a missing pull request reference", () => {
    const content = fragment({ "#123": issue }, "[[#123]]");
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 2);
    for (const violation of violations) strictEqual(violation.path, PATH);
    match(violations[0].message, /no entry for '#456'/);
    match(
      violations[0].message,
      /'#456': https:\/\/github\.com\/.*\/pull\/456/,
    );
    match(violations[1].message, /do not include the current pull request/);
    match(violations[1].message, /Add \[#456\]/);
  });

  it("reports an entry without trailing references", () => {
    const content = fragment({ "#456": pull(456) }, "");
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 1);
    match(violations[0].message, /no trailing references/);
  });

  it("reports a fragment without links metadata", () => {
    const content = fragment(null, "[[#123], [#456]]");
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 1);
    match(violations[0].message, /no entry for '#456'/);
  });

  it("reports a wrong predicted pull request number", () => {
    const content = fragment(
      { "#123": issue, "#455": pull(455) },
      "[[#123], [#455]]",
    );
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 2);
    for (const { message } of violations) {
      match(message, /links to #455 instead/);
      match(message, /replace it with #456/);
    }
  });

  it("reports a links URL that does not point to the pull request", () => {
    const content = fragment(
      {
        "#123": issue,
        "#456": "https://github.com/fedify-dev/fedify/issues/456",
      },
      "[[#123], [#456]]",
    );
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 1);
    match(violations[0].message, /maps '#456' to .*\/issues\/456/);
    match(violations[0].message, /Change it to .*\/pull\/456/);
  });

  it("checks every entry of a fragment", () => {
    const content = [
      "---",
      "links:",
      `  '#456': ${pull(456)}`,
      "---",
      " -  Added foo.  [[#456]]",
      "",
      " -  Added bar.  [[#123]]",
      "",
    ].join("\n");
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 1);
    match(violations[0].message, /entry 2/);
  });

  it("checks only the given entries", () => {
    const content = [
      "---",
      "links:",
      `  '#7': ${pull(7)}`,
      "---",
      " -  Added foo.  [[#7]]",
      "",
      " -  Added bar.  [[#123]]",
      "",
    ].join("\n");
    const violations = checkFragment(PATH, content, 456, new Set([1]));
    strictEqual(violations.length, 2);
    match(violations[0].message, /no entry for '#456'/);
    match(violations[1].message, /entry 2/);
  });

  it("accepts references followed directly by a nested list", () => {
    const content = [
      "---",
      "links:",
      `  '#456': ${pull(456)}`,
      "---",
      " -  Added options.  [[#123], [#456]]",
      "     -  `foo` option.",
      "     -  `bar` option.",
      "",
    ].join("\n");
    deepStrictEqual(checkFragment(PATH, content, 456), []);
  });

  it("hints only at pull requests the checked entries cite", () => {
    const content = [
      "---",
      "links:",
      `  '#7': ${pull(7)}`,
      "---",
      " -  Added foo.  [[#7]]",
      "",
      " -  Added bar.  [[#123]]",
      "",
    ].join("\n");
    const violations = checkFragment(PATH, content, 456, new Set([1]));
    strictEqual(violations.length, 2);
    for (const { message } of violations) {
      strictEqual(message.includes("links to #7"), false, message);
    }
  });

  it("reports malformed frontmatter", () => {
    const content = "---\nlinks: [\n---\n -  Added foo.  [[#456]]\n";
    const violations = checkFragment(PATH, content, 456);
    strictEqual(violations.length, 1);
    match(violations[0].message, /could not parse the frontmatter/);
  });
});

describe("parseNameStatusLog()", () => {
  it("groups fragment changes by commit", () => {
    const log = [
      "commit 1111111111111111111111111111111111111111",
      "",
      "A\tchanges.d/cli/added.md",
      "M\tchanges.d/cli/historical.md",
      "A\tchanges.d/next.txt",
      "commit 2222222222222222222222222222222222222222",
      "",
      "R095\tchanges.d/cli/added.md\tchanges.d/fedify/added.md",
      "R100\tchanges.d/cli/old.md\tdocs/old.md",
      "D\tchanges.d/cli/deleted.md",
      "commit 3333333333333333333333333333333333333333 " +
      "2222222222222222222222222222222222222222 " +
      "4444444444444444444444444444444444444444",
      "",
      "M\tchanges.d/cli/merged.md",
    ].join("\n");
    deepStrictEqual(parseNameStatusLog(log), [
      {
        commit: "1111111111111111111111111111111111111111",
        merge: false,
        changes: [
          {
            status: "A",
            path: "changes.d/cli/added.md",
            oldPath: "changes.d/cli/added.md",
          },
          {
            status: "M",
            path: "changes.d/cli/historical.md",
            oldPath: "changes.d/cli/historical.md",
          },
        ],
      },
      {
        commit: "2222222222222222222222222222222222222222",
        merge: false,
        changes: [
          {
            status: "R",
            path: "changes.d/fedify/added.md",
            oldPath: "changes.d/cli/added.md",
          },
          {
            status: "D",
            path: "changes.d/cli/old.md",
            oldPath: "changes.d/cli/old.md",
          },
          {
            status: "D",
            path: "changes.d/cli/deleted.md",
            oldPath: "changes.d/cli/deleted.md",
          },
        ],
      },
      {
        commit: "3333333333333333333333333333333333333333",
        merge: true,
        changes: [
          {
            status: "M",
            path: "changes.d/cli/merged.md",
            oldPath: "changes.d/cli/merged.md",
          },
        ],
      },
    ]);
  });
});

describe("findIntroducedFragments()", () => {
  it("tracks added fragments and entries added to existing ones", async () => {
    const files: Record<string, string> = {
      "c1^:changes.d/cli/historical.md": " -  Old entry.  [[#7]]\n",
      "c1:changes.d/cli/historical.md":
        " -  Old entry.  [[#7]]\n\n -  New entry.  [[#456]]\n",
      "c2^:changes.d/cli/moved.md": " -  Moved entry.  [[#8]]\n",
      "c2:changes.d/fedify/moved.md": " -  Moved entry.  [[#8]]\n",
    };
    const introduced = await findIntroducedFragments(
      [
        {
          commit: "c1",
          merge: false,
          changes: [
            {
              status: "A",
              path: "changes.d/cli/added.md",
              oldPath: "changes.d/cli/added.md",
            },
            {
              status: "M",
              path: "changes.d/cli/historical.md",
              oldPath: "changes.d/cli/historical.md",
            },
            {
              status: "A",
              path: "changes.d/cli/deleted.md",
              oldPath: "changes.d/cli/deleted.md",
            },
          ],
        },
        {
          commit: "c2",
          merge: false,
          changes: [
            {
              status: "R",
              path: "changes.d/fedify/moved.md",
              oldPath: "changes.d/cli/moved.md",
            },
            {
              status: "D",
              path: "changes.d/cli/deleted.md",
              oldPath: "changes.d/cli/deleted.md",
            },
          ],
        },
      ],
      (revision, path) => Promise.resolve(files[`${revision}:${path}`]),
    );
    deepStrictEqual(introduced, [
      { path: "changes.d/cli/added.md", entries: "all" },
      { path: "changes.d/cli/historical.md", entries: new Set([1]) },
    ]);
  });
});

describe("checkChangelogPrRefs()", () => {
  const valid = fragment(
    { "#123": issue, "#456": pull(456) },
    "[[#123], [#456]]",
  );
  const historical = [
    "---",
    "links:",
    `  '#7': ${pull(7)}`,
    "---",
    " -  Fixed a bug where foo would bar, which was fixed",
    "    long ago.  [[#7]]",
    "",
  ].join("\n");
  const historicalPath = "changes.d/cli/historical.md";

  /** Append a new top-level entry to the historical fragment. */
  const withNewEntry = (links: string, references: string) =>
    historical.replace("---\n -", `${links}---\n -`) +
    `\n -  Added baz.  ${references}\n`;

  async function git(root: string, ...args: string[]): Promise<string> {
    const { code, stdout, stderr } = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    if (code !== 0) throw new Error(decoder.decode(stderr));
    return decoder.decode(stdout).trim();
  }

  async function commit(
    root: string,
    files: Record<string, string | null>,
  ): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      if (content == null) {
        await git(root, "rm", "--quiet", path);
      } else {
        await Deno.mkdir(join(root, dirname(path)), { recursive: true });
        await Deno.writeTextFile(join(root, path), content);
        await git(root, "add", path);
      }
    }
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "commit");
  }

  /**
   * Set up a repository whose `main` branch contains a historical fragment
   * and `files`, check out a `pr` branch from it, and run `scenario` on that
   * branch.
   */
  async function withRepository(
    scenario: (root: string) => Promise<void>,
    files: Record<string, string> = {},
  ): Promise<Awaited<ReturnType<typeof checkChangelogPrRefs>>> {
    const root = await Deno.makeTempDir();
    try {
      await git(root, "init", "--quiet", "--initial-branch=main");
      await commit(root, {
        "changes.d/next.txt": "1.0.0\n",
        [historicalPath]: historical,
        ...files,
      });
      await git(root, "switch", "--quiet", "-c", "pr");
      await scenario(root);
      return await checkChangelogPrRefs(root, {
        pullRequest: 456,
        base: "main",
        head: "pr",
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }

  it("passes a pull request without changelog fragments", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, { "src/foo.ts": "export {};\n" });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("checks fragments added by the pull request", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        "changes.d/cli/valid.md": valid,
        "changes.d/fedify/invalid.md": fragment({ "#123": issue }, "[[#123]]"),
      });
    });
    deepStrictEqual(result.fragments, [
      "changes.d/cli/valid.md",
      "changes.d/fedify/invalid.md",
    ]);
    deepStrictEqual(
      [...new Set(result.violations.map((v) => v.path))],
      ["changes.d/fedify/invalid.md"],
    );
  });

  it("checks later edits to fragments added by the pull request", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, { "changes.d/cli/foo.md": valid });
      await commit(root, {
        "changes.d/cli/foo.md": fragment({ "#123": issue }, "[[#123]]"),
      });
    });
    deepStrictEqual(result.fragments, ["changes.d/cli/foo.md"]);
    strictEqual(result.violations.length, 2);
  });

  it("follows renames of fragments added by the pull request", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, { "changes.d/cli/foo.md": valid });
      await git(root, "mv", "changes.d/cli/foo.md", "changes.d/cli/bar.md");
      await commit(root, {});
    });
    deepStrictEqual(result, {
      fragments: ["changes.d/cli/bar.md"],
      violations: [],
    });
  });

  it("checks entries added to historical fragments", async () => {
    const invalid = await withRepository(async (root) => {
      await commit(root, { [historicalPath]: withNewEntry("", "[[#123]]") });
    });
    deepStrictEqual(invalid.fragments, [historicalPath]);
    strictEqual(invalid.violations.length, 2);
    match(invalid.violations[0].message, /no entry for '#456'/);
    match(invalid.violations[1].message, /entry 2 \(\[#123\]\)/);

    const valid = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: withNewEntry(
          `  '#456': ${pull(456)}\n`,
          "[[#123], [#456]]",
        ),
      });
    });
    deepStrictEqual(valid, { fragments: [historicalPath], violations: [] });
  });

  it("checks later edits to entries added to historical fragments", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, { [historicalPath]: withNewEntry("", "[[#123]]") });
      await commit(root, {
        [historicalPath]: withNewEntry(
          `  '#456': ${pull(456)}\n`,
          "[[#123], [#456]]",
        ),
      });
    });
    deepStrictEqual(result, { fragments: [historicalPath], violations: [] });
  });

  it("excludes historical entries edited or renamed", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace("long ago", "a while ago"),
      });
      await Deno.mkdir(join(root, "changes.d", "fedify"));
      await git(
        root,
        "mv",
        historicalPath,
        "changes.d/fedify/historical.md",
      );
      await commit(root, {});
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("excludes historical entries whose first line is edited", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace("foo would bar", "foo would baz"),
      });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("tells inserted entries from adjacent edited ones", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace(
          "---\n -  Fixed a bug where foo would bar",
          "---\n -  Added baz.  [[#123]]\n\n -  Fixed a bug where foo would baz",
        ),
      });
    });
    deepStrictEqual(result.fragments, [historicalPath]);
    strictEqual(result.violations.length, 2);
    match(result.violations[0].message, /no entry for '#456'/);
    match(result.violations[1].message, /entry 1 \(\[#123\]\)/);
  });

  it("excludes historical entries reworded", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace(
          "foo would bar, which was fixed\n    long ago.",
          "`foo()` returned `bar` instead of `baz`, fixed long ago.",
        ),
      });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("checks new entries replacing historical ones", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace(
          /---\n -[^]*$/,
          "---\n -  Fixed a crash in the inbox handler.  [[#9]]\n",
        ),
      });
    });
    deepStrictEqual(result.fragments, [historicalPath]);
    strictEqual(result.violations.length, 2);
    match(result.violations[0].message, /no entry for '#456'/);
    match(result.violations[1].message, /entry \(\[#9\]\)/);

    const path = "changes.d/fedify/method.md";
    const similar = await withRepository(async (root) => {
      await commit(root, {
        [path]: " -  Added `Context.bar()` method.  [[#123]]\n",
      });
    }, { [path]: " -  Added `Federation.foo()` method.  [[#7]]\n" });
    deepStrictEqual(similar.fragments, [path]);
    strictEqual(similar.violations.length, 2);
    match(similar.violations[1].message, /entry \(\[#123\]\)/);
  });

  it("excludes historical entries with corrected references", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical
          .replace("foo would bar", "foo would baz")
          .replace("[[#7]]", "[[#8]]"),
      });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("checks new entries sharing the first paragraph of a historical entry", async () => {
    const path = "changes.d/fedify/apis.md";
    const entry = (references: string, api: string) =>
      ` -  Added new APIs.  ${references}\n\n     -  \`${api}()\`\n`;
    const result = await withRepository(async (root) => {
      await commit(root, {
        [path]: `${entry("[[#123]]", "bar")}\n${entry("[[#7]]", "foo")}`,
      });
    }, { [path]: entry("[[#7]]", "foo") });
    deepStrictEqual(result.fragments, [path]);
    strictEqual(result.violations.length, 2);
    match(result.violations[1].message, /entry 1 \(\[#123\]\)/);
  });

  it("excludes historical entries moved within a fragment", async () => {
    const path = "changes.d/cli/two.md";
    const result = await withRepository(async (root) => {
      await commit(root, {
        [path]: " -  Added bar.  [[#2]]\n\n -  Added foo.  [[#1]]\n",
      });
    }, { [path]: " -  Added foo.  [[#1]]\n\n -  Added bar.  [[#2]]\n" });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("counts entries in fragments with a lone carriage return", async () => {
    const path = "changes.d/cli/cr.md";
    const result = await withRepository(async (root) => {
      await commit(root, {
        [path]: " -  Fixed foo\rbar.  [[#7]]\n\n -  Added baz.  [[#123]]\n",
      });
    }, { [path]: " -  Fixed foo\rbar.  [[#7]]\n" });
    deepStrictEqual(result.fragments, [path]);
    strictEqual(result.violations.length, 2);
    match(result.violations[1].message, /entry 2 \(\[#123\]\)/);
  });

  it("checks new entries sharing the first line of a historical entry", async () => {
    const twin = " -  Fixed a bug where foo would bar, which was fixed\n" +
      "    just now.  [[#123]]\n";
    const appended = await withRepository(async (root) => {
      await commit(root, { [historicalPath]: `${historical}\n${twin}` });
    });
    deepStrictEqual(appended.fragments, [historicalPath]);
    strictEqual(appended.violations.length, 2);
    match(appended.violations[0].message, /no entry for '#456'/);
    match(appended.violations[1].message, /entry 2 \(\[#123\]\)/);

    const prepended = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: historical.replace("---\n -", `---\n${twin}\n -`),
      });
    });
    deepStrictEqual(prepended.fragments, [historicalPath]);
    strictEqual(prepended.violations.length, 2);
    match(prepended.violations[0].message, /no entry for '#456'/);
    match(prepended.violations[1].message, /entry 1 \(\[#123\]\)/);
  });

  it("excludes nested items added to historical entries", async () => {
    const result = await withRepository(async (root) => {
      await commit(root, {
        [historicalPath]: `${historical}\n     -  Also fixed baz.  [[#123]]\n`,
      });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });

  it("excludes entries carried forward through a merge", async () => {
    const result = await withRepository(async (root) => {
      await git(root, "switch", "--quiet", "-c", "maintenance", "main");
      await commit(root, {
        "changes.d/cli/backport.md": historical,
        [historicalPath]: withNewEntry("", "[[#8]]"),
      });
      await git(root, "switch", "--quiet", "pr");
      await git(
        root,
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "merge",
        "maintenance",
      );
      await commit(root, { "changes.d/cli/foo.md": valid });
    });
    deepStrictEqual(result, {
      fragments: ["changes.d/cli/foo.md"],
      violations: [],
    });
  });

  it("follows introduced entries moved by a merge", async () => {
    const result = await withRepository(async (root) => {
      await git(root, "switch", "--quiet", "-c", "maintenance", "main");
      await commit(root, {
        [historicalPath]: historical.replace(
          "---\n -",
          "---\n -  Added qux.  [[#8]]\n\n -",
        ),
      });
      await git(root, "switch", "--quiet", "pr");
      await commit(root, {
        [historicalPath]: `${historical}\n -  Added baz.  [[#123], [#456]]\n`,
      });
      await git(
        root,
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        "merge",
        "maintenance",
      );
      const merged = await Deno.readTextFile(join(root, historicalPath));
      await commit(root, {
        [historicalPath]: merged.replace(
          "\n---\n",
          `\n  '#456': ${pull(456)}\n---\n`,
        ),
      });
    });
    deepStrictEqual(result, { fragments: [historicalPath], violations: [] });
  });

  it("excludes entries merged into fragments added by the pull request", async () => {
    const path = "changes.d/cli/foo.md";
    const result = await withRepository(async (root) => {
      await git(root, "switch", "--quiet", "-c", "maintenance", "main");
      await commit(root, { [path]: " -  Added qux.  [[#8]]\n" });
      await git(root, "switch", "--quiet", "pr");
      await commit(root, { [path]: valid });
      await git(
        root,
        "merge",
        "--quiet",
        "--no-ff",
        "--no-commit",
        "--strategy=ours",
        "maintenance",
      );
      await commit(root, { [path]: `${valid}\n -  Added qux.  [[#8]]\n` });
    });
    deepStrictEqual(result, { fragments: [path], violations: [] });
  });

  it("ignores fragments deleted by a merge", async () => {
    const result = await withRepository(async (root) => {
      await git(root, "switch", "--quiet", "-c", "maintenance", "main");
      await commit(root, { [historicalPath]: null });
      await git(root, "switch", "--quiet", "pr");
      await commit(root, { [historicalPath]: withNewEntry("", "[[#123]]") });
      await git(
        root,
        "merge",
        "--quiet",
        "--no-ff",
        "--no-commit",
        "--strategy=ours",
        "maintenance",
      );
      await commit(root, { [historicalPath]: null });
    });
    deepStrictEqual(result, { fragments: [], violations: [] });
  });
});
