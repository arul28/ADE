import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAdeCliHelpDigestCacheForTests,
  buildCursorSdkSystemPrompt,
  isCursorSdkPromptInjectEnabled,
  loadAdeCliHelpDigest,
  readProjectRulesText,
} from "./cursorSdkSystemPrompt";

describe("isCursorSdkPromptInjectEnabled", () => {
  it("defaults to enabled when env is unset", () => {
    expect(isCursorSdkPromptInjectEnabled(undefined)).toBe(true);
  });
  it("treats common truthy values as enabled", () => {
    for (const v of ["1", "true", "yes", "on", "  1 ", ""]) {
      expect(isCursorSdkPromptInjectEnabled(v)).toBe(true);
    }
  });
  it("treats other values as disabled (kill switch)", () => {
    for (const v of ["0", "false", "off", "no", "disabled"]) {
      expect(isCursorSdkPromptInjectEnabled(v)).toBe(false);
    }
  });
});

describe("buildCursorSdkSystemPrompt", () => {
  it("returns empty when injection is disabled via env", () => {
    const out = buildCursorSdkSystemPrompt({
      runtime: "local",
      envInjectFlag: "0",
      cliHelpDigest: "ade --help",
    });
    expect(out.text).toBe("");
    expect(out.bytes).toBe(0);
    expect(out.sections).toEqual([]);
  });

  it("includes runtime label in cloud capability section", () => {
    const local = buildCursorSdkSystemPrompt({ runtime: "local" });
    expect(local.text).toContain("runtime: local");
    const cloud = buildCursorSdkSystemPrompt({ runtime: "cloud" });
    expect(cloud.text).toContain("runtime: cloud");
  });

  it("always emits control-protocol primer with all three block names", () => {
    const out = buildCursorSdkSystemPrompt({ runtime: "local" });
    expect(out.text).toContain("ade_update_plan");
    expect(out.text).toContain("ade_request_user_input");
    expect(out.text).toContain("ade_plan_approval");
  });

  it("always emits the shared session status protocol", () => {
    const out = buildCursorSdkSystemPrompt({ runtime: "local" });
    expect(out.text).toContain('ade chat note "running e2e shard 2/4"');
    expect(out.text).toContain('ade chat ask "<the exact question>"');
    expect(out.text).toContain("ade chat settle --outcome");
    expect(out.sections.find((section) => section.name === "session-status")).toEqual(
      expect.objectContaining({ truncated: false }),
    );
  });

  it("strips secret-looking lines from project rules", () => {
    const rules = [
      "Use these conventions:",
      "API_KEY=" + "a".repeat(64),
      "Run `npm test` before push.",
    ].join("\n");
    const out = buildCursorSdkSystemPrompt({
      runtime: "local",
      rulesText: rules,
    });
    expect(out.text).toContain("Run `npm test`");
    expect(out.text).not.toContain("API_KEY=");
    expect(out.text).not.toMatch(/a{40,}/);
  });

  it("truncates long sources from the end with [truncated] marker", () => {
    const huge = "X".repeat(20_000);
    const out = buildCursorSdkSystemPrompt({
      runtime: "local",
      cliHelpDigest: huge,
      rulesText: huge,
    });
    expect(out.bytes).toBeLessThanOrEqual(3 * 1024);
    expect(out.text).toContain("[truncated]");
    const cliSection = out.sections.find((s) => s.name === "cli");
    expect(cliSection?.truncated).toBe(true);
  });

  it("stays under the 3KB total budget even with maximally large inputs", () => {
    const out = buildCursorSdkSystemPrompt({
      runtime: "cloud",
      cliHelpDigest: "Q".repeat(50_000),
      rulesText: "R".repeat(50_000),
    });
    expect(out.bytes).toBeLessThanOrEqual(3 * 1024);
  });

  it("omits the rules section when nothing is provided", () => {
    const out = buildCursorSdkSystemPrompt({ runtime: "local" });
    expect(out.sections.find((s) => s.name === "rules")).toBeUndefined();
  });

  it("omits the cli section when no digest is provided", () => {
    const out = buildCursorSdkSystemPrompt({ runtime: "local" });
    expect(out.sections.find((s) => s.name === "cli")).toBeUndefined();
  });
});

describe("readProjectRulesText", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-cursor-rules-"));
  });
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("reads AGENTS.md and CLAUDE.md when present", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Use pnpm.\n", "utf8");
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "Default to TS.\n", "utf8");
    const text = await readProjectRulesText(dir);
    expect(text).toContain("Use pnpm.");
    expect(text).toContain("Default to TS.");
  });

  it("reads files inside .cursor/rules directory", async () => {
    await fs.mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".cursor", "rules", "style.mdc"),
      "Indent: 2 spaces.\n",
      "utf8",
    );
    const text = await readProjectRulesText(dir);
    expect(text).toContain("Indent: 2 spaces.");
    expect(text).toContain("style.mdc");
  });

  it("returns empty string when laneWorktreePath is missing", async () => {
    expect(await readProjectRulesText(undefined)).toBe("");
  });
});

describe("loadAdeCliHelpDigest", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-cli-digest-"));
    __resetAdeCliHelpDigestCacheForTests();
  });
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("returns empty string when file is missing", async () => {
    expect(await loadAdeCliHelpDigest(dir)).toBe("");
  });

  it("reads the file contents when present", async () => {
    await fs.writeFile(path.join(dir, "ade-cli-help.txt"), "hello world", "utf8");
    expect(await loadAdeCliHelpDigest(dir)).toBe("hello world");
  });
});
