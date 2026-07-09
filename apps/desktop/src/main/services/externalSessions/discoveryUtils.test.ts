import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanExternalSessionUserText,
  cleanSessionTitle,
  countExternalSessionUserMessages,
  firstUserTextFromRecords,
  resolveCursorCwdFromSlug,
  slashEscapedCwd,
} from "./discoveryUtils";

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
    expect(slashEscapedCwd("C:\\Users\\dev\\ADE")).toBe("C:-Users-dev-ADE");
  });
});

describe("resolveCursorCwdFromSlug", () => {
  it("uses the filesystem to recover hyphenated and dotted path segments", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-slug-"));
    const cwd = path.join(root, "Projects", "my-cool.app", ".ade", "worktrees", "lane-with-hyphen");
    fs.mkdirSync(cwd, { recursive: true });
    try {
      const slug = cwd.replace(/^\/+/u, "").replace(/[/.]/gu, "-");
      expect(resolveCursorCwdFromSlug(slug)).toBe(fs.realpathSync(cwd));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
