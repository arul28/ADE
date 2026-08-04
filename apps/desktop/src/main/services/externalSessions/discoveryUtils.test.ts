import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanExternalSessionUserText,
  cleanSessionTitle,
  clipExternalSessionText,
  canonicalCodexRecords,
  countExternalSessionUserMessages,
  firstUserTextFromRecords,
  cwdIsInScope,
  normalizeProviderCwd,
  pathContains,
  recentExternalSessionMessagesFromRecords,
  resolveCursorCwdFromSlug,
} from "./discoveryUtils";

describe("normalizeProviderCwd", () => {
  it("keeps a missing cwd missing", () => {
    // "no cwd recorded" is not the same as "cwd is empty": an unscoped listing
    // still shows the former.
    expect(normalizeProviderCwd(null)).toBeNull();
    expect(normalizeProviderCwd("")).toBeNull();
  });

  it("leaves a plain path untouched on every platform", () => {
    const plain = process.platform === "win32" ? "C:\\Users\\arul\\ADE" : "/Users/arul/ADE";
    expect(normalizeProviderCwd(plain)).toBe(plain);
  });

  // The `\\?\` transform itself is platform-injectable and covered exhaustively
  // in shared/pathCompare.test.ts; these two pin the wiring, which is not.
  it.runIf(process.platform === "win32")("strips the extended-length prefix Codex records", () => {
    expect(normalizeProviderCwd("\\\\?\\C:\\Users\\arul\\ADE")).toBe("C:\\Users\\arul\\ADE");
  });

  it.runIf(process.platform !== "win32")("never rewrites a posix path containing backslashes", () => {
    expect(normalizeProviderCwd("\\\\?\\weird")).toBe("\\\\?\\weird");
  });
});

describe("scope containment", () => {
  const root = process.platform === "win32" ? "C:\\Users\\arul\\ADE" : "/Users/arul/ADE";
  const child = path.join(root, "apps", "desktop");

  it("accepts a descendant and rejects a name-prefix sibling", () => {
    expect(pathContains(root, child)).toBe(true);
    expect(pathContains(root, `${root}-old`)).toBe(false);
  });

  it("reads parent-first, the opposite of pathCompare's isPathInside", () => {
    // The two helpers used to share a name with swapped arguments, so a wrong
    // import compiled cleanly and inverted the answer. Pin the order here.
    expect(pathContains(root, child)).toBe(true);
    expect(pathContains(child, root)).toBe(false);
  });

  it.runIf(process.platform === "win32")("accepts a cwd whose casing differs from the scope root", () => {
    // PowerShell preserves whatever the user typed after `cd`, and
    // fs.realpathSync does not canonicalize case on Windows, so the two
    // spellings reach this check verbatim.
    expect(cwdIsInScope("c:\\users\\arul\\ade\\apps", [root])).toBe(true);
  });

  it.runIf(process.platform === "win32")("accepts an extended-length cwd against a plain scope root", () => {
    // Bug 1 end to end: `path.relative` reads `\\?\C:\` as a UNC root, so before
    // the strip every Codex session tested as out of scope.
    expect(cwdIsInScope(`\\\\?\\${child}`, [root])).toBe(true);
  });
});

describe("firstUserTextFromRecords", () => {
  it("skips message records with explicit assistant role", () => {
    const text = firstUserTextFromRecords([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Assistant summary should not win." }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Use this request as the title." }],
        },
      },
    ]);

    expect(text).toBe("Use this request as the title.");
  });

  it("skips Claude metadata and extracts provider prompt wrappers", () => {
    const text = firstUserTextFromRecords([
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>generated caveat</local-command-caveat>" },
      },
      {
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name><command-args>opus</command-args>" },
      },
      {
        type: "user",
        message: { role: "user", content: "<local-command-stdout>model changed</local-command-stdout>" },
      },
      { type: "user", message: { role: "user", content: "Actual request" } },
    ]);

    expect(text).toBe("Actual request");
    expect(cleanExternalSessionUserText("<user_query>Fix Cursor import</user_query>"))
      .toBe("Fix Cursor import");
    expect(cleanExternalSessionUserText("ADE session guidance.\n\nUser prompt: Fix Codex import"))
      .toBe("Fix Codex import");
  });
});

describe("external session user text", () => {
  it("counts semantic prompts and de-duplicates Codex storage representations", () => {
    const codexRows = [
      { type: "response_item", payload: { type: "message", role: "user", content: "synthetic copy" } },
      { type: "event_msg", payload: { type: "user_message", message: "real prompt" } },
      { type: "event_msg", payload: { type: "agent_message", message: "assistant" } },
    ];
    expect(countExternalSessionUserMessages(codexRows, "codex")).toBe(1);
    expect(countExternalSessionUserMessages([
      { type: "user", isMeta: true, message: { role: "user", content: "metadata" } },
      { type: "user", message: { role: "user", content: "prompt one" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] } },
      { type: "assistant", message: { role: "assistant", content: "reply" } },
      { type: "user", message: { role: "user", content: "prompt two" } },
    ], "claude")).toBe(2);
    expect(countExternalSessionUserMessages([
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] } },
    ], "claude")).toBe(0);
  });

  it("preserves legitimate syntax while sanitizing generated titles and cwd keys", () => {
    expect(cleanExternalSessionUserText(
      "Create <Button variant=\"primary\" /> and explain the literal label User request: in the docs.",
    )).toBe("Create <Button variant=\"primary\" /> and explain the literal label User request: in the docs.");
    expect(cleanSessionTitle("\u001b[31mFix import\u001b[0m")).toBe("Fix import");
    expect(cleanSessionTitle("New Agent")).toBeNull();
  });

  it("strips known transport wrappers, including truncated ones", () => {
    expect(cleanExternalSessionUserText(
      "<task-notification><task-id>bcyw3zwwj</task-id><tool-use-id>toolu_123</tool-use-id><output-file>/tmp/result</output-file><status>completed</status></task-notification>",
    )).toBeNull();
    expect(cleanExternalSessionUserText(
      "<task-notification><task-id>bcyw3zwwj</task-id><output-file>/tmp/truncated",
    )).toBeNull();
    expect(cleanExternalSessionUserText(
      "</task-notification> Keep this human-authored request",
    )).toBe("Keep this human-authored request");
  });

  /**
   * The markup-density gate exists to keep junk out of row *previews*. It must
   * not run on `cleanExternalSessionUserText`, which also builds the imported
   * chat transcript — rejecting there silently deletes real messages from
   * someone's history.
   */
  /**
   * Regression: the count/preview reader and the messages reader each derived
   * "is this a user turn" inline and had already drifted — a record with
   * `type: "message"` and no explicit role counted toward `messageCount` and
   * could become the preview, but was silently dropped from `messages`. They now
   * share one classifier, so a record either appears in all three or none.
   */
  /**
   * Codex writes each turn twice — a canonical `event_msg` and a mirrored
   * `response_item`. Sampling the raw rows showed every turn twice and evicted
   * genuinely older exchanges from the capped window.
   */
  it("drops Codex mirror rows so a turn is sampled once", () => {
    const rows = [
      { type: "event_msg", payload: { type: "user_message", message: "first ask" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "first ask" } },
      { type: "event_msg", payload: { type: "agent_message", message: "the answer" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "the answer" } },
    ];
    const messages = recentExternalSessionMessagesFromRecords(canonicalCodexRecords(rows));
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("leaves records untouched when there is no canonical form to prefer", () => {
    const rows = [{ type: "response_item", payload: { type: "message", role: "user", content: "only form" } }];
    expect(canonicalCodexRecords(rows)).toHaveLength(1);
  });

  it("agrees across count, preview, and messages about what a user turn is", () => {
    const records = [
      { type: "message", message: { content: "roleless message rows are user turns" } },
    ];
    expect(countExternalSessionUserMessages(records, "claude")).toBe(1);
    expect(firstUserTextFromRecords(records)).toBe("roleless message rows are user turns");
    const messages = recentExternalSessionMessagesFromRecords(records);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.text).toBe("roleless message rows are user turns");
  });

  it("keeps markup-heavy and very short user turns intact for the import path", () => {
    const jsx = "Fix this: <div className=\"card\"><span>{title}</span></div>";
    expect(cleanExternalSessionUserText(jsx)).toBe(jsx);
    expect(cleanExternalSessionUserText("ok")).toBe("ok");
    expect(cleanExternalSessionUserText("\u597d\u7684")).toBe("\u597d\u7684");
    expect(cleanExternalSessionUserText("<unknown><receipt>completed</receipt></unknown>"))
      .toBe("<unknown><receipt>completed</receipt></unknown>");
  });

  it("still keeps markup-dominant text out of previews", () => {
    expect(firstUserTextFromRecords([
      { type: "user", message: { role: "user", content: "<unknown><receipt>completed</receipt></unknown>" } },
      { type: "user", message: { role: "user", content: "Actually fix the truncation bug" } },
    ])).toBe("Actually fix the truncation bug");
  });

  it("clips on word boundaries without leaving a partial markup tag", () => {
    expect(clipExternalSessionText("alpha beta gamma delta epsilon", 22))
      .toBe("alpha beta gamma...");
    const clippedTag = clipExternalSessionText(
      "ReadablePrefixWithoutSpaces <component attribute=\"unfinished",
      42,
    );
    expect(clippedTag).toBe("ReadablePrefixWithoutSpaces...");
    expect(clippedTag).not.toContain("<");
    const title = cleanSessionTitle(`${"word ".repeat(40)}tail`);
    expect(title?.length).toBeLessThanOrEqual(160);
    expect(title?.endsWith("word…")).toBe(true);
  });

  it("returns the newest eight messages in chronological order and ignores tool parts", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      type: "message",
      timestamp: `2026-07-06T10:00:${String(index).padStart(2, "0")}.000Z`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: index % 2 === 0
          ? `message ${index}`
          : [
              { type: "text", text: `message ${index}` },
              { type: "tool_use", name: "Read", input: { path: "/private/file" } },
            ],
      },
    }));

    const messages = recentExternalSessionMessagesFromRecords(rows, 99);

    expect(messages).toHaveLength(8);
    expect(messages.map((message) => message.text)).toEqual(
      Array.from({ length: 8 }, (_, index) => `message ${index + 2}`),
    );
    expect(messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(messages[0]?.at).toBe(Date.parse("2026-07-06T10:00:02.000Z"));
    expect(JSON.stringify(messages)).not.toContain("/private/file");
  });
});

describe("resolveCursorCwdFromSlug", () => {
  it("uses the filesystem to recover hyphenated and dotted path segments", () => {
    // `.native` matters on Windows: GitHub's runners report `os.tmpdir()` as
    // `C:\Users\RUNNER~1\...`, an 8.3 short name. The slug is built from the
    // path, so `~` becomes `-` and the resolver is asked to recover `RUNNER-1`
    // by reading `C:\Users` -- which lists the long name (`runneradmin`) and
    // never the alias, so it correctly returns null and the test failed on CI
    // while passing on any machine with a long TEMP path. Only `.native`
    // expands 8.3 aliases; plain `realpathSync` preserves them.
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ade-cursor-slug-"));
    const cwd = path.join(root, "Projects", "my-cool.app", ".ade", "worktrees", "lane-with-hyphen");
    fs.mkdirSync(cwd, { recursive: true });
    try {
      // Cursor's rule, verbatim from @cursor/sdk 1.0.23: every non-alphanumeric
      // character becomes `-`, runs collapse, ends are trimmed. The previous
      // fixture only replaced `/` and `.`, so on Windows it built a slug
      // containing `C:\…` — a string Cursor could never write, which made this
      // assert an inversion of the wrong input. Same rule as
      // `cursorProjectSlug()` in apps/desktop/src/shared/cursorProjectSlug.ts.
      const slug = cwd.replace(/[^a-zA-Z0-9]/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
      expect(resolveCursorCwdFromSlug(slug)).toBe(fs.realpathSync(cwd));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
