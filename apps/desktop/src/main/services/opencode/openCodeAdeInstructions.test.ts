import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import {
  buildOpenCodeAdeInstructions,
  ensureOpenCodeAdeInstructionsFile,
  openCodeAdeInstructionsPath,
} from "./openCodeAdeInstructions";

const LANE = "/repo/.ade/worktrees/lane-1";

describe("openCodeAdeInstructions", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-instr-"));
    process.env.ADE_OPENCODE_INSTRUCTIONS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.ADE_OPENCODE_INSTRUCTIONS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives chat and the tracked CLI the same ADE base prompt", () => {
    // The contract is "one slim ADE base prompt", not "byte-identical
    // transport": chat sends it through the SDK's `system` field while the CLI
    // gets it as an instruction file. What must not drift is the instruction
    // text itself, so the CLI file has to contain exactly what the chat runtime
    // builds for the same lane and permission mode.
    const chatPrompt = buildCodingAgentSystemPrompt({
      cwd: LANE,
      mode: "coding",
      permissionMode: "edit",
      interactive: true,
      runtime: "opencode",
    });

    expect(buildOpenCodeAdeInstructions({ laneWorktreePath: LANE, permissionMode: "edit" }))
      .toContain(chatPrompt);
  });

  it("tracks the permission mode the CLI actually launched with", () => {
    const plan = buildOpenCodeAdeInstructions({ laneWorktreePath: LANE, permissionMode: "plan" });
    const fullAuto = buildOpenCodeAdeInstructions({ laneWorktreePath: LANE, permissionMode: "full-auto" });

    expect(plan).toContain("Plan mode. Stay read-only");
    expect(fullAuto).toContain("Autonomous mode.");
    expect(plan).not.toContain("Autonomous mode.");
  });

  it("writes outside the lane worktree so the file never shows up in git", () => {
    const written = ensureOpenCodeAdeInstructionsFile({ laneWorktreePath: LANE, permissionMode: "edit" });

    expect(written).not.toBeNull();
    expect(written?.startsWith(LANE)).toBe(false);
    expect(fs.readFileSync(written!, "utf8")).toContain("ADE's software engineering agent");
  });

  it("reuses one stable path per lane and rewrites it on relaunch", () => {
    const first = ensureOpenCodeAdeInstructionsFile({ laneWorktreePath: LANE, permissionMode: "plan" });
    const second = ensureOpenCodeAdeInstructionsFile({ laneWorktreePath: LANE, permissionMode: "full-auto" });

    // A resume must not resurrect the previous launch's permission mode.
    expect(second).toBe(first);
    expect(fs.readFileSync(second!, "utf8")).toContain("Autonomous mode.");

    expect(openCodeAdeInstructionsPath("/repo/.ade/worktrees/lane-2")).not.toBe(first);
  });

  it("produces a filename OpenCode's basename glob cannot misread", () => {
    // OpenCode resolves an absolute `instructions` entry by globbing the
    // basename inside its parent directory, so a glob metacharacter in the name
    // would match the wrong file or none.
    const name = path.basename(openCodeAdeInstructionsPath("/repo/lane with spaces/*/weird?"));
    expect(name).toMatch(/^ade-[0-9a-f]{16}\.md$/);
  });

  it("returns null instead of failing the launch when there is no lane", () => {
    expect(ensureOpenCodeAdeInstructionsFile({ laneWorktreePath: "  ", permissionMode: "edit" })).toBeNull();
  });
});
