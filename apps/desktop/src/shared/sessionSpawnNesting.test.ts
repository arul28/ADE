import { describe, expect, it } from "vitest";
import type { SpawnNestingSession } from "./sessionSpawnNesting";
import {
  attachedShellNestParentId,
  emptySpawnNestingIndex,
  groupAttachedShellsByParentId,
  indexNestedSubagents,
  isTopLevelWorkSession,
  nestedSubagentDrawerAttention,
  nestedSubagentSectionId,
  workNestingDrawers,
} from "./sessionSpawnNesting";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const NOW_ISO = "2026-09-21T12:00:00.000Z";

function sess(overrides: Partial<SpawnNestingSession> & Pick<SpawnNestingSession, "id">): SpawnNestingSession {
  return {
    laneId: "lane-a",
    status: "running",
    runtimeState: "running",
    toolType: "codex-chat",
    pendingInputItemId: null,
    attentionSource: null,
    lastOutputPreview: null,
    lastActivityAt: NOW_ISO,
    exitCode: null,
    settledAt: null,
    settleOverride: null,
    attentionRequestedAt: null,
    lastTurnFailedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    chatSessionId: null,
    spawnKind: undefined,
    orchestrationParentSessionId: undefined,
    startedAt: NOW_ISO,
    ...overrides,
  };
}

function settled(overrides: Partial<SpawnNestingSession> & Pick<SpawnNestingSession, "id">): SpawnNestingSession {
  return sess({
    status: "completed",
    runtimeState: "idle",
    settledAt: "2026-09-21T11:00:00.000Z",
    ...overrides,
  });
}

describe("indexNestedSubagents", () => {
  it("nests a same-lane subagent under its parent", () => {
    const parent = sess({ id: "parent" });
    const child = sess({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect([...index.nestedChildIds]).toEqual(["child"]);
    expect(index.nestedChildToRootParentId.get("child")).toBe("parent");
    expect(index.childrenByRootParentId.get("parent")?.map((s) => s.id)).toEqual(["child"]);
  });

  it("does not nest a peer", () => {
    const parent = sess({ id: "parent" });
    const peer = sess({
      id: "peer",
      spawnKind: "peer",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, peer], { nowMs: NOW });
    expect(index.nestedChildIds.size).toBe(0);
  });

  it("does not nest a cross-lane subagent", () => {
    const parent = sess({ id: "parent", laneId: "lane-a" });
    const child = sess({
      id: "child",
      laneId: "lane-b",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildIds.size).toBe(0);
  });

  it("flattens grandchildren into the root parent's drawer", () => {
    const root = sess({ id: "root" });
    const mid = sess({
      id: "mid",
      spawnKind: "subagent",
      orchestrationParentSessionId: "root",
    });
    const leaf = sess({
      id: "leaf",
      spawnKind: "subagent",
      orchestrationParentSessionId: "mid",
    });
    const index = indexNestedSubagents([root, mid, leaf], { nowMs: NOW });
    expect(index.nestedChildToRootParentId.get("mid")).toBe("root");
    expect(index.nestedChildToRootParentId.get("leaf")).toBe("root");
    expect(index.childrenByRootParentId.get("root")?.map((s) => s.id).sort()).toEqual(["leaf", "mid"]);
    expect(index.childrenByRootParentId.has("mid")).toBe(false);
  });

  it("promotes a working child when the parent is settled", () => {
    const parent = settled({ id: "parent" });
    const child = sess({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildIds.has("child")).toBe(false);
  });

  it("promotes a working child when the parent is snoozed", () => {
    const parent = sess({
      id: "parent",
      status: "completed",
      runtimeState: "idle",
      snoozedUntil: "2026-09-21T18:00:00.000Z",
      snoozedAt: "2026-09-21T11:00:00.000Z",
    });
    const child = sess({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildIds.has("child")).toBe(false);
  });

  it("keeps a settled child nested under a quiet parent", () => {
    const parent = settled({ id: "parent" });
    const child = settled({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildToRootParentId.get("child")).toBe("parent");
  });

  it("nests a settled child under an active parent", () => {
    const parent = sess({ id: "parent" });
    const child = settled({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildToRootParentId.get("child")).toBe("parent");
  });

  it("nests a grandchild under a pulled-up working mid parent, not the quiet root", () => {
    const root = settled({ id: "root" });
    const mid = sess({
      id: "mid",
      spawnKind: "subagent",
      orchestrationParentSessionId: "root",
    });
    const leaf = sess({
      id: "leaf",
      spawnKind: "subagent",
      orchestrationParentSessionId: "mid",
    });
    const index = indexNestedSubagents([root, mid, leaf], { nowMs: NOW });
    expect(index.nestedChildIds.has("mid")).toBe(false);
    expect(index.nestedChildToRootParentId.get("leaf")).toBe("mid");
  });

  it("surfaces children when the parent is not in the visible set", () => {
    const parent = sess({ id: "parent" });
    const child = sess({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], {
      nowMs: NOW,
      visibleParentIds: new Set(["child"]),
    });
    expect(index.nestedChildIds.has("child")).toBe(false);
  });

  it("does not hang on a parent cycle", () => {
    const a = sess({
      id: "a",
      spawnKind: "subagent",
      orchestrationParentSessionId: "b",
    });
    const b = sess({
      id: "b",
      spawnKind: "subagent",
      orchestrationParentSessionId: "a",
    });
    const index = indexNestedSubagents([a, b], { nowMs: NOW });
    expect(index.nestedChildIds.size).toBe(0);
  });

  it("nests a tracked CLI --type subagent the same way as a chat", () => {
    const parent = sess({ id: "parent" });
    const child = sess({
      id: "cli-child",
      toolType: "claude",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const index = indexNestedSubagents([parent, child], { nowMs: NOW });
    expect(index.nestedChildToRootParentId.get("cli-child")).toBe("parent");
  });
});

describe("attached shells of nested subagents", () => {
  it("remounts a nested child's shell onto the root parent", () => {
    const root = sess({ id: "root" });
    const mid = sess({
      id: "mid",
      spawnKind: "subagent",
      orchestrationParentSessionId: "root",
    });
    const shell = sess({
      id: "shell",
      toolType: "shell",
      chatSessionId: "mid",
    });
    const index = indexNestedSubagents([root, mid, shell], { nowMs: NOW });
    expect(attachedShellNestParentId(shell, index.nestedChildToRootParentId)).toBe("root");
    const shells = groupAttachedShellsByParentId(
      [root, mid, shell],
      index.nestedChildToRootParentId,
      new Set(["root", "mid", "shell"]),
    );
    expect(shells.get("root")?.map((s) => s.id)).toEqual(["shell"]);
    expect(shells.has("mid")).toBe(false);
  });
});

describe("isTopLevelWorkSession", () => {
  it("counts a parent plus nested swarm as one top-level unit", () => {
    const parent = sess({ id: "parent" });
    const child = sess({
      id: "child",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
    });
    const shell = sess({
      id: "shell",
      toolType: "shell",
      chatSessionId: "parent",
    });
    const roster = [parent, child, shell];
    const index = indexNestedSubagents(roster, { nowMs: NOW });
    const rosterIds = new Set(roster.map((s) => s.id));
    const topLevel = roster.filter((session) =>
      isTopLevelWorkSession(
        session,
        rosterIds,
        index.nestedChildIds,
        index.nestedChildToRootParentId,
      ),
    );
    expect(topLevel.map((s) => s.id)).toEqual(["parent"]);
  });
});

describe("nestedSubagentDrawerAttention", () => {
  it("prefers Failed over Needs you", () => {
    const needsYou = sess({
      id: "ask",
      attentionRequestedAt: NOW_ISO,
    });
    const failed = sess({
      id: "fail",
      lastTurnFailedAt: NOW_ISO,
    });
    expect(nestedSubagentDrawerAttention([needsYou, failed], NOW)).toBe("failed");
    expect(nestedSubagentDrawerAttention([needsYou], NOW)).toBe("needs_you");
    expect(nestedSubagentDrawerAttention([sess({ id: "ok" })], NOW)).toBe(null);
  });

  it("does not shout Failed for a usage-limit resume", () => {
    const parked = sess({
      id: "parked",
      lastTurnFailedAt: NOW_ISO,
      usageLimitResume: {
        state: "armed",
        provider: "claude",
        fireAt: "2026-09-21T13:00:00.000Z",
        resetAt: "2026-09-21T13:00:00.000Z",
        scheduleId: "auto-resume:parked",
        attempts: 1,
        providerDetail: null,
        turnId: "turn-1",
        updatedAt: NOW_ISO,
      },
    });
    expect(nestedSubagentDrawerAttention([parked], NOW)).toBe(null);
    expect(nestedSubagentDrawerAttention([{ ...parked, usageLimitResume: null }], NOW)).toBe("failed");
  });
});

describe("nestedSubagentSectionId", () => {
  it("is distinct from the shell drawer key", () => {
    expect(nestedSubagentSectionId("p1")).toBe("chat-subagents:p1");
  });
});

describe("emptySpawnNestingIndex", () => {
  it("returns a fresh map so later writes cannot poison other callers", () => {
    const first = emptySpawnNestingIndex();
    first.nestedChildIds.add("poison");
    first.childrenByRootParentId.set("p", []);
    const second = emptySpawnNestingIndex();
    expect(second.nestedChildIds.size).toBe(0);
    expect(second.childrenByRootParentId.size).toBe(0);
  });
});

describe("workNestingDrawers", () => {
  it("sorts nested children by startedAt then id", () => {
    const parent = sess({ id: "parent", startedAt: "2026-09-21T10:00:00.000Z" });
    const later = sess({
      id: "later",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
      startedAt: "2026-09-21T12:00:00.000Z",
    });
    const earlier = sess({
      id: "earlier",
      spawnKind: "subagent",
      orchestrationParentSessionId: "parent",
      startedAt: "2026-09-21T11:00:00.000Z",
    });
    const drawers = workNestingDrawers([parent, later, earlier], { nowMs: NOW });
    expect(drawers.subagentsByParentId.get("parent")?.map((s) => s.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect([...drawers.excludedTopLevelIds].sort()).toEqual(["earlier", "later"]);
  });
});
