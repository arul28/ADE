import { describe, expect, it, vi } from "vitest";

import {
  createIdentityThreadRotation,
  type IdentityThreadRotationDeps,
} from "./identityThreadRotation";
import type { AgentChatSession } from "../../../shared/types/chat";

/**
 * The rotation policy, tested through its deps bag rather than through the
 * provider graph.
 *
 * The case this module exists for is the one where the CTO cannot be ASKED to
 * summarize itself — a conversation over its context limit cannot take the turn
 * that would write the summary — so the DETERMINISTIC path is not a fallback in
 * the apologetic sense. It is the one that has to work, and it is the one that
 * is hardest to reach from the service-level tests, because getting there means
 * standing up a thread that is genuinely too long.
 */

type Managed = { id: string };

/**
 * The thread rotation creates, as the fields rotation actually touches.
 *
 * Same doctrine as `ServiceDouble` in the voice doubles: an `AgentChatSession`
 * carries sixty fields and this module reads one of them, so the fixture is
 * typed as a `Pick` — a rename breaks it — and widened exactly once, here,
 * rather than as a bare cast at the use site.
 */
const NEW_SESSION: Pick<AgentChatSession, "id"> = { id: "session-new" };

function makeDeps(overrides: Partial<IdentityThreadRotationDeps<Managed>> = {}) {
  const session = NEW_SESSION as AgentChatSession;
  const deps: IdentityThreadRotationDeps<Managed> = {
    logger: { info: vi.fn(), warn: vi.fn() },
    nowIso: () => "2026-09-16T10:00:00.000Z",
    ensureManagedSession: (sessionId: string) => ({ id: sessionId }),
    listIdentitySessions: async () => [{ sessionId: "session-old" }],
    describeSession: (managed) => ({
      id: managed.id,
      // Not "active": an active thread is mid-turn and is never asked.
      status: "idle",
      summaryOrPreview: "Shipping the capture gesture on Windows.",
    }),
    readTurnHealthRecord: () => ({
      // The thread is over its limit, which is exactly when a model round-trip
      // is impossible.
      failure: {
        kind: "context_overflow",
        message: "prompt is too long",
        at: "2026-09-16T09:00:00.000Z",
      },
      context: null,
    }),
    listUserMessages: () => ["Land the helper fix.", "Then cut a build."],
    listScheduledWorkLines: () => ["cron 09:00 — check CI"],
    runSessionTurn: vi.fn(async () => ({ status: "completed", outputText: "model note" })),
    flushContinuity: vi.fn(),
    writeContinuitySummary: vi.fn(),
    writeThreadState: vi.fn(),
    memory: { appendDailyEntry: vi.fn(), appendMemoryFact: vi.fn() },
    dispose: vi.fn(async () => undefined),
    ensureIdentitySession: vi.fn(async () => session),
    ...overrides,
  };
  return { deps, session };
}

describe("distilIdentityHandoff", () => {
  it("writes the hand-off from disk alone when the thread cannot take a turn", async () => {
    const { deps } = makeDeps();
    const rotation = createIdentityThreadRotation(deps);

    const distilled = await rotation.distilIdentityHandoff({ id: "session-old" });

    expect(distilled.source).toBe("deterministic");
    expect(distilled.thin).toBe(false);
    expect(deps.runSessionTurn).not.toHaveBeenCalled();
    expect(distilled.text).toContain("Where it left off: Shipping the capture gesture on Windows.");
    expect(distilled.text).toContain("- Land the helper fix.");
    expect(distilled.text).toContain("- cron 09:00 — check CI");
  });

  /**
   * An empty hand-off is never silently skipped: it says so, and says where the
   * conversation still is, because "no note" and "nothing to note" look
   * identical to the next thread otherwise.
   */
  it("says so out loud when there was nothing readable to summarize", async () => {
    const { deps } = makeDeps({
      describeSession: (managed) => ({ id: managed.id, status: "idle", summaryOrPreview: "   " }),
      listUserMessages: () => [],
      listScheduledWorkLines: () => [],
    });
    const rotation = createIdentityThreadRotation(deps);

    const distilled = await rotation.distilIdentityHandoff({ id: "session-old" });

    expect(distilled.thin).toBe(true);
    expect(distilled.source).toBe("deterministic");
    expect(distilled.text).toContain("could not be summarized");
    expect(deps.runSessionTurn).not.toHaveBeenCalled();
  });

  /** One line cannot grow the note without bound, whatever the user pasted. */
  it("clips each line so one pasted wall of text cannot become the note", async () => {
    const { deps } = makeDeps({ listUserMessages: () => ["x".repeat(500)] });
    const rotation = createIdentityThreadRotation(deps);

    const distilled = await rotation.distilIdentityHandoff({ id: "session-old" });

    const line = distilled.text.split("\n").find((entry) => entry.startsWith("- x"));
    expect(line).toBeDefined();
    expect(line).toHaveLength("- ".length + 200);
    expect(line?.endsWith("…")).toBe(true);
  });

  /** ...and a thread that CAN still think is asked, rather than assumed mute. */
  it("asks the thread for its own note when it can still take a turn", async () => {
    const { deps } = makeDeps({ readTurnHealthRecord: () => ({ failure: null, context: null }) });
    const rotation = createIdentityThreadRotation(deps);

    const distilled = await rotation.distilIdentityHandoff({ id: "session-old" });

    expect(distilled).toMatchObject({ source: "model", thin: false, text: "model note" });
    expect(deps.runSessionTurn).toHaveBeenCalledTimes(1);
  });
});

describe("startFreshIdentitySession", () => {
  it("distils, flushes and retires the old thread before opening a clean one", async () => {
    const { deps, session } = makeDeps();
    const rotation = createIdentityThreadRotation(deps);

    const result = await rotation.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });

    expect(result.previousSessionId).toBe("session-old");
    expect(result.session).toBe(session);
    expect(result.handoff).toEqual({ written: true, thin: false, source: "deterministic" });
    expect(deps.flushContinuity).toHaveBeenCalledWith({ id: "session-old" }, "session_rotation");
    expect(deps.writeContinuitySummary).toHaveBeenCalledWith(
      { id: "session-old" },
      expect.stringContaining("Where it left off:"),
    );
    expect(deps.writeThreadState).toHaveBeenCalledWith(
      { id: "session-old" },
      expect.stringContaining("Where it left off:"),
      "session_rotation",
    );
    expect(deps.memory?.appendMemoryFact).toHaveBeenCalledWith(
      expect.stringContaining("2026-09-16 hand-off from retired CTO thread session-old:"),
    );
    expect(deps.dispose).toHaveBeenCalledWith({ sessionId: "session-old" });
    // `reuseExisting: false` is the whole point — reusing would hand back the
    // thread that was just retired.
    expect(deps.ensureIdentitySession).toHaveBeenCalledWith({
      identityKey: "cto",
      laneId: "lane-1",
      reuseExisting: false,
    });
  });

  /**
   * A hand-off that could not be written must not strand the user on a thread
   * that cannot answer. The rotation still happens and the transcript is still
   * on disk; only the note is lost, and the result says so.
   */
  it("still rotates when the hand-off write fails", async () => {
    const { deps } = makeDeps({
      writeContinuitySummary: vi.fn(() => { throw new Error("disk full"); }),
    });
    const rotation = createIdentityThreadRotation(deps);

    const result = await rotation.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });

    expect(result.handoff).toEqual({ written: false, thin: false, source: "none" });
    expect(deps.dispose).toHaveBeenCalledWith({ sessionId: "session-old" });
    expect(deps.ensureIdentitySession).toHaveBeenCalled();
  });

  /** Nothing to retire is not an error: the first thread rotates from nothing. */
  it("opens a fresh thread when there is no outgoing one", async () => {
    const { deps } = makeDeps({ listIdentitySessions: async () => [] });
    const rotation = createIdentityThreadRotation(deps);

    const result = await rotation.startFreshIdentitySession({ identityKey: "cto", laneId: "lane-1" });

    expect(result.previousSessionId).toBeNull();
    expect(result.handoff).toEqual({ written: false, thin: false, source: "none" });
    expect(deps.dispose).not.toHaveBeenCalled();
    expect(deps.flushContinuity).not.toHaveBeenCalled();
  });
});

describe("getSessionTurnHealth", () => {
  /** Only the overflow verdict blocks: one failed turn is bad luck. */
  it("blocks a thread that no longer fits and lets an unlucky one through", () => {
    const overflow = createIdentityThreadRotation(makeDeps().deps)
      .getSessionTurnHealth({ sessionId: "session-old" });
    expect(overflow).toMatchObject({ canTakeTurn: false, blockedReason: "context_overflow" });

    const unlucky = createIdentityThreadRotation(
      makeDeps({
        readTurnHealthRecord: () => ({
          failure: { kind: "error", message: "network blip", at: "2026-09-16T09:00:00.000Z" },
          context: null,
        }),
      }).deps,
    ).getSessionTurnHealth({ sessionId: "session-old" });
    expect(unlucky).toMatchObject({ canTakeTurn: true, blockedReason: null });
  });
});
