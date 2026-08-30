import { describe, expect, it, vi } from "vitest";
import { createChatAutoResumeCoordinator } from "./chatAutoResumeCoordinator";
import type { ChatAutoResumeAnalyticsProperties } from "./chatAutoResumeCoordinator";
import type { ChatScheduledWorkRecord } from "./chatScheduledWorkScheduler";

/**
 * The per-chat streak the coordinator keeps is invisible from the chat service:
 * every user-driven dispatch clears it on its way to the provider, so only a
 * scheduler-fired resume can advance it and only these direct calls can show
 * that a record was dropped rather than merely reset.
 */
function createHarness() {
  const rows = new Map<string, ChatScheduledWorkRecord>();
  const notices: Array<{ sessionId: string; message: string }> = [];
  const captures: ChatAutoResumeAnalyticsProperties[] = [];
  const scheduler = {
    list: (sessionId: string) =>
      [...rows.values()].filter((row) => row.sessionId === sessionId),
    upsert: async (input: Partial<ChatScheduledWorkRecord> & { id: string; sessionId: string }) => {
      const row = {
        ...(rows.get(input.id) ?? {}),
        ...input,
        createdAt: rows.get(input.id)?.createdAt ?? Date.now(),
      } as ChatScheduledWorkRecord;
      rows.set(row.id, row);
      return row;
    },
    cancel: async (id: string) => {
      const row = rows.get(id);
      if (row) row.status = "cancelled";
      return row ?? null;
    },
  };
  const coordinator = createChatAutoResumeCoordinator({
    getScheduler: () => scheduler as never,
    whenSchedulerReady: () => Promise.resolve(),
    isSessionSchedulable: () => true,
    emitNotice: (sessionId, notice) => {
      notices.push({ sessionId, message: notice.message });
    },
    captureAnalytics: (properties) => {
      captures.push(properties);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
  });

  /** One usage-limit failure against an exact reset instant. */
  const failAtResetInstant = async (sessionId: string, resetAtMs: number): Promise<void> => {
    coordinator.maybeArmAfterUsageLimit({
      sessionId,
      provider: "codex",
      resetAtMs,
      error: { message: "You've hit your usage limit.", errorInfo: "usageLimitReached" },
    });
    // Arming is detached behind the scheduler wait; drain the microtasks it
    // parks on rather than reaching into the coordinator's internals.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** One usage-limit failure whose reset instant is `minutes` out. */
  const failAtUsageLimit = (sessionId: string, minutes: number): Promise<void> =>
    failAtResetInstant(sessionId, Date.now() + minutes * 60_000);

  return { coordinator, rows, notices, captures, failAtUsageLimit, failAtResetInstant };
}

describe("createChatAutoResumeCoordinator", () => {
  it("auto-resume state is dropped when the session ends", async () => {
    const { coordinator, notices, failAtUsageLimit } = createHarness();

    // Two failed arms without an intervening dispatch caps the chat.
    await failAtUsageLimit("chat-1", 30);
    await failAtUsageLimit("chat-1", 90);
    await failAtUsageLimit("chat-1", 150);
    expect(notices.filter((notice) => notice.message.startsWith("Auto-resume paused")))
      .toHaveLength(1);

    // The chat is archived or deleted. Nothing about the old streak may survive
    // it — including the record itself, which would otherwise be retained for
    // the life of the process for a chat that no longer exists.
    coordinator.forgetSession("chat-1");

    notices.length = 0;
    await failAtUsageLimit("chat-1", 210);
    expect(notices.map((notice) => notice.message))
      .toEqual([expect.stringContaining("Auto-resume scheduled for")]);
  });
});

/**
 * The workflow-outcome analytics. The product question is whether auto-resume
 * rescues a limited chat, which is only answerable if `armed`, `resumed` and
 * `paused` each count transitions rather than attempts — an event per retried
 * arm or per repeated failure would inflate exactly the ratio being read.
 */
describe("auto-resume analytics", () => {
  it("records one armed event per distinct arm and one paused event per capped streak", async () => {
    const { captures, failAtUsageLimit, failAtResetInstant } = createHarness();
    const reset = Date.now() + 30 * 60_000;

    // One failure can commit two error events (the provider notification and
    // the failed turn's completion) against the same reset instant. That is one
    // arm, so it must be one event.
    await failAtResetInstant("chat-1", reset);
    await failAtResetInstant("chat-1", reset);
    expect(captures).toEqual([{ action: "auto_resume", outcome: "armed", provider: "codex" }]);

    // A second, genuinely different window re-arms; the third failure is the
    // one the cap refuses, and it reports `paused` rather than a third `armed`.
    await failAtUsageLimit("chat-1", 90);
    await failAtUsageLimit("chat-1", 150);
    await failAtUsageLimit("chat-1", 210);
    expect(captures.map((capture) => capture.outcome)).toEqual([
      "armed",
      "armed",
      "paused",
    ]);
  });

  it("records one resumed event per fired resume, including after a restart", async () => {
    const { coordinator, captures, failAtUsageLimit } = createHarness();

    await failAtUsageLimit("chat-1", 30);
    captures.length = 0;

    coordinator.noteResumeTurnStarted("chat-1");
    // The scheduler will not deliver a second wake into a live turn, but a
    // repeated note about the same one must not double-count it either.
    coordinator.noteResumeTurnStarted("chat-1");
    expect(captures).toEqual([{ action: "auto_resume", outcome: "resumed", provider: "codex" }]);

    // The armed row is durable and outlives the process that wrote it. A resume
    // that fires with no in-memory record is still a rescue; dropping it would
    // make `resumed` look rarer than `armed` purely because ADE restarted.
    captures.length = 0;
    coordinator.noteResumeTurnStarted("chat-never-seen");
    expect(captures).toEqual([{ action: "auto_resume", outcome: "resumed" }]);
  });

  it("records nothing when ordinary user activity cancels the pending resume", async () => {
    const { coordinator, captures, failAtUsageLimit } = createHarness();

    await failAtUsageLimit("chat-1", 30);
    captures.length = 0;

    // `cancelForSession` runs on every user dispatch for every chat. Counting
    // it would measure typing rather than the workflow, and armed-minus-resumed
    // already answers the question it would.
    coordinator.cancelForSession("chat-1", "user_message");
    coordinator.noteScheduleDismissed("chat-1");
    coordinator.noteTurnFinished("chat-1");
    coordinator.forgetSession("chat-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captures).toEqual([]);
  });

  it("keeps session ids, reset instants, and provider error text out of the payload", async () => {
    const { coordinator, captures, failAtUsageLimit } = createHarness();

    await failAtUsageLimit("chat-secret-id", 30);
    coordinator.noteResumeTurnStarted("chat-secret-id");
    await failAtUsageLimit("chat-secret-id", 90);
    await failAtUsageLimit("chat-secret-id", 150);
    await failAtUsageLimit("chat-secret-id", 210);
    expect(captures.length).toBeGreaterThan(0);

    for (const capture of captures) {
      // A closed key set, not a bag: nothing that identifies the chat, the
      // limit, or what the user was doing may ride along.
      expect(Object.keys(capture).sort()).toEqual(
        capture.provider ? ["action", "outcome", "provider"] : ["action", "outcome"],
      );
      const serialized = JSON.stringify(capture);
      expect(serialized).not.toContain("chat-secret-id");
      expect(serialized).not.toContain("usage limit");
      expect(serialized).not.toMatch(/\d{5,}/);
    }
  });
});
