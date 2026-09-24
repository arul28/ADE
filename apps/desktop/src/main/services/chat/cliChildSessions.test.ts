import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliChildLineageFromRow,
  cliChildResultStatus,
  cliChildRunKey,
  composeCliChildReport,
  createCliChildSessionReader,
  extractClaudeFinalMessage,
  extractCodexFinalMessage,
  lastMeaningfulTerminalLines,
  readCliProviderFinalMessage,
  type CliChildRow,
} from "./cliChildSessions";
import { TRACKED_AGENT_CLI_TOOL_TYPES } from "../../../shared/cliChildSession";
import { isTrackedAgentCliToolType } from "../../../shared/types/sessions";

function cliRow(overrides: Partial<CliChildRow> = {}): CliChildRow {
  return {
    id: "cli-1",
    toolType: "codex",
    resumeMetadata: {
      provider: "codex",
      targetKind: "thread",
      targetId: null,
      launch: { model: "gpt-5.6-sol" },
      orchestrationParentSessionId: "parent-1",
      spawnKind: "subagent",
    },
    ...overrides,
  };
}

describe("cliChildLineageFromRow", () => {
  it("reads the parent, type, provider, and model a parented CLI was launched with", () => {
    expect(cliChildLineageFromRow(cliRow())).toEqual({
      parentSessionId: "parent-1",
      spawnKind: "subagent",
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("names the provider for tool types that differ from it", () => {
    expect(cliChildLineageFromRow(cliRow({
      toolType: "cursor-cli",
      resumeMetadata: { ...cliRow().resumeMetadata!, provider: undefined as never },
    }))?.provider).toBe("cursor");
  });

  it("returns null for anything that is not a parented agent CLI", () => {
    expect(cliChildLineageFromRow(null)).toBeNull();
    expect(cliChildLineageFromRow(cliRow({ toolType: "shell" }))).toBeNull();
    expect(cliChildLineageFromRow(cliRow({ toolType: "codex-chat" }))).toBeNull();
    expect(cliChildLineageFromRow(cliRow({
      resumeMetadata: { ...cliRow().resumeMetadata!, orchestrationParentSessionId: undefined },
    }))).toBeNull();
    // A self-parent and a legacy row with no supported spawn type never report.
    expect(cliChildLineageFromRow(cliRow({
      resumeMetadata: { ...cliRow().resumeMetadata!, orchestrationParentSessionId: "cli-1" },
    }))).toBeNull();
    expect(cliChildLineageFromRow(cliRow({
      resumeMetadata: { ...cliRow().resumeMetadata!, spawnKind: undefined },
    }))).toBeNull();
  });
});

describe("cliChildResultStatus", () => {
  it("maps a terminal's end to the card's verdict and stays silent while it runs", () => {
    expect(cliChildResultStatus({ status: "running" })).toBeNull();
    expect(cliChildResultStatus({ status: "completed", exitCode: 0 })).toBe("completed");
    expect(cliChildResultStatus({ status: "failed", exitCode: 2 })).toBe("failed");
    expect(cliChildResultStatus({ status: "disposed", exitCode: null })).toBe("stopped");
    expect(cliChildResultStatus({ status: "detached", exitCode: null })).toBe("stopped");
  });
});

describe("cliChildRunKey", () => {
  it("keys one run on its persisted end so a live exit and a reconcile agree", () => {
    const row = { endedAt: "2026-09-23T10:00:00.000Z", startedAt: "2026-09-23T09:00:00.000Z" };
    expect(cliChildRunKey(row)).toBe(cliChildRunKey({ ...row }));
    expect(cliChildRunKey(row)).not.toBe(cliChildRunKey({ ...row, endedAt: "2026-09-23T11:00:00.000Z" }));
  });
});

describe("provider final messages", () => {
  it("reads Codex's closing message, newest first", () => {
    const lines = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Looking at the tests" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed both flakes." }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Fixed both flakes; suite is green." } }),
      "not json",
    ];
    expect(extractCodexFinalMessage(lines)).toBe("Fixed both flakes; suite is green.");
    expect(extractCodexFinalMessage(lines.slice(0, 2))).toBe("Fixed both flakes.");
    expect(extractCodexFinalMessage([])).toBeNull();
  });

  it("reads Claude Code's last assistant text and skips tool-only turns", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: renamed the helper." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: "thanks" } }),
    ];
    expect(extractClaudeFinalMessage(lines)).toBe("Done: renamed the helper.");
  });

  describe("readCliProviderFinalMessage", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    let tmp: string | null = null;
    afterEach(() => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    });

    it("finds a Codex rollout by the captured thread id", async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-child-"));
      process.env.CODEX_HOME = tmp;
      const threadId = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      const dayDir = path.join(tmp, "sessions", "2026", "09", "23");
      fs.mkdirSync(dayDir, { recursive: true });
      fs.writeFileSync(
        path.join(dayDir, `rollout-2026-09-23T10-00-00-${threadId}.jsonl`),
        `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Shipped the retry." } })}\n`,
      );
      expect(await readCliProviderFinalMessage({ provider: "codex", targetId: threadId, cwd: null })).toBe("Shipped the retry.");
      expect(await readCliProviderFinalMessage({ provider: "codex", targetId: null, cwd: null })).toBeNull();
      expect(await readCliProviderFinalMessage({ provider: "droid", targetId: threadId, cwd: null })).toBeNull();
    });

    it("shares in-flight rollout lookup and caches the resolved path for later reads", async () => {
      const targetId = "codex-thread-cache-test";
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-child-cache-"));
      const rolloutPath = path.join(tmp, "rollout.jsonl");
      fs.writeFileSync(
        rolloutPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "All done." } })}\n`,
      );
      const findCodexRolloutPath = vi.fn(async () => rolloutPath);
      const reader = createCliChildSessionReader({ findCodexRolloutPath });
      const args = { provider: "codex", targetId, cwd: null };

      const firstReads = await Promise.all([
        reader.readProviderFinalMessage(args),
        reader.readProviderFinalMessage(args),
      ]);
      expect(firstReads).toEqual(["All done.", "All done."]);
      expect(await reader.readProviderFinalMessage(args)).toBe("All done.");
      expect(findCodexRolloutPath).toHaveBeenCalledTimes(1);
    });
  });
});

describe("lastMeaningfulTerminalLines", () => {
  it("strips ANSI and TUI chrome and collapses repeated redraws", () => {
    const tail = [
      "\u001b[32m╭──────────╮\u001b[0m",
      "Running 12 tests",
      "Running 12 tests",
      "\u001b[1mAll 12 tests passed.\u001b[0m",
      "Token usage: total=1200 input=1000 output=200",
      "To continue this session, run codex resume 0199",
      "codex resume 0199a1b2",
      "",
    ].join("\r\n");
    expect(lastMeaningfulTerminalLines(tail)).toBe("Running 12 tests\nAll 12 tests passed.");
    expect(lastMeaningfulTerminalLines("\u001b[2J  \n")).toBeNull();
  });
});

describe("composeCliChildReport", () => {
  it("prefers the CLI's own message, then its terminal lines, and never a placeholder", () => {
    expect(composeCliChildReport({ status: "completed", exitCode: 0, providerMessage: "Fixed it.", terminalTail: "tail" }))
      .toBe("Fixed it.");
    expect(composeCliChildReport({ status: "completed", exitCode: 0, terminalTail: "All green" })).toBe("All green");
    expect(composeCliChildReport({ status: "completed", exitCode: 0 }))
      .toBe("The CLI exited with exit code 0 without printing any output.");
    expect(composeCliChildReport({ status: "failed", exitCode: 2, terminalTail: "Error: ENOENT" }))
      .toBe("CLI failed (exit code 2).\nError: ENOENT");
    expect(composeCliChildReport({ status: "stopped", exitCode: null }))
      .toBe("CLI session was closed before it exited on its own.");
  });
});

describe("TRACKED_AGENT_CLI_TOOL_TYPES", () => {
  it("stays in step with isTrackedAgentCliToolType", () => {
    for (const toolType of TRACKED_AGENT_CLI_TOOL_TYPES) {
      expect(isTrackedAgentCliToolType(toolType)).toBe(true);
    }
    expect(new Set(TRACKED_AGENT_CLI_TOOL_TYPES).size).toBe(TRACKED_AGENT_CLI_TOOL_TYPES.length);
  });
});
