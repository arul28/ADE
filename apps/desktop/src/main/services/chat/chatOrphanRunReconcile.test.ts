import { describe, expect, it } from "vitest";
import {
  ORPHAN_BACKGROUND_SUMMARY,
  ORPHAN_SUBAGENT_CHAT_FAILED_SUMMARY,
  ORPHAN_SUBAGENT_CHAT_MISSING_SUMMARY,
  ORPHAN_SUBAGENT_NO_REPORT_SUMMARY,
  ORPHAN_SUBAGENT_REPORT_LANDED_SUMMARY,
  decideOrphanBackgroundTerminal,
  decideOrphanSubagentTerminal,
  deriveOrphanChildChatState,
  orphanRowChildSessionCandidate,
  type OrphanChildChatRow,
  type OrphanSubagentRow,
} from "./chatOrphanRunReconcile";

const RESTART = { stopSource: "system", stopReason: "the ADE brain restarted" } as const;

function row(overrides: Partial<OrphanSubagentRow> = {}): OrphanSubagentRow {
  return {
    id: "task-1",
    name: "Audit chat renderer",
    summary: "Audit chat renderer",
    parentToolUseId: null,
    ...overrides,
  };
}

function childRow(overrides: Partial<OrphanChildChatRow> = {}): OrphanChildChatRow {
  return { id: "chat-child", status: "running", ...overrides };
}

describe("deriveOrphanChildChatState", () => {
  it("reads a running chat whose own runtime is alive as active", () => {
    expect(deriveOrphanChildChatState(childRow(), true)).toBe("active");
  });

  it("reads a running chat whose runtime is dead as idle, not active", () => {
    expect(deriveOrphanChildChatState(childRow(), false)).toBe("idle");
  });

  it("reads completed, disposed, and ended-at rows as ended", () => {
    expect(deriveOrphanChildChatState(childRow({ status: "completed" }), true)).toBe("ended");
    expect(deriveOrphanChildChatState(childRow({ status: "disposed" }), true)).toBe("ended");
    expect(deriveOrphanChildChatState(childRow({ endedAt: "2026-09-18T02:14:00.000Z" }), true)).toBe("ended");
  });

  it("reads a failed row, or a live row whose last turn died, as failed", () => {
    expect(deriveOrphanChildChatState(childRow({ status: "failed" }), true)).toBe("failed");
    expect(deriveOrphanChildChatState(childRow({ lastTurnFailedAt: "2026-09-18T02:14:00.000Z" }), true)).toBe("failed");
  });

  it("reads a vanished chat as missing", () => {
    expect(deriveOrphanChildChatState(null, false)).toBe("missing");
  });
});

describe("decideOrphanSubagentTerminal", () => {
  it("leaves a delegate whose own chat is still active untouched", () => {
    expect(decideOrphanSubagentTerminal({
      row: row(),
      childState: "active",
      attribution: RESTART,
    })).toBeNull();
  });

  it("stops a plain SDK subagent row with the sweep's attribution, never as the user", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: null,
      attribution: RESTART,
    });
    expect(terminal).toMatchObject({
      status: "stopped",
      stopSource: "system",
      stopReason: "the ADE brain restarted",
    });
    expect(terminal?.summary).toBe("Stopped: the ADE brain restarted");
  });

  it("keeps a real progress summary instead of overwriting it with boilerplate", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row({ summary: "Read 12 files, wrote the migration" }),
      childState: null,
      attribution: RESTART,
    });
    expect(terminal?.summary).toBe("Read 12 files, wrote the migration");
  });

  it("finishes an idle subagent chat that left a report (report landed)", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: "idle",
      childReport: "Ported the pane and ran the focused tests",
      attribution: RESTART,
    });
    expect(terminal?.status).toBe("completed");
    expect(terminal?.summary).toBe("Ported the pane and ran the focused tests");
    expect(terminal?.finalSummary).toContain(ORPHAN_SUBAGENT_REPORT_LANDED_SUMMARY);
    expect(terminal?.stopSource).toBeUndefined();
  });

  it("stops an idle subagent chat that never reported", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: "idle",
      attribution: RESTART,
    });
    expect(terminal).toMatchObject({ status: "stopped", summary: ORPHAN_SUBAGENT_NO_REPORT_SUMMARY });
  });

  it("fails a row whose subagent chat failed", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: "failed",
      attribution: RESTART,
    });
    expect(terminal).toMatchObject({ status: "failed", summary: ORPHAN_SUBAGENT_CHAT_FAILED_SUMMARY });
  });

  it("stops a row whose subagent chat is gone", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: "missing",
      attribution: RESTART,
    });
    expect(terminal).toMatchObject({ status: "stopped", summary: ORPHAN_SUBAGENT_CHAT_MISSING_SUMMARY });
  });

  it("completes an ended subagent chat that left a report", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: "ended",
      childReport: "Shipped",
      attribution: RESTART,
    });
    expect(terminal).toMatchObject({ status: "completed", summary: "Shipped" });
  });

  it("carries a foreign-brain takeover attribution through unchanged", () => {
    const terminal = decideOrphanSubagentTerminal({
      row: row(),
      childState: null,
      attribution: { stopSource: "foreign-brain", stopReason: "another ADE brain took over this chat" },
    });
    expect(terminal).toMatchObject({ stopSource: "foreign-brain" });
  });
});

describe("decideOrphanBackgroundTerminal", () => {
  it("stops an open background command with the sweep's attribution", () => {
    expect(decideOrphanBackgroundTerminal({
      row: { id: "bg-1", title: "npm run dev", summary: null },
      attribution: RESTART,
    })).toEqual({
      status: "stopped",
      summary: ORPHAN_BACKGROUND_SUMMARY,
      stopSource: "system",
      stopReason: "the ADE brain restarted",
    });
  });

  it("keeps a summary the command actually produced", () => {
    expect(decideOrphanBackgroundTerminal({
      row: { id: "bg-1", title: "npm run dev", summary: "listening on 5173" },
      attribution: RESTART,
    }).summary).toBe("listening on 5173");
  });
});

describe("orphanRowChildSessionCandidate", () => {
  it("unwraps a chat: taskId", () => {
    expect(orphanRowChildSessionCandidate("chat:abc-123")).toBe("abc-123");
  });

  it("passes a bare agent id through for the caller to confirm", () => {
    expect(orphanRowChildSessionCandidate("abc-123")).toBe("abc-123");
  });

  it("rejects empty ids", () => {
    expect(orphanRowChildSessionCandidate("  ")).toBeNull();
    expect(orphanRowChildSessionCandidate("chat:")).toBeNull();
  });
});
