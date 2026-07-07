import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { firstUserTextFromRecords, resolveCursorCwdFromSlug } from "./discoveryUtils";

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
