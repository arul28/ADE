import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { deriveSubagentCardName } from "../../../shared/chatSubagents";
import {
  applyChatTranscriptTurnFolds,
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsWithContext,
  deriveChatTranscriptTurnFolds,
  groupChatTranscriptRows,
  groupSubagentCardGrids,
  mergeAdjacentActivityBundleRows,
  readTurnEndSnapshots,
  subagentCardGridColumns,
  subagentCardGridKeyByMemberKey,
  type ChatTranscriptGroupedEnvelope,
  type ChatTranscriptRenderEnvelope,
} from "./chatTranscriptRows";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 23, 12, 0, clock++)).toISOString();
const ev = (event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
  sessionId: "session-1",
  timestamp: at(),
  event,
});

const started = (id: string, description: string, extra: Record<string, unknown> = {}) => ev({
  type: "subagent_started",
  taskId: id,
  agentId: id,
  description,
  turnId: "t1",
  ...extra,
} as AgentChatEventEnvelope["event"]);
const finished = (id: string, summary = `${id} done`) => ev({
  type: "subagent_result",
  taskId: id,
  agentId: id,
  status: "completed",
  summary,
  turnId: "t1",
});

/** The message list's presentation, in its order: group, filter, merge, grid. */
function present(rows: ChatTranscriptRenderEnvelope[]): ChatTranscriptGroupedEnvelope[] {
  return groupSubagentCardGrids(mergeAdjacentActivityBundleRows(
    groupChatTranscriptRows(rows).filter((row) => row.event.type !== "work_log_group"),
  ));
}

const presentEvents = (events: AgentChatEventEnvelope[]) => present(collapseChatTranscriptEvents(events));
const types = (rows: readonly ChatTranscriptGroupedEnvelope[]) => rows.map((row) => row.event.type);
function gridOf(row: ChatTranscriptGroupedEnvelope | undefined) {
  if (row?.event.type !== "subagent_card_grid") throw new Error(`expected a grid, got ${row?.event.type}`);
  return row.event;
}

describe("subagent card names in the collapse pass", () => {
  it("titles a finished Claude agent by its Task description, never a progress activity line", () => {
    const rows = collapseChatTranscriptEvents([
      ev({ type: "user_message", text: "check it", turnId: "t1" }),
      started("task-1", "Check PersonalChatsPage and test harness", { agentType: "Explore", label: null }),
      ev({
        type: "subagent_progress",
        taskId: "task-1",
        agentId: "task-1",
        agentType: "Explore",
        description: "Running Check PersonalChatsPage and test harness and subagent events",
        summary: "Running Check PersonalChatsPage and test harness and subagent events",
        turnId: "t1",
      }),
      ev({
        type: "subagent_progress",
        taskId: "task-1",
        agentId: "task-1",
        agentType: "Explore",
        description: "Reading ~/.claude/projects/-Users-admin-Projects-ADE--ade-worktrees-start-contexrt-skill-ss-ios-3b94d839/16f2d759-5bb1-41ec-9dcd-6e.jsonl",
        summary: "Reading a transcript",
        turnId: "t1",
      }),
    ]);
    const spawn = rows.find((row) => row.event.type === "subagent_spawn_anchor")!.event;
    if (spawn.type !== "subagent_spawn_anchor") throw new Error("expected spawn");
    expect(deriveSubagentCardName(spawn)).toBe("Check PersonalChatsPage and test harness");

    const settled = collapseChatTranscriptEvents([
      ...[
        ev({ type: "user_message", text: "check it", turnId: "t1" }),
        started("task-1", "Check PersonalChatsPage and test harness", { agentType: "Explore" }),
        ev({
          type: "subagent_progress",
          taskId: "task-1",
          agentId: "task-1",
          description: "Running Check PersonalChatsPage and test harness and subagent events",
          summary: "working",
          turnId: "t1",
        }),
        // A re-emitted start carrying the activity line does not retitle it.
        started("task-1", "Reading ~/.claude/projects/-Users-admin-Projects-ADE/16f2d759.jsonl", { agentType: "Explore" }),
      ],
      finished("task-1", "The Work tab's transcript renderer can show a fixed list of events."),
    ]);
    const result = settled.find((row) => row.event.type === "subagent_result_card")!.event;
    if (result.type !== "subagent_result_card") throw new Error("expected result");
    expect(result.description).toBe("Check PersonalChatsPage and test harness");
    expect(deriveSubagentCardName(result)).toBe("Check PersonalChatsPage and test harness");
  });

  it("names a Claude agent whose start is in an unloaded page by its type, not by an activity line", () => {
    const rows = collapseChatTranscriptEvents([
      ev({
        type: "subagent_progress",
        taskId: "task-9",
        agentId: "task-9",
        agentType: "general-purpose",
        description: "Reading ~/.claude/projects/-Users-admin/16f2d759.jsonl",
        summary: "reading",
        turnId: "t1",
      }),
      finished("task-9"),
    ]);
    const result = rows.find((row) => row.event.type === "subagent_result_card")!.event;
    if (result.type !== "subagent_result_card") throw new Error("expected result");
    expect(deriveSubagentCardName(result)).toBe("general-purpose");
  });

  it("names a Codex agent by the humanized path its spawn carried", () => {
    const path = "/root/desktop_scan";
    const rows = collapseChatTranscriptEvents([
      started("thread-1", path, { agentType: path, label: path }),
      ev({
        type: "subagent_progress",
        taskId: "thread-1",
        agentId: "thread-1",
        agentType: "Curie",
        label: "Curie",
        description: "Scan the desktop app for IPC handlers that skip the trusted-renderer guard",
        summary: "Agent active",
        turnId: "t1",
      }),
      finished("thread-1"),
    ]);
    const result = rows.find((row) => row.event.type === "subagent_result_card")!.event;
    if (result.type !== "subagent_result_card") throw new Error("expected result");
    expect(deriveSubagentCardName(result)).toBe("Desktop scan");
  });

  it("titles stopped-group items by the same name", () => {
    const stop = (id: string) => ev({
      type: "subagent_result",
      taskId: id,
      agentId: id,
      status: "stopped",
      summary: "Interrupted",
      stopSource: "user",
      turnId: "t1",
    });
    const rows = presentEvents([
      started("a", "/root/desktop_scan"),
      started("b", "/root/ios_shared_scan"),
      started("c", "/root/cli_tui_scan"),
      started("d", "/root/sync_db_scan"),
      stop("a"),
      stop("b"),
      stop("c"),
      stop("d"),
    ]);
    const group = rows.find((row) => row.event.type === "subagent_stopped_group")!.event;
    if (group.type !== "subagent_stopped_group") throw new Error("expected stopped group");
    expect(group.items.map((item) => item.title)).toEqual([
      "Desktop scan",
      "iOS shared scan",
      "CLI TUI scan",
      "Sync DB scan",
    ]);
  });
});

describe("stopped cards in grids", () => {
  const restartStop = (id: string) => ev({
    type: "subagent_result",
    taskId: id,
    agentId: id,
    status: "stopped",
    summary: "Stopped: the ADE brain restarted",
    finalSummary: "Stopped: the ADE brain restarted",
    stopSource: "system",
    stopReason: "the ADE brain restarted",
    turnId: "t1",
  });

  it("lays three restart-stopped cards side by side in one grid", () => {
    const rows = presentEvents([
      ev({ type: "user_message", text: "scan", turnId: "t1" }),
      started("a", "/root/desktop_scan"),
      started("b", "/root/ios_shared_scan"),
      started("c", "/root/cli_tui_scan"),
      restartStop("a"),
      restartStop("b"),
      restartStop("c"),
    ]);
    expect(types(rows)).toEqual(["user_message", "subagent_card_grid"]);
    const grid = gridOf(rows[1]);
    // Settled in place: each card keeps its spawn key.
    expect(grid.memberKeys).toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
    expect(grid.members.map((member) => member.event.status)).toEqual(["stopped", "stopped", "stopped"]);
  });

  it("mixes finished and stopped cards in one grid, each keeping its status", () => {
    const rows = presentEvents([
      ev({ type: "user_message", text: "scan", turnId: "t1" }),
      started("a", "Scan A"),
      started("b", "Scan B"),
      started("c", "Scan C"),
      finished("a"),
      restartStop("b"),
      ev({
        type: "subagent_result",
        taskId: "c",
        agentId: "c",
        status: "failed",
        summary: "TypeError: x is undefined",
        turnId: "t1",
      }),
    ]);
    expect(types(rows)).toEqual(["user_message", "subagent_card_grid"]);
    expect(gridOf(rows[1]).members.map((member) => member.event.status)).toEqual(["completed", "stopped", "failed"]);
  });

  it("folds four or more report-less stopped cards into a group that answers for its members", () => {
    const ids = ["a", "b", "c", "d"];
    const rows = presentEvents([
      ev({ type: "user_message", text: "scan", turnId: "t1" }),
      ...ids.map((id) => started(id, `Scan ${id}`)),
      ...ids.map((id) => restartStop(id)),
    ]);
    expect(types(rows)).toEqual(["user_message", "subagent_stopped_group"]);
    const group = rows[1]!;
    if (group.event.type !== "subagent_stopped_group") throw new Error("expected stopped group");
    expect(group.event.count).toBe(4);
    // A jump to any folded card, by either of its keys, lands on the group row.
    const byMember = subagentCardGridKeyByMemberKey(rows);
    for (const id of ids) {
      expect(byMember.get(`subagent-spawn:${id}`)).toBe(group.key);
      expect(byMember.get(`subagent-result:${id}`)).toBe(group.key);
    }
  });
});

describe("stopped cards in mixed-state runs", () => {
  const restartStop = (id: string) => ev({
    type: "subagent_result",
    taskId: id,
    agentId: id,
    status: "stopped",
    summary: "Stopped: the ADE brain restarted",
    stopSource: "system",
    stopReason: "the ADE brain restarted",
    turnId: "t1",
  });

  it("keeps three stopped cards in the live grid beside running and finished ones", () => {
    const rows = presentEvents([
      ...["a", "b", "c", "d", "e"].map((id) => started(id, `Scan ${id}`)),
      finished("e"),
      restartStop("b"),
      restartStop("c"),
      restartStop("d"),
    ]);
    expect(types(rows)).toEqual(["subagent_card_grid"]);
    expect(gridOf(rows[0]).members.map((member) => member.event.status))
      .toEqual(["running", "stopped", "stopped", "stopped", "completed"]);
  });

  it("folds only the contiguous stopped run, in its place, and never reorders the cards around it", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const rows = presentEvents([
      ...ids.map((id) => started(id, `Scan ${id}`)),
      finished("g"),
      ...["b", "c", "d", "e"].map(restartStop),
    ]);
    // a (running) | 4 stopped folded | f (running) + g (finished) side by side.
    expect(types(rows)).toEqual(["subagent_spawn_anchor", "subagent_stopped_group", "subagent_card_grid"]);
    expect(rows[0]!.key).toBe("subagent-spawn:a");
    const group = rows[1]!.event;
    if (group.type !== "subagent_stopped_group") throw new Error("expected stopped group");
    expect(group.memberKeys).toEqual(["subagent-spawn:b", "subagent-spawn:c", "subagent-spawn:d", "subagent-spawn:e"]);
    expect(gridOf(rows[2]).memberKeys).toEqual(["subagent-spawn:f", "subagent-spawn:g"]);
  });
});

describe("groupSubagentCardGrids", () => {
  it("leaves a lone card as its own row", () => {
    const rows = presentEvents([ev({ type: "user_message", text: "go", turnId: "t1" }), started("a", "Scan A")]);
    expect(types(rows)).toEqual(["user_message", "subagent_spawn_anchor"]);
  });

  it.each([2, 3, 4, 7])("folds %i consecutive running cards into one grid keyed by the first card", (count) => {
    const ids = Array.from({ length: count }, (_, index) => `agent-${index}`);
    const rows = presentEvents([
      ev({ type: "user_message", text: "scan in parallel", turnId: "t1" }),
      ...ids.map((id) => started(id, `Scan ${id}`)),
    ]);
    expect(types(rows)).toEqual(["user_message", "subagent_card_grid"]);
    const grid = gridOf(rows[1]);
    expect(grid.memberKeys).toEqual(ids.map((id) => `subagent-spawn:${id}`));
    expect(grid.members.map((member) => member.key)).toEqual(grid.memberKeys);
    expect(rows[1]!.key).toBe("subagent-spawn:agent-0");
  });

  it("settles cards where they started, and never groups across other rows", () => {
    const rows = presentEvents([
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      started("a", "Scan A"),
      ev({ type: "text", text: "Spawned one, thinking.", turnId: "t1", itemId: "m1" }),
      started("b", "Scan B"),
      finished("a"),
      finished("b"),
      ev({ type: "text", text: "Both back.", turnId: "t1", itemId: "m2" }),
      started("c", "Scan C"),
      finished("c"),
    ]);
    // `a` settles above the interim text it was spawned before, so the text
    // still separates it from `b`.
    expect(types(rows)).toEqual([
      "user_message",
      "subagent_result_card",
      "text",
      "subagent_result_card",
      "text",
      "subagent_result_card",
    ]);
    expect(rows.filter((row) => row.event.type === "subagent_result_card").map((row) => row.key))
      .toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
  });

  it("keeps 3 running cards one 3-card grid, in order, as 2 of them finish", () => {
    const spawns = [
      ev({ type: "user_message", text: "dig in with parallel agents", turnId: "t1" }),
      started("a", "Desktop architecture map"),
      started("b", "Sync and shared contracts"),
      started("c", "CLI and brain map"),
    ];
    const before = presentEvents(spawns);
    const after = presentEvents([...spawns, finished("b"), finished("c")]);
    expect(types(after)).toEqual(["user_message", "subagent_card_grid"]);
    const grid = gridOf(after[1]);
    // Same row key, same member keys, same order: only the states changed.
    expect(after[1]!.key).toBe(before[1]!.key);
    expect(grid.memberKeys).toEqual(gridOf(before[1]).memberKeys);
    expect(grid.memberKeys).toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
    expect(grid.members.map((member) => [member.event.type, member.event.status])).toEqual([
      ["subagent_spawn_anchor", "running"],
      ["subagent_result_card", "completed"],
      ["subagent_result_card", "completed"],
    ]);
  });

  it("mixes running, finished, failed, and stopped cards in one grid", () => {
    const rows = presentEvents([
      started("a", "Scan A"),
      started("b", "Scan B"),
      started("c", "Scan C"),
      started("d", "Scan D"),
      finished("a"),
      ev({ type: "subagent_result", taskId: "c", agentId: "c", status: "failed", summary: "boom", turnId: "t1" }),
      ev({
        type: "subagent_result",
        taskId: "d",
        agentId: "d",
        status: "stopped",
        summary: "Interrupted",
        stopSource: "user",
        turnId: "t1",
      }),
    ]);
    expect(types(rows)).toEqual(["subagent_card_grid"]);
    expect(gridOf(rows[0]).members.map((member) => member.event.status))
      .toEqual(["completed", "running", "failed", "stopped"]);
  });

  it("keeps grids through a spawned-chat fan-out whose notices draw nothing", () => {
    const notice = (childId: string) => ev({
      type: "system_notice",
      noticeKind: "info",
      status: "subagent_spawned",
      message: `Subagent spawned: ${childId}`,
      detail: { hasInlineCard: true, spawnedSession: { sessionId: childId } },
    } as AgentChatEventEnvelope["event"]);
    const rows = presentEvents([
      notice("child-1"),
      started("chat:child-1", "Wave 1", { agentId: "child-1", spawnKind: "subagent" }),
      notice("child-2"),
      started("chat:child-2", "Wave 2", { agentId: "child-2", spawnKind: "subagent" }),
    ]);
    expect(types(rows)).toEqual(["system_notice", "system_notice", "subagent_card_grid"]);
    expect(gridOf(rows[2]).members).toHaveLength(2);
  });

  it("keeps grid keys stable when an older page is prepended", () => {
    const turn = [
      ev({ type: "user_message", text: "scan", turnId: "t2" }),
      started("a", "Scan A"),
      started("b", "Scan B"),
      finished("a"),
      finished("b"),
    ];
    const older = [
      ev({ type: "user_message", text: "earlier", turnId: "t0" }),
      ev({ type: "text", text: "Earlier answer.", turnId: "t0", itemId: "old-1" }),
      ev({ type: "done", turnId: "t0", status: "completed" }),
    ];
    const keys = (rows: ChatTranscriptGroupedEnvelope[]) => rows
      .filter((row) => row.event.type === "subagent_card_grid")
      .map((row) => row.key);
    expect(keys(presentEvents(turn))).toEqual(["subagent-spawn:a"]);
    expect(keys(presentEvents([...older, ...turn]))).toEqual(["subagent-spawn:a"]);
  });

  it("appends a result whose spawn is not loaded where it arrives, beside the loaded cards", () => {
    // `a` started in an older, unloaded page; only its result is in the window.
    const rows = presentEvents([
      started("b", "B"),
      started("c", "C"),
      finished("a"),
    ]);
    expect(types(rows)).toEqual(["subagent_card_grid"]);
    expect(gridOf(rows[0]).memberKeys).toEqual(["subagent-spawn:b", "subagent-spawn:c", "subagent-result:a"]);
    // Loading the older page replays `a` into its spawn slot instead.
    const full = presentEvents([started("a", "A"), started("b", "B"), started("c", "C"), finished("a")]);
    expect(gridOf(full[0]).memberKeys).toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
  });

  it("keeps the grid key and every member key while cards settle one by one", () => {
    const spawns = [started("a", "A"), started("b", "B"), started("c", "C")];
    const snapshots = [
      presentEvents(spawns),
      presentEvents([...spawns, finished("b")]),
      presentEvents([...spawns, finished("b"), finished("a")]),
      presentEvents([...spawns, finished("b"), finished("a"), finished("c")]),
    ];
    for (const rows of snapshots) {
      expect(rows.map((row) => row.key)).toEqual(["subagent-spawn:a"]);
      expect(gridOf(rows[0]).memberKeys).toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
    }
    expect(gridOf(snapshots[2]![0]).members.map((member) => member.event.status))
      .toEqual(["completed", "completed", "running"]);
  });

  it("returns the same array when nothing groups", () => {
    const rows = present(collapseChatTranscriptEvents([ev({ type: "text", text: "hi", itemId: "m" })]));
    expect(groupSubagentCardGrids(rows)).toBe(rows);
  });

  it("maps every member key, and its result-key alias, to the row that draws it", () => {
    const rows = presentEvents([started("a", "A"), started("b", "B"), finished("a"), finished("b")]);
    const map = subagentCardGridKeyByMemberKey(rows);
    expect(map.get("subagent-spawn:b")).toBe("subagent-spawn:a");
    expect(map.get("subagent-spawn:a")).toBe("subagent-spawn:a");
    // A jump to an old `subagent-result:` key lands on the card that settled in place.
    expect(map.get("subagent-result:b")).toBe("subagent-spawn:a");
    expect(map.get("subagent-result:a")).toBe("subagent-spawn:a");
  });

  it("maps a lone card's keys to its own row", () => {
    const rows = presentEvents([ev({ type: "user_message", text: "go", turnId: "t1" }), started("a", "A"), finished("a")]);
    const map = subagentCardGridKeyByMemberKey(rows);
    expect(map.get("subagent-spawn:a")).toBe("subagent-spawn:a");
    expect(map.get("subagent-result:a")).toBe("subagent-spawn:a");
  });

  it("estimates three columns on a wide column, dropping to two and one as it narrows", () => {
    expect(subagentCardGridColumns(1, 900)).toBe(1);
    expect(subagentCardGridColumns(2, 900)).toBe(2);
    expect(subagentCardGridColumns(3, 900)).toBe(3);
    expect(subagentCardGridColumns(5, 900)).toBe(3);
    expect(subagentCardGridColumns(3, 712)).toBe(3);
    expect(subagentCardGridColumns(3, 700)).toBe(2);
    expect(subagentCardGridColumns(3, 400)).toBe(1);
  });
});

describe("subagent card grids and the turn fold", () => {
  function fold(events: AgentChatEventEnvelope[], open: ReadonlySet<string> = new Set()) {
    const { rows, context } = collapseChatTranscriptEventsWithContext(events);
    const presented = present(rows);
    const folds = deriveChatTranscriptTurnFolds(presented, readTurnEndSnapshots(context));
    return { folds, presented, display: applyChatTranscriptTurnFolds(presented, folds, open) };
  }

  it("keeps a finished-card grid visible below the fold row and counts each agent", () => {
    const { folds, display } = fold([
      ev({ type: "user_message", text: "scan the codebase", turnId: "t1" }),
      ev({ type: "text", text: "Splitting the scan.", turnId: "t1", itemId: "m1" }),
      started("a", "/root/desktop_scan"),
      started("b", "/root/cli_tui_scan"),
      started("c", "/root/ios_shared_scan"),
      ev({ type: "reasoning", text: "Waiting on the agents.", turnId: "t1" }),
      finished("a"),
      finished("b"),
      finished("c"),
      ev({ type: "text", text: "All three scans are back.", turnId: "t1", itemId: "m2" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ]);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.subagentCount).toBe(3);
    expect(folds[0]!.keptKeys).toEqual(["subagent-spawn:a"]);
    expect(folds[0]!.hiddenKeys.has("subagent-spawn:a")).toBe(false);
    expect(types(display)).toEqual(["user_message", "turn_fold", "subagent_card_grid", "text", "done"]);
    expect(gridOf(display[2]).memberKeys).toEqual(["subagent-spawn:a", "subagent-spawn:b", "subagent-spawn:c"]);
  });

  it("keeps a still-running grid visible and settles late results in place, above the answer", () => {
    const turn = [
      ev({ type: "user_message", text: "background scan", turnId: "t1" }),
      ev({ type: "reasoning", text: "Spawning.", turnId: "t1" }),
      started("a", "Scan A", { background: true }),
      started("b", "Scan B", { background: true }),
      ev({ type: "text", text: "Both scans are running in the background.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ];
    const live = fold(turn);
    expect(types(live.display)).toEqual(["user_message", "turn_fold", "subagent_card_grid", "text", "done"]);
    expect(gridOf(live.display[2]).members.map((member) => member.event.status)).toEqual(["running", "running"]);

    // Both finish after the parent's `done`, the second during a later turn:
    // the same grid row updates in place, kept by the fold's sticky decision.
    const settled = fold([
      ...turn,
      finished("a"),
      ev({ type: "user_message", text: "next question", turnId: "t2" }),
      finished("b"),
    ]);
    expect(types(settled.display)).toEqual([
      "user_message",
      "turn_fold",
      "subagent_card_grid",
      "text",
      "done",
      "user_message",
    ]);
    expect(settled.display[2]!.key).toBe(live.display[2]!.key);
    expect(gridOf(settled.display[2]).members.map((member) => member.event.status)).toEqual(["completed", "completed"]);
    expect(settled.folds[0]!.keptKeys).toEqual(live.folds[0]!.keptKeys);
  });
});
