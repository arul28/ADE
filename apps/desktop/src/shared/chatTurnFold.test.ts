import { describe, expect, it } from "vitest";
import {
  classifyTurnFoldEvent,
  deriveTurnFolds,
  formatTurnFoldLabel,
  inferTurnEndTurnId,
  pluralCount,
  isForeignTurnEnd,
  isTrivialTurnFoldEvent,
  isTurnFoldEventLive,
  snapshotTurnEnd,
  type TurnEndSnapshot,
  type TurnFoldRow,
} from "./chatTurnFold";
import { HOST_ASLEEP_NOTICE_STATUS, HOST_AWAKE_NOTICE_STATUS } from "./hostSleepNotice";

const user = (key: string): TurnFoldRow => ({ key, role: "boundary", turnId: null });
const text = (key: string, turnId = "t1", phase: TurnFoldRow["phase"] = null): TurnFoldRow => ({
  key,
  role: "text",
  turnId,
  phase,
});
const history = (key: string, turnId: string | null = "t1"): TurnFoldRow => ({ key, role: "history", turnId });
const keep = (key: string): TurnFoldRow => ({ key, role: "keep", turnId: null });
const keepIfLive = (key: string, liveKeys?: string[]): TurnFoldRow => ({
  key,
  role: "keep_if_live",
  turnId: "t1",
  ...(liveKeys ? { liveKeys } : {}),
});
const done = (key: string, turnId = "t1", status: TurnFoldRow["status"] = "completed"): TurnFoldRow => ({
  key,
  role: "turn_end",
  turnId,
  status,
});

function snapshots(entries: Record<string, Partial<TurnEndSnapshot> & { live?: string[] }> = {}) {
  return (turnId: string): TurnEndSnapshot | undefined => {
    const entry = entries[turnId];
    if (!entry) return { liveRowKeys: new Set(), subagentCount: 0 };
    return { liveRowKeys: new Set(entry.live ?? []), subagentCount: entry.subagentCount ?? 0 };
  };
}

const noLiveness = {
  isInputResolved: () => false,
  isTodoListUnfinished: () => false,
};

describe("deriveTurnFolds — answer selection", () => {
  it("folds everything before the last text row of the turn", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("thought"), text("interim"), history("plan"), text("answer"), done("d")],
      snapshots(),
    );
    expect(fold).toMatchObject({ foldId: "turn-fold:t1", turnId: "t1", answerKey: "answer", turnEndKey: "d" });
    expect([...fold!.hiddenKeys]).toEqual(["thought", "interim", "plan"]);
    expect(fold!.spanStartIndex).toBe(1);
  });

  it("prefers the last final_answer row over a later unlabelled row", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("plan"), text("a", "t1", "final_answer"), history("thought"), text("late"), done("d")],
      snapshots(),
    );
    expect(fold!.answerKey).toBe("a");
    // Rows after the chosen answer — even later text — are never folded.
    expect([...fold!.hiddenKeys]).toEqual(["plan"]);
  });

  it("uses the last of several final_answer rows", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), text("a1", "t1", "final_answer"), history("h"), text("a2", "t1", "final_answer"), done("d")],
      snapshots(),
    );
    expect(fold!.answerKey).toBe("a2");
    expect([...fold!.hiddenKeys]).toEqual(["a1", "h"]);
  });

  it("never picks commentary as the answer", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("h"), text("answer"), text("after", "t1", "commentary"), done("d")],
      snapshots(),
    );
    expect(fold!.answerKey).toBe("answer");
    expect(deriveTurnFolds(
      [user("u"), history("h"), text("c1", "t1", "commentary"), text("c2", "t1", "commentary"), done("d")],
      snapshots(),
    )).toEqual([]);
  });

  it("does not fold a turn without an answer (tool-only, interrupted, error)", () => {
    expect(deriveTurnFolds([user("u"), history("thought"), history("tools"), done("d")], snapshots())).toEqual([]);
    expect(deriveTurnFolds(
      [user("u"), history("thought"), keep("error"), done("d", "t1", "failed")],
      snapshots(),
    )).toEqual([]);
  });

  it("ignores text rows from another turn as answer candidates and keeps them visible", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), text("stray", "t0"), history("h"), text("answer"), done("d")],
      snapshots(),
    );
    expect(fold!.answerKey).toBe("answer");
    expect(fold!.keptKeys).toEqual(["stray"]);
    expect([...fold!.hiddenKeys]).toEqual(["h"]);
  });
});

describe("deriveTurnFolds — span", () => {
  it("never folds rows after the answer", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("h1"), text("answer"), history("h2"), keepIfLive("job"), done("d")],
      snapshots(),
    );
    expect([...fold!.hiddenKeys]).toEqual(["h1"]);
  });

  it("does not fold a live turn (no done row yet)", () => {
    expect(deriveTurnFolds([user("u"), history("h"), text("interim"), text("more")], snapshots())).toEqual([]);
  });

  it("shows no fold row when folding would hide nothing", () => {
    expect(deriveTurnFolds([user("u"), keep("error"), text("answer"), done("d")], snapshots())).toEqual([]);
    expect(deriveTurnFolds([user("u"), text("answer"), done("d")], snapshots())).toEqual([]);
  });

  it("shows no fold row when every row it would hide is trivial", () => {
    const trivial = (row: TurnFoldRow): TurnFoldRow => ({ ...row, trivial: true });
    // An internal follow-up turn: a diagnostics receipt and an empty fragment,
    // then a one-line answer. Nothing worth opening, so no fold.
    expect(deriveTurnFolds(
      [done("d0", "t0"), trivial(history("details", "t2")), trivial(text("blank", "t2")), text("answer", "t2"), done("d2", "t2")],
      snapshots(),
    )).toEqual([]);
    // One real row among them still folds, and the fold hides the receipts too.
    const [fold] = deriveTurnFolds(
      [user("u"), trivial(history("details")), history("thought"), text("answer"), done("d")],
      snapshots(),
    );
    expect([...fold!.hiddenKeys]).toEqual(["details", "thought"]);
  });

  it("classifies status and diagnostics receipts and empty prose as trivial", () => {
    for (const type of ["status", "activity", "step_boundary", "turn_details", "turn_diagnostics", "done"]) {
      expect(isTrivialTurnFoldEvent({ type })).toBe(true);
    }
    expect(isTrivialTurnFoldEvent({ type: "text", text: "  \n" } as { type: string })).toBe(true);
    expect(isTrivialTurnFoldEvent({ type: "reasoning", text: "" } as { type: string })).toBe(true);
    expect(isTrivialTurnFoldEvent({ type: "text", text: "ok" } as { type: string })).toBe(false);
    expect(isTrivialTurnFoldEvent({ type: "reasoning", text: "thinking" } as { type: string })).toBe(false);
    expect(isTrivialTurnFoldEvent({ type: "work_log_group" })).toBe(false);
  });

  it("starts each turn after the previous turn end when there is no user message", () => {
    const folds = deriveTurnFolds(
      [
        user("u"), history("h1"), text("a1"), done("d1"),
        history("h2"), text("a2", "t2"), done("d2", "t2"),
      ],
      snapshots(),
    );
    expect(folds.map((fold) => [fold.turnId, [...fold.hiddenKeys], fold.spanStartIndex])).toEqual([
      ["t1", ["h1"], 1],
      ["t2", ["h2"], 4],
    ]);
  });

  it("treats a steer's user message as a new visual response", () => {
    const [fold] = deriveTurnFolds(
      [user("u1"), history("before-steer"), text("interim"), user("steer"), history("after"), text("answer"), done("d")],
      snapshots(),
    );
    expect([...fold!.hiddenKeys]).toEqual(["after"]);
    expect(fold!.spanStartIndex).toBe(4);
  });

  it("folds each turn once even when a second done repeats the turn id", () => {
    const folds = deriveTurnFolds(
      [user("u"), history("h"), text("answer"), done("d1"), done("d2")],
      snapshots(),
    );
    expect(folds).toHaveLength(1);
    expect(folds[0]!.turnEndKey).toBe("d1");
  });

  it("keeps kept rows in original order and reports them", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), keep("spawn"), history("h"), keep("proof"), text("interim"), text("answer"), done("d")],
      snapshots(),
    );
    expect(fold!.keptKeys).toEqual(["spawn", "proof"]);
    expect([...fold!.hiddenKeys]).toEqual(["h", "interim"]);
  });
});

describe("deriveTurnFolds — whose turn a done ends", () => {
  const userOf = (key: string, turnId: string): TurnFoldRow => ({ key, role: "boundary", turnId });

  it("does not let a subagent's done (arriving first) end the parent's window", () => {
    const folds = deriveTurnFolds(
      [
        userOf("u", "p"),
        history("thought", "p"),
        text("interim", "p"),
        done("sub-done", "sub-1", "interrupted"),
        text("answer", "p"),
        done("d", "p", "interrupted"),
      ],
      snapshots(),
    );
    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({ turnId: "p", answerKey: "answer", turnEndKey: "d", status: "interrupted" });
    // The foreign done is a receipt inside the span: it folds with the history.
    expect([...folds[0]!.hiddenKeys]).toEqual(["thought", "interim", "sub-done"]);
  });

  it("folds the parent when a subagent's done arrives after the parent's", () => {
    const folds = deriveTurnFolds(
      [userOf("u", "p"), history("h", "p"), text("answer", "p"), done("d", "p"), done("late-sub", "sub-1")],
      snapshots(),
    );
    expect(folds.map((fold) => fold.turnId)).toEqual(["p"]);
    expect(folds[0]!.turnEndKey).toBe("d");
  });

  it("folds under the user message's turn id when the done has none", () => {
    const [fold] = deriveTurnFolds(
      [userOf("u", "p"), history("h", "p"), text("answer", "p"), { key: "d", role: "turn_end", turnId: null }],
      snapshots(),
    );
    expect(fold).toMatchObject({ foldId: "turn-fold:p", turnId: "p", turnEndKey: "d", answerKey: "answer" });
  });

  it("falls back to the last text row's turn id without a user message", () => {
    const [fold] = deriveTurnFolds(
      [done("prev", "t0"), history("h", "p"), text("answer", "p"), { key: "d", role: "turn_end", turnId: null }],
      snapshots(),
    );
    expect(fold?.turnId).toBe("p");
  });

  it("lets a done own a window whose rows name no turn at all", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("h", null), { key: "answer", role: "text", turnId: null }, done("d", "p")],
      snapshots(),
    );
    expect(fold?.turnId).toBe("p");
  });

  it("still separates consecutive turns that carry their own ids", () => {
    const folds = deriveTurnFolds(
      [
        userOf("u1", "t1"), history("h1", "t1"), text("a1", "t1"), done("d1", "t1"),
        history("h2", "t2"), text("a2", "t2"), done("d2", "t2"),
      ],
      snapshots(),
    );
    expect(folds.map((fold) => [fold.turnId, [...fold.hiddenKeys]])).toEqual([
      ["t1", ["h1"]],
      ["t2", ["h2"]],
    ]);
  });

  it("isForeignTurnEnd / inferTurnEndTurnId", () => {
    expect(isForeignTurnEnd("sub", new Set(["p"]))).toBe(true);
    expect(isForeignTurnEnd("p", new Set(["p", "sub"]))).toBe(false);
    expect(isForeignTurnEnd("p", new Set())).toBe(false);
    expect(isForeignTurnEnd(null, new Set(["p"]))).toBe(false);
    expect(inferTurnEndTurnId("p", [text("x", "q")])).toBe("p");
    expect(inferTurnEndTurnId(null, [text("x", "q"), history("h", "r"), text("y", "s")])).toBe("s");
    expect(inferTurnEndTurnId(null, [history("h", "r")])).toBeNull();
  });
});

describe("deriveTurnFolds — sticky liveness", () => {
  it("keeps a row that was live at turn end and folds one that had settled", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), keepIfLive("job-live"), keepIfLive("job-done"), history("h"), text("answer"), done("d")],
      snapshots({ t1: { live: ["job-live"] } }),
    );
    expect(fold!.keptKeys).toEqual(["job-live"]);
    expect([...fold!.hiddenKeys]).toEqual(["job-done", "h"]);
  });

  it("keeps a grouped row when any member was live", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), keepIfLive("bundle", ["todo-1", "sched-1"]), history("h"), text("answer"), done("d")],
      snapshots({ t1: { live: ["sched-1"] } }),
    );
    expect(fold!.keptKeys).toEqual(["bundle"]);
  });

  it("keeps a keep_if_live row visible when no snapshot exists", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), keepIfLive("job"), history("h"), text("answer"), done("d")],
      () => undefined,
    );
    expect(fold!.keptKeys).toEqual(["job"]);
  });

  it("carries the snapshot's subagent count and the turn status", () => {
    const [fold] = deriveTurnFolds(
      [user("u"), history("h"), text("answer"), done("d", "t1", "interrupted")],
      snapshots({ t1: { subagentCount: 2 } }),
    );
    expect(fold).toMatchObject({ subagentCount: 2, status: "interrupted" });
  });
});

describe("snapshotTurnEnd", () => {
  const row = (key: string, event: Record<string, unknown> & { type: string }) => ({ key, event });

  it("records running background jobs and live lane setup, not settled ones", () => {
    const snapshot = snapshotTurnEnd([
      row("job-running", { type: "background_job_line", status: "running" }),
      row("job-done", { type: "background_job_line", status: "completed" }),
      row("setup-live", { type: "ade_card", variant: "lane_setup", state: "live" }),
      row("setup-done", { type: "ade_card", variant: "lane_setup", state: "terminal" }),
      row("ci-live", { type: "ade_card", variant: "pr_ci", state: "live" }),
    ], noLiveness);
    expect([...snapshot.liveRowKeys].sort()).toEqual(["job-running", "setup-live"]);
  });

  it("records unanswered approvals and questions only", () => {
    const snapshot = snapshotTurnEnd([
      row("open", { type: "approval_request", itemId: "a1" }),
      row("answered", { type: "approval_request", itemId: "a2" }),
      row("question", { type: "structured_question", itemId: "q1" }),
    ], { ...noLiveness, isInputResolved: (itemId) => itemId === "a2" });
    expect([...snapshot.liveRowKeys].sort()).toEqual(["open", "question"]);
  });

  it("judges scheduled work by its latest update in the turn", () => {
    const snapshot = snapshotTurnEnd([
      row("cron-scheduled", { type: "scheduled_work_update", id: "cron", status: "scheduled" }),
      row("wake-scheduled", { type: "scheduled_work_update", id: "wake", status: "scheduled" }),
      row("wake-fired", { type: "scheduled_work_update", id: "wake", status: "completed" }),
    ], noLiveness);
    expect([...snapshot.liveRowKeys]).toEqual(["cron-scheduled"]);
  });

  it("records an unfinished task list", () => {
    const snapshot = snapshotTurnEnd([
      row("todo-1", { type: "todo_update", turnId: "t1", items: [] }),
      row("todo-2", { type: "todo_update", turnId: "t2", items: [] }),
    ], { ...noLiveness, isTodoListUnfinished: (turnId) => turnId === "t1" });
    expect([...snapshot.liveRowKeys]).toEqual(["todo-1"]);
  });

  it("counts distinct subagents in the turn", () => {
    const snapshot = snapshotTurnEnd([
      row("spawn-a", { type: "subagent_spawn_anchor", agentKey: "a" }),
      row("result-b", { type: "subagent_result_card", agentKey: "b" }),
      row("result-a", { type: "subagent_result_card", agentKey: "a" }),
    ], noLiveness);
    expect(snapshot.subagentCount).toBe(2);
  });
});

describe("classifyTurnFoldEvent", () => {
  it.each([
    [{ type: "reasoning" }, "history"],
    [{ type: "work_log_group" }, "history"],
    [{ type: "plan" }, "history"],
    // The chat's one task list never folds.
    [{ type: "task_list" }, "keep"],
    [{ type: "turn_diagnostics" }, "history"],
    [{ type: "turn_details" }, "history"],
    [{ type: "turn_recovery" }, "history"],
    [{ type: "codex_turn_stalled" }, "history"],
    [{ type: "context_compact" }, "history"],
    [{ type: "claude_goal_updated" }, "history"],
    [{ type: "system_notice", noticeKind: "info", status: "subagent_spawned", message: "Subagent spawned: x" }, "history"],
    [{ type: "system_notice", noticeKind: "info", status: "spawn_completed", message: "Chat x finished its turn" }, "history"],
    [{ type: "system_notice", noticeKind: "hook", message: "hook ran" }, "history"],
    [{ type: "system_notice", noticeKind: "rate_limit", message: "Limit reached" }, "keep"],
    [{ type: "system_notice", noticeKind: "rate_limit", severity: "warning", message: "Approaching limit" }, "history"],
    // Warnings and info are history: nothing to act on.
    [{ type: "system_notice", noticeKind: "warning", message: "⚠ Codex is ignoring 1 unrecognized configuration setting." }, "history"],
    [{ type: "system_notice", noticeKind: "config", message: "⚙ config: x" }, "history"],
    [{ type: "system_notice", noticeKind: "info", severity: "warning", message: "Claude could not compact this conversation." }, "history"],
    [{ type: "system_notice", noticeKind: "info", message: "Claude retried with a fallback model." }, "history"],
    // Actionable notices stay.
    [{ type: "system_notice", noticeKind: "auth", severity: "warning", message: "Sign in again" }, "keep"],
    [{ type: "system_notice", noticeKind: "error", message: "🛡 guardian: blocked" }, "keep"],
    [{ type: "system_notice", noticeKind: "info", severity: "error", message: "Mirror failed" }, "keep"],
    [{ type: "system_notice", noticeKind: "provider_health", message: "Provider down" }, "keep"],
    [{ type: "system_notice", noticeKind: "thread_error", message: "Thread failed" }, "keep"],
    [{ type: "system_notice", noticeKind: "info", status: "model_switched", message: "Switched to Opus" }, "keep"],
    [{ type: "system_notice", noticeKind: "something_new", message: "?" }, "keep"],
    [{ type: "system_notice", noticeKind: "info", status: "reset_credit_available", message: "Reset credit" }, "keep"],
    [{ type: "system_notice", noticeKind: "info", message: "Couldn't resume", detail: { kind: "continuity_recovery" } }, "keep"],
    [{ type: "error", message: "boom" }, "keep"],
    [{ type: "interrupt_receipt" }, "keep"],
    [{ type: "queue_recovery" }, "keep"],
    [{ type: "subagent_spawn_anchor" }, "keep"],
    [{ type: "subagent_result_card" }, "keep"],
    [{ type: "subagent_stopped_group" }, "keep"],
    [{ type: "ade_card", variant: "proof_artifact" }, "keep"],
    [{ type: "ade_card", variant: "pr_ci" }, "keep"],
    [{ type: "ade_card", variant: "some_future_card" }, "keep"],
    [{ type: "ade_card", variant: "lane_setup" }, "keep_if_live"],
    [{ type: "background_job_line" }, "keep_if_live"],
    [{ type: "background_job_group" }, "keep_if_live"],
    [{ type: "approval_request" }, "keep_if_live"],
    [{ type: "structured_question" }, "keep_if_live"],
    [{ type: "activity_bundle" }, "keep_if_live"],
    [{ type: "user_message" }, "boundary"],
    [{ type: "user_message", deliveryState: "queued" }, "keep"],
    [{ type: "done" }, "turn_end"],
    [{ type: "text" }, "text"],
    [{ type: "something_new" }, "keep"],
  ] as const)("%o is %s", (event, role) => {
    expect(classifyTurnFoldEvent(event)).toBe(role);
  });

  it("folds either half of a host-sleep chip, even one marked as a warning", () => {
    for (const status of [HOST_ASLEEP_NOTICE_STATUS, HOST_AWAKE_NOTICE_STATUS]) {
      const notice = { type: "system_notice", noticeKind: "warning", status, message: "x" };
      expect(classifyTurnFoldEvent(notice)).toBe("history");
    }
  });
});

describe("isTurnFoldEventLive", () => {
  it("is false for rows that are never live", () => {
    expect(isTurnFoldEventLive({ type: "reasoning" }, noLiveness)).toBe(false);
    expect(isTurnFoldEventLive({ type: "subagent_spawn_anchor" }, noLiveness)).toBe(false);
  });
});

describe("formatTurnFoldLabel", () => {
  it("reads duration and non-zero counts", () => {
    expect(formatTurnFoldLabel({ duration: "4m 12s", status: "completed", toolCount: 18, fileCount: 3, subagentCount: 2 }))
      .toBe("Worked for 4m 12s · 18 tools · 3 files · 2 subagents");
    expect(formatTurnFoldLabel({ duration: "2.0s", status: "completed", toolCount: 1, fileCount: 0, subagentCount: 0 }))
      .toBe("Worked for 2.0s · 1 tool");
    expect(formatTurnFoldLabel({ duration: null, status: "completed", toolCount: 0, fileCount: 1, subagentCount: 1 }))
      .toBe("Worked · 1 file · 1 subagent");
  });

  it("adds background jobs, with the failed count when any failed", () => {
    expect(formatTurnFoldLabel({ duration: "3m", status: "completed", toolCount: 5, fileCount: 0, subagentCount: 0, jobCount: 5, failedJobCount: 1 }))
      .toBe("Worked for 3m · 5 tools · 5 jobs (1 failed)");
    expect(formatTurnFoldLabel({ duration: "3m", status: "completed", toolCount: 1, fileCount: 0, subagentCount: 0, jobCount: 1 }))
      .toBe("Worked for 3m · 1 tool · 1 job");
    expect([pluralCount(1, "tool"), pluralCount(2, "tool"), pluralCount(1, "file"), pluralCount(1, "subagent")])
      .toEqual(["1 tool", "2 tools", "1 file", "1 subagent"]);
  });

  it("ends with the turn's source count, omitted at zero", () => {
    expect(formatTurnFoldLabel({ duration: "1m", status: "completed", toolCount: 2, fileCount: 0, subagentCount: 0, sourceCount: 3 }))
      .toBe("Worked for 1m · 2 tools · 3 sources");
    expect(formatTurnFoldLabel({ duration: "1m", status: "completed", toolCount: 2, fileCount: 0, subagentCount: 0, sourceCount: 0 }))
      .toBe("Worked for 1m · 2 tools");
  });

  it("does not attribute an interrupted turn to the user", () => {
    expect(formatTurnFoldLabel({ duration: "40s", status: "interrupted", toolCount: 2, fileCount: 0, subagentCount: 0 }))
      .toBe("Stopped after 40s · 2 tools");
    expect(formatTurnFoldLabel({ duration: null, status: "interrupted", toolCount: 0, fileCount: 0, subagentCount: 0 }))
      .toBe("Stopped");
  });
});

describe("duplicate answer text", () => {
  const prose = (key: string, value: string): TurnFoldRow => ({ key, role: "text", turnId: "t1", text: value });

  it("marks an earlier row whose trimmed prose equals the answer", () => {
    const [fold] = deriveTurnFolds([
      user("u"),
      history("r1"),
      prose("first", "I'm Grok 4.7."),
      history("tool"),
      prose("again", "  I'm Grok 4.7.\n"),
      done("d"),
    ], snapshots());
    expect(fold!.answerKey).toBe("again");
    expect([...fold!.duplicateAnswerKeys]).toEqual(["first"]);
    expect(fold!.hiddenKeys.has("first")).toBe(true);
  });

  it("marks nothing when the texts differ or a surface supplies no prose", () => {
    const [different] = deriveTurnFolds([user("u"), prose("a", "Checking."), history("r"), prose("b", "Done."), done("d")], snapshots());
    expect(different!.duplicateAnswerKeys.size).toBe(0);
    const [unknown] = deriveTurnFolds([user("u"), text("a"), history("r"), text("b"), done("d")], snapshots());
    expect(unknown!.duplicateAnswerKeys.size).toBe(0);
  });
});
