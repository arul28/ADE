import { describe, expect, it, vi } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";
import {
  createStaleRunSweep,
  STALE_RUN_SWEEP_SESSIONS_PER_PASS,
  type StaleRunSweepChatRow,
  type StaleRunSweepManagedSession,
} from "./chatStaleRunSweep";

type FakeManaged = StaleRunSweepManagedSession & { session: { id: string }; runtime: unknown; closed?: boolean };

function envelope(sessionId: string, sequence: number, event: AgentChatEvent): AgentChatEventEnvelope {
  return { sessionId, timestamp: "2026-09-18T02:00:00.000Z", sequence, event } as AgentChatEventEnvelope;
}

/** One still-open background command and one still-"running" subagent row. */
function orphanTranscript(sessionId: string, subagentTaskId = "sub-1"): AgentChatEventEnvelope[] {
  return [
    envelope(sessionId, 1, {
      type: "scheduled_work_update",
      id: "background:bg-1",
      kind: "background_task",
      status: "running",
      origin: "background_task",
      title: "npm run serve",
      summary: "shell",
      sourceTaskId: "bg-1",
      turnId: "turn-old",
    } as AgentChatEvent),
    envelope(sessionId, 2, {
      type: "subagent_started",
      taskId: subagentTaskId,
      agentId: subagentTaskId,
      agentType: "Explore",
      parentToolUseId: "toolu_1",
      description: "look",
      turnId: "turn-old",
    } as unknown as AgentChatEvent),
  ];
}

function harness(overrides: {
  transcripts?: Record<string, AgentChatEventEnvelope[]>;
  chatRows?: Record<string, StaleRunSweepChatRow>;
  deferChildTerminal?: (childSessionId: string) => boolean;
  ownerLive?: (sessionId: string) => boolean;
  adoptable?: (sessionId: string) => boolean;
  managed?: Record<string, Partial<FakeManaged>>;
  /** Make materializing a chat fail, the way a corrupt/unreadable session does. */
  ensureError?: (sessionId: string) => Error | null;
  /** Fired only when a managed session is newly created for a chat. */
  onEnsureManagedSession?: (sessionId: string) => void;
  now?: () => number;
} = {}) {
  const transcripts = overrides.transcripts ?? {};
  const transcriptReads: string[] = [];
  const emitted: { sessionId: string; event: AgentChatEvent }[] = [];
  const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
  const managedSessions = new Map<string, FakeManaged>();
  const ensureManagedSession = vi.fn((sessionId: string): FakeManaged => {
    const error = overrides.ensureError?.(sessionId);
    if (error) throw error;
    const existing = managedSessions.get(sessionId);
    if (existing) return existing;
    const created: FakeManaged = {
      session: { id: sessionId },
      runtime: null,
      ...(overrides.managed?.[sessionId] ?? {}),
    };
    managedSessions.set(sessionId, created);
    overrides.onEnsureManagedSession?.(sessionId);
    return created;
  });
  const chatRuntimeAdoptable = vi.fn((sessionId: string) => overrides.adoptable?.(sessionId) ?? true);
  const persistChatState = vi.fn();

  const sweep = createStaleRunSweep<FakeManaged>({
    readFullTranscriptEnvelopesForSessionId: (sessionId) => {
      transcriptReads.push(sessionId);
      return transcripts[sessionId] ?? [];
    },
    listChatSessionIds: () => Object.keys(transcripts),
    getChatSessionRow: (sessionId) => overrides.chatRows?.[sessionId] ?? null,
    ...(overrides.deferChildTerminal ? { deferChildTerminal: overrides.deferChildTerminal } : {}),
    chatRuntimeOwnerLive: (sessionId) => overrides.ownerLive?.(sessionId) ?? false,
    chatRuntimeAdoptable,
    peekManagedSession: (sessionId) => managedSessions.get(sessionId),
    ensureManagedSession,
    liveRuntimeSessionIds: () => [...managedSessions].filter(([, m]) => m.runtime).map(([id]) => id),
    restartRecoveryStopAttribution: () => ({ stopSource: "system", stopReason: "the ADE brain restarted" }),
    emitChatEvent: (managed, event) => emitted.push({ sessionId: managed.session.id, event }),
    emitScheduledWorkUpdate: (managed, event) => emitted.push({ sessionId: managed.session.id, event }),
    persistChatState,
    logger: { info: () => {}, warn: (message, meta) => warnings.push({ message, meta }) },
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  return {
    sweep,
    emitted,
    warnings,
    managedSessions,
    ensureManagedSession,
    chatRuntimeAdoptable,
    persistChatState,
    transcriptReads,
  };
}

const results = (emitted: { event: AgentChatEvent }[]) =>
  emitted.filter((entry) => entry.event.type === "subagent_result").map((entry) => entry.event as any);
const scheduled = (emitted: { event: AgentChatEvent }[]) =>
  emitted.filter((entry) => entry.event.type === "scheduled_work_update").map((entry) => entry.event as any);

describe("terminalizeStaleRowsForSession", () => {
  it("closes background and subagent rows with the caller's attribution", () => {
    const sessionId = "chat-1";
    const { sweep, emitted, persistChatState } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId) },
    });

    const outcome = sweep.terminalizeStaleRowsForSession(
      { session: { id: sessionId }, runtime: null },
      { stopSource: "foreign-brain", stopReason: "another ADE brain took over this chat" },
    );

    expect(outcome).toEqual({ backgroundStopped: 1, subagentsTerminalized: 1, subagentsLeftRunning: 0 });
    expect(scheduled(emitted)[0]).toMatchObject({
      id: "background:bg-1",
      status: "stopped",
      stopSource: "foreign-brain",
      turnId: "turn-old",
    });
    expect(results(emitted)[0]).toMatchObject({
      taskId: "sub-1",
      status: "stopped",
      stopSource: "foreign-brain",
      stopReason: "another ADE brain took over this chat",
    });
    expect(persistChatState).toHaveBeenCalledTimes(1);
  });

  it("never closes a subagent whose result already landed, even after a late progress echo", () => {
    const sessionId = "chat-ended";
    const { sweep, emitted } = harness({
      transcripts: {
        [sessionId]: [
          ...orphanTranscript(sessionId).slice(1),
          envelope(sessionId, 3, {
            type: "subagent_result",
            taskId: "sub-1",
            agentId: "sub-1",
            status: "completed",
            summary: "Found one IPC guard gap.",
            turnId: "turn-old",
          } as AgentChatEvent),
          // Codex echoes the activity item after the child's turn completed.
          envelope(sessionId, 4, {
            type: "subagent_progress",
            taskId: "sub-1",
            agentId: "sub-1",
            parentToolUseId: "subagent-completed-child-turn",
            description: "look",
            summary: "Agent active",
            turnId: "turn-old",
          } as AgentChatEvent),
        ],
      },
    });

    const outcome = sweep.terminalizeStaleRowsForSession(
      { session: { id: sessionId }, runtime: null },
      { stopSource: "system", stopReason: "the ADE brain restarted" },
    );

    expect(outcome).toEqual({ backgroundStopped: 0, subagentsTerminalized: 0, subagentsLeftRunning: 0 });
    expect(results(emitted)).toEqual([]);
  });

  it("leaves a card whose child another path terminalizes (a tracked CLI child) instead of calling it gone", () => {
    const sessionId = "chat-cli-parent";
    const deferred: string[] = [];
    const { sweep, emitted } = harness({
      transcripts: {
        [sessionId]: [envelope(sessionId, 1, {
          type: "subagent_started",
          taskId: "chat:cli-child-1",
          agentId: "cli-child-1",
          agentType: "codex",
          parentToolUseId: null,
          description: "Fix flaky tests",
          taskType: "subagent",
        } as unknown as AgentChatEvent)],
      },
      deferChildTerminal: (childSessionId) => {
        deferred.push(childSessionId);
        return childSessionId === "cli-child-1";
      },
    });

    const outcome = sweep.terminalizeStaleRowsForSession(
      { session: { id: sessionId }, runtime: null },
      { stopSource: "system", stopReason: "the ADE brain restarted" },
    );

    expect(deferred).toEqual(["cli-child-1"]);
    expect(results(emitted)).toEqual([]);
    expect(outcome).toEqual({ backgroundStopped: 0, subagentsTerminalized: 0, subagentsLeftRunning: 1 });
  });

  it("emits nothing for a chat whose transcript holds no open rows", () => {
    const sessionId = "chat-clean";
    const { sweep, emitted } = harness({
      transcripts: {
        [sessionId]: [envelope(sessionId, 1, { type: "system_notice", noticeKind: "info", message: "seed" } as AgentChatEvent)],
      },
    });

    expect(sweep.terminalizeStaleRowsForSession(
      { session: { id: sessionId }, runtime: null },
      { stopSource: "system", stopReason: "the ADE brain restarted" },
    )).toEqual({ backgroundStopped: 0, subagentsTerminalized: 0, subagentsLeftRunning: 0 });
    expect(emitted).toHaveLength(0);
  });
});

describe("reconcileStaleRuns", () => {
  it("terminalizes a chat nobody reopened, exactly once across passes", () => {
    const sessionId = "chat-sweep";
    const { sweep, emitted } = harness({ transcripts: { [sessionId]: orphanTranscript(sessionId) } });

    sweep.reconcileStaleRuns();
    sweep.reconcileStaleRuns();

    expect(results(emitted)).toHaveLength(1);
    expect(scheduled(emitted)).toHaveLength(1);
    expect(results(emitted)[0]).toMatchObject({ status: "stopped", stopSource: "system" });
  });

  it("leaves a delegate whose own chat is still alive running, and keeps re-checking it", () => {
    const sessionId = "chat-parent";
    const childId = "child-1";
    let childRuntimeLive = true;
    let clock = 1_000_000;
    const { sweep, emitted } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId, `chat:${childId}`).slice(1) },
      chatRows: { [childId]: { id: childId, status: "running" } },
      ownerLive: (id) => id === childId && childRuntimeLive,
      now: () => clock,
    });

    sweep.reconcileStaleRuns();
    expect(results(emitted)).toHaveLength(0);

    // The delegate's brain dies. A session that was left running must not have
    // been retired as "swept", or nothing ever closes this row — it is only
    // sitting out its revisit delay.
    childRuntimeLive = false;
    clock += 60 * 60 * 1000;
    sweep.reconcileStaleRuns();

    expect(results(emitted)).toHaveLength(1);
    expect(results(emitted)[0]).toMatchObject({ taskId: `chat:${childId}`, status: "stopped" });
  });

  it("does not let a chat with a live delegate consume the per-pass budget on the next pass", () => {
    // Head-of-line starvation: a chat that can never be marked swept used to be
    // re-read (full transcript) on every pass and hold one of the eight slots
    // forever, so chats behind it in the scan window were never reached.
    const parentId = "chat-parent";
    const childId = "child-1";
    const orphanIds = Array.from(
      { length: STALE_RUN_SWEEP_SESSIONS_PER_PASS * 2 },
      (_unused, index) => `chat-orphan-${index}`,
    );
    const transcripts: Record<string, AgentChatEventEnvelope[]> = {
      [parentId]: orphanTranscript(parentId, `chat:${childId}`).slice(1),
    };
    for (const id of orphanIds) transcripts[id] = orphanTranscript(id);

    const { sweep, emitted, transcriptReads } = harness({
      transcripts,
      chatRows: { [childId]: { id: childId, status: "running" } },
      ownerLive: (id) => id === childId,
    });

    sweep.reconcileStaleRuns();
    expect(transcriptReads[0]).toBe(parentId);
    transcriptReads.length = 0;

    sweep.reconcileStaleRuns();

    expect(transcriptReads).not.toContain(parentId);
    expect(new Set(transcriptReads).size).toBe(STALE_RUN_SWEEP_SESSIONS_PER_PASS);
    // The first pass spent a slot on the parent; the second spends all eight on
    // chats it can actually close.
    expect(results(emitted)).toHaveLength(STALE_RUN_SWEEP_SESSIONS_PER_PASS * 2 - 1);
  });

  it("never emits into a chat a sibling brain claims while the sweep is mid-pass", () => {
    const sessionId = "chat-contended";
    const { sweep, emitted, ensureManagedSession } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId) },
      // Adoptable when the candidate list is built; a sibling brain has taken
      // the chat by the time the managed session exists.
      adoptable: () => ensureManagedSession.mock.calls.length === 0,
    });

    sweep.reconcileStaleRuns();

    expect(emitted).toHaveLength(0);
  });

  it("announces a foreign-owned chat once, not once per pass", () => {
    const sessionId = "chat-foreign";
    const { sweep, emitted, warnings, chatRuntimeAdoptable } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId) },
      adoptable: () => false,
    });

    sweep.reconcileStaleRuns();
    sweep.reconcileStaleRuns();
    sweep.reconcileStaleRuns();

    expect(emitted).toHaveLength(0);
    expect(warnings.filter((entry) => entry.message === "agent_chat.stale_run_sweep_skipped_foreign_owner"))
      .toHaveLength(1);
    // ...and the probe itself is asked to stay quiet, so the ownership warn
    // inside it does not fire per chat per minute either.
    expect(chatRuntimeAdoptable).toHaveBeenCalledWith(sessionId, { quiet: true });
  });

  it("re-examines a chat a sibling brain claims mid-pass on a later pass", () => {
    const sessionId = "chat-contended-then-free";
    // The chat is free when the candidate list is built and claimed by the time
    // the managed session exists — the exact window the post-ensure re-ask
    // guards. Driven off the sibling's own state, not a call counter, so the
    // test keeps meaning the same thing if the sweep re-asks a different number
    // of times.
    let siblingHoldsChat = false;
    const { sweep, emitted } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId) },
      onEnsureManagedSession: () => {
        siblingHoldsChat = true;
      },
      adoptable: () => !siblingHoldsChat,
    });

    sweep.reconcileStaleRuns();
    expect(emitted).toHaveLength(0);

    // The sibling let go. The first pass decided nothing about this chat, so it
    // must not have been retired: the rows are still open and this pass is the
    // one that heals them.
    siblingHoldsChat = false;
    sweep.reconcileStaleRuns();
    expect(results(emitted)).toHaveLength(1);
    expect(scheduled(emitted)).toHaveLength(1);
  });

  it("backs a chat it cannot materialize off instead of re-reading it every pass", () => {
    const sessionId = "chat-unmaterializable";
    const otherId = "chat-behind-it";
    let nowMs = 1_000;
    const { sweep, warnings, transcriptReads, emitted } = harness({
      transcripts: {
        [sessionId]: orphanTranscript(sessionId),
        [otherId]: orphanTranscript(otherId),
      },
      ensureError: (id) => (id === sessionId ? new Error("session row is unreadable") : null),
      now: () => nowMs,
    });

    sweep.reconcileStaleRuns();
    // The throw is a failed look: warned once, and nothing of the chat retired.
    expect(warnings.filter((entry) => entry.message === "agent_chat.stale_run_reconcile_failed"))
      .toMatchObject([{ meta: { sessionId, error: "session row is unreadable" } }]);
    expect(emitted.filter((entry) => entry.sessionId === sessionId)).toHaveLength(0);

    // The revisit mark keeps it out of the next pass entirely — no slot spent,
    // and no full-transcript re-read to rediscover the same failure.
    const readsAfterFirst = transcriptReads.filter((id) => id === sessionId).length;
    nowMs += 1_000;
    sweep.reconcileStaleRuns();
    expect(transcriptReads.filter((id) => id === sessionId)).toHaveLength(readsAfterFirst);
  });

  it("bounds its bookkeeping map instead of growing it per chat forever", () => {
    // Foreign-owned chats are marked without spending the per-pass budget, so
    // they are the cheapest way to overrun the size guard (scan limit * 4).
    const transcripts: Record<string, AgentChatEventEnvelope[]> = {};
    for (let index = 0; index < 801; index += 1) transcripts[`chat-foreign-${index}`] = [];
    const { sweep, warnings } = harness({ transcripts, adoptable: () => false });

    sweep.reconcileStaleRuns();
    const afterFirst = warnings.filter(
      (entry) => entry.message === "agent_chat.stale_run_sweep_skipped_foreign_owner",
    ).length;
    expect(afterFirst).toBe(801);

    // The map was cleared at the end of that pass, so every chat is announced
    // again — the observable proof that the bookkeeping does not accumulate.
    sweep.reconcileStaleRuns();
    expect(
      warnings.filter((entry) => entry.message === "agent_chat.stale_run_sweep_skipped_foreign_owner").length,
    ).toBe(afterFirst * 2);
  });

  it("re-arms after dispose() so a restarted sweep still runs", () => {
    vi.useFakeTimers();
    try {
      const sessionId = "chat-restart";
      const { sweep, emitted } = harness({
        transcripts: { [sessionId]: orphanTranscript(sessionId) },
      });

      sweep.start();
      sweep.dispose();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(emitted).toHaveLength(0);

      sweep.start();
      vi.advanceTimersByTime(10 * 1000);
      expect(results(emitted)).toHaveLength(1);
      sweep.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a chat this brain is actively driving", () => {
    const sessionId = "chat-live";
    const { sweep, emitted, managedSessions } = harness({
      transcripts: { [sessionId]: orphanTranscript(sessionId) },
    });
    managedSessions.set(sessionId, { session: { id: sessionId }, runtime: { kind: "claude" } });

    sweep.reconcileStaleRuns();

    expect(emitted).toHaveLength(0);
  });
});
