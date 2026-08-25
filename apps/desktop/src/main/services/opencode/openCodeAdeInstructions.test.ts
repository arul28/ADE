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

describe("openCodeAdeInstructions", () => {
  let projectRoot: string;
  let lane: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-instr-"));
    lane = path.join(projectRoot, ".ade", "worktrees", "lane-1");
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("gives chat and the tracked CLI the same ADE base prompt", () => {
    // The contract is "one slim ADE base prompt", not "byte-identical
    // transport": chat sends it through the SDK's `system` field while the CLI
    // gets it as an instruction file. What must not drift is the instruction
    // text itself, so the CLI file has to contain exactly what the chat runtime
    // builds for the same lane and permission mode.
    const chatPrompt = buildCodingAgentSystemPrompt({
      cwd: lane,
      mode: "coding",
      permissionMode: "edit",
      interactive: true,
      runtime: "opencode",
    });

    expect(buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "edit" }))
      .toContain(chatPrompt);
  });

  it("tracks the permission mode the CLI actually launched with", () => {
    const plan = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "plan" });
    const fullAuto = buildOpenCodeAdeInstructions({ laneWorktreePath: lane, permissionMode: "full-auto" });

    expect(plan).toContain("Plan mode. Stay read-only");
    expect(fullAuto).toContain("Autonomous mode.");
    expect(plan).not.toContain("Autonomous mode.");
  });

  it("writes into ADE's own cache, never the lane worktree or a shared temp dir", () => {
    const written = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "edit" });

    expect(written).not.toBeNull();
    expect(written?.startsWith(lane)).toBe(false);
    expect(written?.startsWith(path.join(projectRoot, ".ade", "cache"))).toBe(true);
    expect(fs.readFileSync(written!, "utf8")).toContain("ADE's software engineering agent");
    // A predictable path in a world-writable directory is a symlink target.
    expect(written?.startsWith(os.tmpdir() + path.sep + "ade-opencode")).toBe(false);
  });

  it("reuses one stable path per lane and rewrites it on relaunch", () => {
    const first = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "plan" });
    const second = ensureOpenCodeAdeInstructionsFile({ projectRoot, laneWorktreePath: lane, permissionMode: "full-auto" });

    // A resume must not resurrect the previous launch's permission mode.
    expect(second).toBe(first);
    expect(fs.readFileSync(second!, "utf8")).toContain("Autonomous mode.");

    expect(openCodeAdeInstructionsPath({ projectRoot, laneWorktreePath: `${lane}-2` })).not.toBe(first);
  });

  it("produces a filename OpenCode's basename glob cannot misread", () => {
    // OpenCode resolves an absolute `instructions` entry by globbing the
    // basename inside its parent directory, so a glob metacharacter in the name
    // would match the wrong file or none.
    const name = path.basename(openCodeAdeInstructionsPath({
      projectRoot,
      laneWorktreePath: "/repo/lane with spaces/*/weird?",
    }));
    expect(name).toMatch(/^ade-[0-9a-f]{16}\.md$/);
  });

  it("returns null instead of failing the launch when there is no lane", () => {
    expect(ensureOpenCodeAdeInstructionsFile({
      projectRoot,
      laneWorktreePath: "  ",
      permissionMode: "edit",
    })).toBeNull();
  });
});
