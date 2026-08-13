import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../../desktop/src/shared/types/attention";
import { ATTENTION_CONTRACT_VERSION } from "../../../../desktop/src/shared/types/attention";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { TuiChatSessionSummary } from "../adeApi";
import {
  buildWorkListModel,
  foreignRowsFromAttention,
  resolveWorkListSelection,
  stepWorkListSelection,
  thisMachineKeyFromItems,
  workListSelectionCopyText,
  type WorkListSessionRow,
  type WorkListShelfKind,
} from "../workListModel";
import { getPreviewLine, partitionQuietSessions, toWorkSessionSummary } from "../workRow";

const NOW = Date.parse("2026-05-12T12:00:00.000Z");

function lane(id: string, name: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `feature/${id}`,
    worktreePath: `/tmp/${id}`,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Partial<TuiChatSessionSummary> & { sessionId: string; laneId: string }): TuiChatSessionSummary {
  return {
    provider: "claude",
    model: "claude-code",
    title: "A chat",
    status: "idle",
    startedAt: "2026-05-12T11:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-05-12T11:50:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  } as TuiChatSessionSummary;
}

function build(args: Parameters<typeof buildWorkListModel>[0]) {
  return buildWorkListModel({ nowMs: NOW, ...args });
}

function sessionRows(model: ReturnType<typeof buildWorkListModel>): WorkListSessionRow[] {
  return model.rows.filter((row): row is WorkListSessionRow => row.kind === "session");
}

function attentionItem(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    revision: 1,
    fingerprint: overrides.id,
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: { machineKey: "mac-b", name: "Studio", online: true, lastSeenAt: null },
    project: { projectId: "uuid-b", canonicalId: "project_abc", name: "ADE" },
    title: "Remote chat",
    preview: "building",
    privacyPreview: "",
    destination: { kind: "session", sessionId: "remote-1" },
    actions: [],
    occurredAt: "2026-05-12T11:00:00.000Z",
    updatedAt: "2026-05-12T11:55:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...overrides,
  } as AttentionItem;
}

describe("workListModel grouping", () => {
  it("renders a singleton lane as one card with lane identity, not a header plus divider", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature"), lane("lane-2", "Fix")],
      sessions: [
        session({ sessionId: "chat-a", laneId: "lane-1", title: "Alpha" }),
        session({ sessionId: "chat-b", laneId: "lane-2", title: "Beta" }),
      ],
      activeSessionId: null,
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "session:chat-a",
      "session:chat-b",
    ]);
    expect(model.rows.every((row) => row.kind === "session" && row.showLaneIdentity)).toBe(true);
    expect(model.groups).toHaveLength(2);
    expect(model.groups[0]!.header.sessionCount).toBe(1);
    expect(model.rows.some((row) => row.kind === "new-chat")).toBe(false);
  });

  it("keeps a lane header when the lane has more than one live chat", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature", { color: "#dc2626", icon: "star" })],
      sessions: [
        session({ sessionId: "chat-a", laneId: "lane-1", title: "Alpha" }),
        session({ sessionId: "chat-b", laneId: "lane-1", title: "Beta" }),
      ],
      activeSessionId: null,
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "lane:lane-1",
      "session:chat-a",
      "session:chat-b",
    ]);
    expect(model.groups[0]!.header.icon).toBe("star");
    expect(model.groups[0]!.header.color).toBe("#dc2626");
    expect(model.rows.filter((row) => row.kind === "session").every((row) => !row.showLaneIdentity)).toBe(true);
  });

  it("orders chats inside a lane by last activity, then session id, so the list does not shuffle", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [
        session({ sessionId: "chat-old", laneId: "lane-1", title: "Old", lastActivityAt: "2026-05-12T10:00:00.000Z" }),
        session({ sessionId: "chat-new", laneId: "lane-1", title: "New", lastActivityAt: "2026-05-12T11:59:00.000Z" }),
        session({ sessionId: "chat-mid", laneId: "lane-1", title: "Mid", lastActivityAt: "2026-05-12T11:00:00.000Z" }),
      ],
      activeSessionId: null,
    });

    expect(model.rows.filter((row) => row.kind === "session").map((row) => row.sessionId)).toEqual([
      "chat-new",
      "chat-mid",
      "chat-old",
    ]);
  });

  it("orders lanes by most recent session activity, primary lane always first", () => {
    const model = build({
      lanes: [
        lane("lane-quiet", "Quiet"),
        lane("lane-busy", "Busy"),
        lane("lane-main", "main", { laneType: "primary" }),
      ],
      sessions: [
        session({ sessionId: "old", laneId: "lane-quiet", lastActivityAt: "2026-05-12T08:00:00.000Z" }),
        session({ sessionId: "new", laneId: "lane-busy", lastActivityAt: "2026-05-12T11:59:00.000Z" }),
      ],
      activeSessionId: null,
    });

    const laneOrder = model.groups.map((group) => group.header.laneId);
    expect(laneOrder).toEqual(["lane-main", "lane-busy", "lane-quiet"]);
    // A lane with no live sessions is the quiet tier, and sorts below both.
    expect(model.groups[0]!.header.tier).toBe("quiet");
    expect(model.groups[1]!.header.tier).toBe("active");
  });

  it("drops the new-chat row for a lane whose worktree is gone, and marks the header", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [],
      activeSessionId: null,
      unavailableLaneIds: new Set(["lane-1"]),
    });

    expect(model.rows.map((row) => row.kind)).toEqual(["lane-header"]);
    expect(model.groups[0]!.header.worktreeAvailable).toBe(false);
  });

  it("never emits a per-lane new-chat row", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({ sessionId: "chat-a", laneId: "lane-1" })],
      activeSessionId: null,
      hideNewChat: true,
    });

    expect(model.rows.some((row) => row.kind === "new-chat")).toBe(false);
  });
});

describe("workListModel shelves", () => {
  const lanes = [lane("lane-1", "Feature")];
  const sessions = [
    session({ sessionId: "chat-live", laneId: "lane-1", title: "Live" }),
    session({
      sessionId: "chat-snoozed",
      laneId: "lane-1",
      title: "Snoozed",
      snoozedUntil: new Date(NOW + 3 * 60 * 60_000).toISOString(),
      snoozedAt: new Date(NOW - 60_000).toISOString(),
    }),
    session({
      sessionId: "chat-settled",
      laneId: "lane-1",
      title: "Settled",
      settledAt: "2026-05-12T11:30:00.000Z",
    }),
  ];

  it("files quiet rows behind collapsed shelves and keeps them out of the lane group", () => {
    const model = build({ lanes, sessions, activeSessionId: null });

    expect(model.rows.map((row) => row.key)).toEqual([
      "session:chat-live",
      "shelf:snoozed",
      "shelf:settled",
    ]);
    expect(model.snoozed.map((row) => row.sessionId)).toEqual(["chat-snoozed"]);
    expect(model.settled.map((row) => row.sessionId)).toEqual(["chat-settled"]);
  });

  it("does not leave a settled-only lane name in the inbox above the shelf", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature"), lane("lane-quiet", "Quiet")],
      sessions: [
        session({ sessionId: "chat-live", laneId: "lane-1", title: "Live" }),
        session({
          sessionId: "chat-done",
          laneId: "lane-quiet",
          title: "Done",
          settledAt: "2026-05-12T11:30:00.000Z",
        }),
      ],
      activeSessionId: null,
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "session:chat-live",
      "shelf:settled",
    ]);
  });

  it("renders a settled singleton inside the shelf with lane identity, not a second header", () => {
    const model = build({
      lanes: [lane("lane-quiet", "Quiet", { color: "#dc2626", icon: "star" })],
      sessions: [
        session({
          sessionId: "chat-done",
          laneId: "lane-quiet",
          title: "Done",
          settledAt: "2026-05-12T11:30:00.000Z",
        }),
      ],
      activeSessionId: null,
      expandedShelves: new Set<WorkListShelfKind>(["settled"]),
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "shelf:settled",
      "session:chat-done",
    ]);
    const card = model.rows.find((row): row is WorkListSessionRow => row.kind === "session");
    expect(card?.showLaneIdentity).toBe(true);
    expect(card?.laneName).toBe("Quiet");
    expect(card?.laneIcon).toBe("star");
  });

  it("expands a shelf in place when it is open", () => {
    const model = build({
      lanes,
      sessions,
      activeSessionId: null,
      expandedShelves: new Set<WorkListShelfKind>(["settled"]),
    });

    const keys = model.rows.map((row) => row.key);
    expect(keys).toContain("session:chat-settled");
    expect(keys.indexOf("session:chat-settled")).toBe(keys.indexOf("shelf:settled") + 1);
    expect(keys).not.toContain("session:chat-snoozed");
  });

  it("uses the same filing rule the copied desktop partition uses", () => {
    const summaries = sessions.map((entry) => toWorkSessionSummary(entry, "Feature"));
    const partition = partitionQuietSessions(summaries, NOW);

    expect(partition.snoozed.map((entry) => entry.id)).toEqual(["chat-snoozed"]);
    expect(partition.settled.map((entry) => entry.id)).toEqual(["chat-settled"]);
    expect(partition.active.map((entry) => entry.id)).toEqual(["chat-live"]);
  });
});

describe("workListModel status", () => {
  it("lets a raised hand outrank a live snooze — a needs-you row is never buried", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [
        session({
          sessionId: "chat-ask",
          laneId: "lane-1",
          title: "Blocked",
          snoozedUntil: new Date(NOW + 5 * 60 * 60_000).toISOString(),
          snoozedAt: new Date(NOW - 60_000).toISOString(),
          attentionRequestedAt: "2026-05-12T11:55:00.000Z",
          attentionMessage: "Which account?",
        }),
      ],
      activeSessionId: null,
    });

    const [row] = sessionRows(model);
    expect(row!.filing).toBe("awaiting-input");
    expect(row!.status?.label).toBe("Needs you");
    expect(row!.tone).toBe("amber");
    expect(model.snoozed).toHaveLength(0);
  });

  it("labels a snoozed row with its return ticket and marks it 'z' in plain text", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [
        session({
          sessionId: "chat-snoozed",
          laneId: "lane-1",
          snoozedUntil: new Date(NOW + 3 * 60 * 60_000).toISOString(),
          snoozedAt: new Date(NOW - 60_000).toISOString(),
        }),
      ],
      activeSessionId: null,
      expandedShelves: new Set<WorkListShelfKind>(["snoozed"]),
    });

    const [row] = sessionRows(model);
    expect(row!.status?.label).toBe("wakes in 3h");
    expect(row!.marker).toBe("z");
    expect(row!.tone).toBe("neutral");
  });

  it("gives a settled row no status word at all — a timestamp and 'done' instead", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [
        session({
          sessionId: "chat-settled",
          laneId: "lane-1",
          settledAt: "2026-05-12T11:30:00.000Z",
          statusNote: "PR merged",
        }),
      ],
      activeSessionId: null,
      expandedShelves: new Set<WorkListShelfKind>(["settled"]),
    });

    const [row] = sessionRows(model);
    expect(row!.status).toBeNull();
    expect(row!.timestampLabel).not.toBe("");
    expect(row!.marker).toBe("done");
    expect(row!.preview?.text).toBe("done: PR merged");
  });

  it("shows a live turn's elapsed from the TURN anchor, not from its last output", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [
        session({
          sessionId: "chat-running",
          laneId: "lane-1",
          status: "active",
          runtimeState: "running",
          toolType: "claude",
          currentTurnStartedAt: new Date(NOW - 8 * 60_000).toISOString(),
          lastActivityAt: new Date(NOW - 2_000).toISOString(),
        }),
      ],
      activeSessionId: "chat-running",
    });

    const [row] = sessionRows(model);
    expect(row!.status?.label).toBe("Working");
    expect(row!.elapsedLabel).toBe("8m");
    expect(row!.isActiveSession).toBe(true);
  });
});

describe("getPreviewLine priority", () => {
  const base = { sessionId: "chat-p", laneId: "lane-1" };

  it("prefers an outstanding ask over everything else", () => {
    const summary = toWorkSessionSummary(session({
      ...base,
      title: "Chat",
      attentionRequestedAt: "2026-05-12T11:55:00.000Z",
      attentionMessage: "Which account?",
      statusNote: "note",
      lastOutputPreview: "output",
      summary: "summary",
      goal: "goal",
    }));
    expect(getPreviewLine(summary, "Chat", false)).toMatchObject({ text: "Which account?", source: "ask" });
  });

  it("falls through note → output → summary → goal, and never repeats the title", () => {
    const withNote = toWorkSessionSummary(session({ ...base, statusNote: "note", lastOutputPreview: "output" }));
    expect(getPreviewLine(withNote, "Chat", false)).toMatchObject({ text: "note", source: "note" });

    const withOutput = toWorkSessionSummary(session({ ...base, lastOutputPreview: "[32mtests green[0m", summary: "summary" }));
    expect(getPreviewLine(withOutput, "Chat", false)).toMatchObject({ text: "tests green", source: "output" });

    const withSummary = toWorkSessionSummary(session({ ...base, summary: "Ship the fix", goal: "goal text" }));
    expect(getPreviewLine(withSummary, "Chat", false)).toMatchObject({ text: "Ship the fix", source: "summary" });

    const withGoal = toWorkSessionSummary(session({ ...base, goal: "Land ADE-1" }));
    expect(getPreviewLine(withGoal, "Chat", false)).toMatchObject({ text: "Land ADE-1", source: "goal" });

    const echo = toWorkSessionSummary(session({ ...base, lastOutputPreview: "Chat" }));
    expect(getPreviewLine(echo, "Chat", false)).toBeNull();
  });

  it("prefixes the note with 'done: ' once the row is settled", () => {
    const summary = toWorkSessionSummary(session({ ...base, statusNote: "PR merged" }));
    expect(getPreviewLine(summary, "Chat", true)?.text).toBe("done: PR merged");
  });
});

describe("cross-machine rows", () => {
  const localIds = new Set(["local-1"]);

  it("keeps only agent rows for this project on other machines", () => {
    const rows = foreignRowsFromAttention({
      items: [
        attentionItem({ id: "a" }),
        attentionItem({ id: "b", project: { projectId: "x", canonicalId: "project_other", name: "Other" } }),
        attentionItem({ id: "c", kind: "pull_request", destination: { kind: "pull_request", number: 3, tab: "overview" } }),
        // Establishes mac-a as THIS machine (it published a local session)…
        attentionItem({
          id: "d",
          machine: { machineKey: "mac-a", name: "Laptop", online: true, lastSeenAt: null },
          destination: { kind: "session", sessionId: "local-1" },
        }),
        // …so its other rows are ours too, even ones we have not projected yet.
        attentionItem({
          id: "e",
          machine: { machineKey: "mac-a", name: "Laptop", online: true, lastSeenAt: null },
          destination: { kind: "session", sessionId: "not-yet-listed" },
        }),
      ],
      projectCanonicalId: "project_abc",
      localSessionIds: new Set([...localIds]),
    });

    expect(rows.map((row) => row.sessionId)).toEqual(["remote-1"]);
    expect(rows[0]!.machine.name).toBe("Studio");
  });

  it("never renders a local session as a remote row, even before machine identity is known", () => {
    const rows = foreignRowsFromAttention({
      items: [attentionItem({ id: "a", destination: { kind: "session", sessionId: "local-1" } })],
      projectCanonicalId: "project_abc",
      localSessionIds: localIds,
    });
    expect(rows).toEqual([]);
  });

  it("infers this machine from the items that point at local sessions", () => {
    const items = [
      attentionItem({
        id: "mine",
        machine: { machineKey: "mac-a", name: "Laptop", online: true, lastSeenAt: null },
        destination: { kind: "session", sessionId: "local-1" },
      }),
      attentionItem({ id: "theirs" }),
    ];
    expect(thisMachineKeyFromItems(items, localIds)).toBe("mac-a");

    const rows = foreignRowsFromAttention({
      items,
      projectCanonicalId: "project_abc",
      localSessionIds: localIds,
    });
    expect(rows.map((row) => row.machine.machineKey)).toEqual(["mac-b"]);
  });

  it("joins a foreign row to a local lane by NAME, and falls back to a machine group", () => {
    const model = build({
      lanes: [lane("lane-1", "Feature")],
      sessions: [session({ sessionId: "chat-a", laneId: "lane-1" })],
      activeSessionId: null,
      foreign: foreignRowsFromAttention({
        items: [
          attentionItem({ id: "matched", laneName: "feature", destination: { kind: "session", sessionId: "remote-matched" } }),
          attentionItem({ id: "orphan", laneName: "Unknown lane", destination: { kind: "session", sessionId: "remote-orphan" } }),
        ],
        projectCanonicalId: "project_abc",
        localSessionIds: new Set(["chat-a"]),
      }),
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "lane:lane-1",
      "foreign:mac-b:remote-matched",
      "session:chat-a",
      "foreign:mac-b:remote-orphan",
    ]);
    const machineHeader = model.groups[1]!.header;
    expect(machineHeader.label).toBe("Studio");
    expect(machineHeader.lastSeenLabel).toBeNull();
    expect(model.rows.some((row) => row.kind === "new-chat")).toBe(false);
  });

  it("dims an offline machine group and keeps its last-known status", () => {
    const model = build({
      lanes: [],
      sessions: [],
      activeSessionId: null,
      foreign: foreignRowsFromAttention({
        items: [attentionItem({
          id: "offline",
          machine: { machineKey: "mac-c", name: "Desk", online: false, lastSeenAt: new Date(NOW - 2 * 60 * 60_000).toISOString() },
        })],
        projectCanonicalId: "project_abc",
        localSessionIds: new Set(),
      }),
    });

    const header = model.groups[0]!.header;
    expect(header.machine?.online).toBe(false);
    expect(header.lastSeenLabel).toMatch(/^last seen /);
    const [row] = sessionRows(model);
    expect(row!.machine?.machineKey).toBe("mac-c");
    expect(row!.status?.label).toBe("Working");
  });
});

describe("selection", () => {
  const model = build({
    lanes: [lane("lane-1", "Feature")],
    sessions: [
      session({ sessionId: "chat-a", laneId: "lane-1", title: "Alpha" }),
      session({ sessionId: "chat-b", laneId: "lane-1", title: "Beta" }),
    ],
    activeSessionId: "chat-b",
  });

  it("leaves a still-valid selection alone", () => {
    expect(resolveWorkListSelection({
      rows: model.rows,
      selectedKey: "session:chat-a",
      activeSessionId: "chat-b",
    })).toBeNull();
  });

  it("falls back to the open chat, then to the first session row", () => {
    expect(resolveWorkListSelection({
      rows: model.rows,
      selectedKey: "session:gone",
      activeSessionId: "chat-b",
    })).toEqual({ selectedKey: "session:chat-b" });

    expect(resolveWorkListSelection({
      rows: model.rows,
      selectedKey: null,
      activeSessionId: null,
    })).toEqual({ selectedKey: "session:chat-a" });
  });

  it("falls back to the draft lane's header when the current key is gone", () => {
    expect(resolveWorkListSelection({
      rows: model.rows,
      selectedKey: "new-chat:lane-1",
      activeSessionId: null,
      draftLaneId: "lane-1",
    })).toEqual({ selectedKey: "lane:lane-1" });
  });

  it("steps linearly through every visible row and clamps at both ends", () => {
    const keys = model.rows.map((row) => row.key);
    expect(stepWorkListSelection(model.rows, keys[0]!, 1)).toBe(keys[1]);
    expect(stepWorkListSelection(model.rows, keys[0]!, -1)).toBe(keys[0]);
    expect(stepWorkListSelection(model.rows, keys[keys.length - 1]!, 1)).toBe(keys[keys.length - 1]);
  });

  it("copies the selected session's title, and nothing for a non-session row", () => {
    expect(workListSelectionCopyText(model.rows, "session:chat-a")).toBe("Alpha");
    expect(workListSelectionCopyText(model.rows, "lane:lane-1")).toBeNull();
  });
});
