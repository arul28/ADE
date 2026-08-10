import { describe, expect, it } from "vitest";
import { parseSessionSettleOverride } from "./types/sessions";
import {
  backgroundWorkFromSummary,
  canonicalSessionState,
  classifyBackgroundWorkKind,
  isSessionFiledAsSnoozed,
  isSessionSnoozed,
  isSessionSnoozeExpired,
  isWakingSessionError,
  resolveSessionWakeReason,
  summarizeBackgroundWork,
  SESSION_STALE_AFTER_MS,
  type CanonicalSessionInputs,
} from "./sessionCanonicalState";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const chatTools = new Set(["claude-chat", "cursor"]);
const isChatTool = (toolType: string | null | undefined) => Boolean(toolType && chatTools.has(toolType));

function state(overrides: Partial<CanonicalSessionInputs>) {
  return canonicalSessionState({
    status: "running",
    runtimeState: "running",
    toolType: "claude",
    nowMs: NOW,
    isChatTool,
    ...overrides,
  });
}

describe("canonicalSessionState precedence", () => {
  const silentSince = new Date(NOW - SESSION_STALE_AFTER_MS - 1_000).toISOString();

  // Table: explicit and structured signals must outrank everything below them.
  const cases: Array<[string, Partial<CanonicalSessionInputs>, string, string | null]> = [
    ["pendingInputItemId wins over stale silence", { pendingInputItemId: "i-1", lastActivityAt: silentSince }, "needs_you", "Needs you"],
    ["provider provenance restores structured input without an item id", { attentionSource: "provider_structured" }, "needs_you", "Needs you"],
    ["runtime waiting-input does not outvote stale silence", { runtimeState: "waiting-input", lastActivityAt: silentSince }, "stale", "Stale"],
    ["runtime waiting-input alone stays non-interrupting", { runtimeState: "waiting-input", lastOutputPreview: "compiling..." }, "running", null],
    ["pendingInputItemId wins on an ended session", { pendingInputItemId: "i-1", status: "detached", exitCode: 1 }, "needs_you", "Needs you"],
    ["disposed session is stopped, not failed", { status: "disposed", runtimeState: "killed", exitCode: null }, "stopped", null],
    ["user-stop signal is stopped, not failed", { status: "disposed", runtimeState: "killed", exitCode: 130 }, "stopped", null],
    ["non-zero exit is failed", { status: "detached", exitCode: 2 }, "failed", "Failed"],
    ["persisted failed status with null exit is failed (spawn failure)", { status: "failed", exitCode: null, runtimeState: "exited" }, "failed", "Failed"],
    ["killed runtime is failed", { status: "detached", runtimeState: "killed", exitCode: null }, "failed", "Failed"],
    ["running + silent past threshold is stale", { lastActivityAt: silentSince }, "stale", "Stale"],
    ["stale wins over a prompt-looking preview", { lastActivityAt: silentSince, lastOutputPreview: "continue? (y/n)" }, "stale", "Stale"],
    ["prompt-looking output alone stays running", { lastOutputPreview: "continue? (y/n)" }, "running", null],
    ["plain running stays running (no badge)", { lastOutputPreview: "compiling..." }, "running", null],
    ["idle chat is ready (no badge)", { runtimeState: "idle", toolType: "claude-chat" }, "ready", null],
    ["idle CLI is idle (no badge)", { runtimeState: "idle" }, "idle", null],
    ["heuristic does NOT fire on idle sessions", { runtimeState: "idle", lastOutputPreview: "continue? (y/n)" }, "idle", null],
    ["clean exit stays ended until explicitly settled", { status: "detached", exitCode: 0 }, "ended", null],
    ["unknown exit stays ended (no badge)", { status: "detached", exitCode: null, runtimeState: "exited" }, "ended", null],
    ["detached chat is ended, not perpetually ready", { status: "detached", toolType: "claude-chat", exitCode: null }, "ended", null],
    ["declared settle wins over failure", { status: "detached", exitCode: 2, settledAt: "2026-07-06T11:00:00.000Z" }, "settled", null],
    ["settled chat re-settles at idle rest", { toolType: "claude-chat", runtimeState: "idle", settledAt: "2026-07-06T11:00:00.000Z" }, "settled", null],
    ["settle is ignored while a turn actively streams", { toolType: "claude-chat", runtimeState: "running", settledAt: "2026-07-06T11:00:00.000Z" }, "running", null],
    ["ask escalation wins over settle", { settledAt: "2026-07-06T11:00:00.000Z", attentionRequestedAt: "2026-07-06T11:30:00.000Z", toolType: "claude-chat" }, "needs_you", "Needs you"],
    ["chat turn death is failed while status still running", { toolType: "claude-chat", lastTurnFailedAt: "2026-07-06T11:00:00.000Z" }, "failed", "Failed"],
  ];

  it.each(cases)("%s", (_name, overrides, phase, label) => {
    const result = state(overrides);
    expect(result.phase).toBe(phase);
    expect(result.badge?.label ?? null).toBe(label);
    // Attention states and ONLY attention states carry a badge.
    expect(result.badge !== null).toBe(["needs_you", "failed", "stale"].includes(phase));
  });
});

describe("stale boundary", () => {
  it("uses a three-hour silence threshold", () => {
    expect(SESSION_STALE_AFTER_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("flips exactly at the threshold, not before", () => {
    const justUnder = new Date(NOW - SESSION_STALE_AFTER_MS + 1_000).toISOString();
    const exactly = new Date(NOW - SESSION_STALE_AFTER_MS).toISOString();
    expect(state({ lastActivityAt: justUnder }).phase).toBe("running");
    expect(state({ lastActivityAt: exactly }).phase).toBe("stale");
  });

  it("never goes stale without an activity timestamp or with garbage", () => {
    expect(state({ lastActivityAt: null }).phase).toBe("running");
    expect(state({ lastActivityAt: "not-a-date" }).phase).toBe("running");
  });
});

describe("settle override tri-state", () => {
  const cleanExit: Partial<CanonicalSessionInputs> = { status: "detached", exitCode: 0, runtimeState: "exited" };

  it("null override leaves a clean exit ended", () => {
    expect(state({ ...cleanExit }).phase).toBe("ended");
    expect(state({ ...cleanExit, settleOverride: null }).phase).toBe("ended");
  });

  it("'active' override leaves an undeclared clean exit ended", () => {
    const result = state({ ...cleanExit, settleOverride: "active" });
    expect(result.phase).toBe("ended");
    expect(result.badge).toBeNull();
  });

  it("'active' override also suppresses a declared settle", () => {
    expect(state({ ...cleanExit, settledAt: "2026-07-06T11:00:00.000Z", settleOverride: "active" }).phase)
      .toBe("ended");
  });

  it("'settled' override behaves like a declared settle without settled_at", () => {
    expect(state({ status: "detached", exitCode: 2, settleOverride: "settled" }).phase).toBe("settled");
    expect(state({ toolType: "claude-chat", runtimeState: "idle", settleOverride: "settled" }).phase)
      .toBe("settled");
  });

  it("'settled' override is still only honored at rest", () => {
    expect(state({ toolType: "claude-chat", runtimeState: "running", settleOverride: "settled" }).phase)
      .toBe("running");
  });

  it("deterministic attention still outranks every override", () => {
    expect(state({ settleOverride: "settled", pendingInputItemId: "i-1", runtimeState: "idle" }).phase)
      .toBe("needs_you");
  });
});

describe("snooze is a visibility overlay, not a phase", () => {
  const snoozedUntil = new Date(NOW + 60_000).toISOString();
  const snoozedAt = new Date(NOW - 60_000).toISOString();

  it("never changes the canonical phase", () => {
    // Snooze fields are deliberately absent from CanonicalSessionInputs; this
    // asserts the contract holds for the row a snoozed session represents.
    expect(state({ lastOutputPreview: "compiling..." }).phase).toBe("running");
    expect(isSessionSnoozed({ snoozedUntil, snoozedAt }, NOW)).toBe(true);
  });

  it("derives timer expiry from snoozed_until with no scheduler", () => {
    expect(isSessionSnoozed({ snoozedUntil, snoozedAt }, NOW)).toBe(true);
    expect(isSessionSnoozeExpired({ snoozedUntil, snoozedAt }, NOW)).toBe(false);

    // One millisecond past the deadline flips both, purely from the clock.
    const at = Date.parse(snoozedUntil);
    expect(isSessionSnoozed({ snoozedUntil, snoozedAt }, at)).toBe(false);
    expect(isSessionSnoozeExpired({ snoozedUntil, snoozedAt }, at)).toBe(true);
    expect(isSessionSnoozed({ snoozedUntil, snoozedAt }, at + 1)).toBe(false);
    expect(isSessionSnoozeExpired({ snoozedUntil, snoozedAt }, at + 1)).toBe(true);
  });

  it("treats a missing or unparseable deadline as not snoozed", () => {
    expect(isSessionSnoozed({}, NOW)).toBe(false);
    expect(isSessionSnoozed({ snoozedUntil: null }, NOW)).toBe(false);
    expect(isSessionSnoozed({ snoozedUntil: "   " }, NOW)).toBe(false);
    expect(isSessionSnoozed({ snoozedUntil: "not-a-date" }, NOW)).toBe(false);
    expect(isSessionSnoozeExpired({ snoozedUntil: "not-a-date" }, NOW)).toBe(false);
  });
});

// Regression: an "Until I'm asked" snooze (~100 years) hid a needs-you row
// forever. The filing rule must yield to explicit or structured attention.
describe("snooze filing yields to a raised hand (isSessionFiledAsSnoozed)", () => {
  const snoozedUntil = new Date(NOW + 60_000).toISOString();
  const snoozedAt = new Date(NOW - 60_000).toISOString();
  const snoozed = { snoozedUntil, snoozedAt };

  it("does NOT file a snoozed needs-you row as snoozed", () => {
    expect(isSessionFiledAsSnoozed(snoozed, "needs_you", NOW)).toBe(false);
    // An indefinite "until I'm asked" deadline is the case that used to hide
    // a blocked CLI row for a century.
    const indefinite = { snoozedUntil: new Date(NOW + 100 * 365 * 86_400_000).toISOString(), snoozedAt };
    expect(isSessionFiledAsSnoozed(indefinite, "needs_you", NOW)).toBe(false);
  });

  it("keeps isSessionSnoozed a RAW column read for the same row", () => {
    // Chips, menus, and wake labels still want "is it snoozed?" regardless of
    // where the list files it.
    expect(isSessionSnoozed(snoozed, NOW)).toBe(true);
    expect(canonicalSessionState({
      status: "running",
      pendingInputItemId: "question-1",
      nowMs: NOW,
    }).phase).toBe("needs_you");
  });

  it("still files every calm phase as snoozed", () => {
    for (const phase of ["running", "starting", "stale", "ready", "idle", "failed", "ended", "stopped", "settled"] as const) {
      expect(isSessionFiledAsSnoozed(snoozed, phase, NOW)).toBe(true);
    }
    // No phase known (callers that only have the columns) files as snoozed too.
    expect(isSessionFiledAsSnoozed(snoozed, null, NOW)).toBe(true);
    expect(isSessionFiledAsSnoozed(snoozed, undefined, NOW)).toBe(true);
  });

  it("never files a row that is not snoozed at all", () => {
    expect(isSessionFiledAsSnoozed({}, "running", NOW)).toBe(false);
    expect(isSessionFiledAsSnoozed({}, "needs_you", NOW)).toBe(false);
    // Lapsed deadline: expiry is derived, so the row is simply awake.
    expect(isSessionFiledAsSnoozed(
      { snoozedUntil: new Date(NOW - 1).toISOString(), snoozedAt },
      "running",
      NOW,
    )).toBe(false);
  });
});

describe("early wake: the newer-than-snoozed_at error comparison", () => {
  const snoozedAt = "2026-07-06T11:00:00.000Z";
  const snoozedUntil = "2026-07-06T13:00:00.000Z";
  const session = { snoozedUntil, snoozedAt };

  it("does NOT wake on the error the snooze was taken on top of", () => {
    // This is the whole point: an older/equal error must not resurrect the row,
    // otherwise snooze does nothing at all.
    expect(isWakingSessionError(session, "2026-07-06T10:59:59.999Z")).toBe(false);
    expect(isWakingSessionError(session, snoozedAt)).toBe(false);
  });

  it("wakes on an error strictly newer than snoozed_at", () => {
    expect(isWakingSessionError(session, "2026-07-06T11:00:00.001Z")).toBe(true);
    expect(isWakingSessionError(session, "2026-07-06T12:00:00.000Z")).toBe(true);
  });

  it("fails closed when there is no usable timestamp on either side", () => {
    expect(isWakingSessionError(session, null)).toBe(false);
    expect(isWakingSessionError(session, "not-a-date")).toBe(false);
    expect(isWakingSessionError({ snoozedUntil }, "2026-07-06T12:00:00.000Z")).toBe(false);
    expect(isWakingSessionError({ snoozedUntil, snoozedAt: "garbage" }, "2026-07-06T12:00:00.000Z")).toBe(false);
  });
});

describe("resolveSessionWakeReason", () => {
  const snoozedAt = "2026-07-06T11:00:00.000Z";
  const active = { snoozedUntil: "2026-07-06T13:00:00.000Z", snoozedAt };
  const expired = { snoozedUntil: "2026-07-06T11:30:00.000Z", snoozedAt };

  it("keeps an un-snoozed row awake-agnostic (never reports a wake)", () => {
    expect(resolveSessionWakeReason({}, { hasPendingInput: true }, NOW)).toBeNull();
    expect(resolveSessionWakeReason({ snoozedAt }, { turnCompleted: true }, NOW)).toBeNull();
  });

  it("stays asleep with no qualifying signal", () => {
    expect(resolveSessionWakeReason(active, {}, NOW)).toBeNull();
    expect(resolveSessionWakeReason(active, { errorAt: snoozedAt }, NOW)).toBeNull();
  });

  it("reports each hand-raise ahead of plain timer expiry", () => {
    expect(resolveSessionWakeReason(active, { hasPendingInput: true }, NOW)).toBe("needs_you");
    expect(resolveSessionWakeReason(active, { errorAt: "2026-07-06T11:45:00.000Z" }, NOW)).toBe("error");
    expect(resolveSessionWakeReason(active, { turnCompleted: true }, NOW)).toBe("turn_complete");
    expect(resolveSessionWakeReason(expired, { turnCompleted: true }, NOW)).toBe("turn_complete");
  });

  it("falls back to derived timer expiry", () => {
    expect(resolveSessionWakeReason(expired, {}, NOW)).toBe("timer");
    expect(resolveSessionWakeReason(expired, { errorAt: snoozedAt }, NOW)).toBe("timer");
  });
});

/**
 * Regression: the settle-override value crosses four boundaries (IPC args, sync
 * JSON, CLI flags, a SQLite text column) and was parsed four different ways.
 * The registry/sync parsers were case-sensitive and threw; the service parser
 * lowercased and returned null for ANYTHING unrecognized — so a typo silently
 * CLEARED a keep-active pin instead of failing, and `"Settled"` was rejected
 * over IPC while being accepted underneath it.
 */
describe("parseSessionSettleOverride: a typo must not silently clear a pin", () => {
  it("distinguishes unrecognized input from an explicit clear", () => {
    // undefined = "I don't recognize this" — throwing callers surface an error,
    // and the persistence layer can no longer mistake it for "clear".
    expect(parseSessionSettleOverride("activ")).toBeUndefined();
    expect(parseSessionSettleOverride("bogus")).toBeUndefined();
    expect(parseSessionSettleOverride(42)).toBeUndefined();
    expect(parseSessionSettleOverride({})).toBeUndefined();

    // null = an explicit, intentional clear.
    expect(parseSessionSettleOverride(null)).toBeNull();
    expect(parseSessionSettleOverride(undefined)).toBeNull();
    expect(parseSessionSettleOverride("")).toBeNull();
    expect(parseSessionSettleOverride("clear")).toBeNull();
    expect(parseSessionSettleOverride("none")).toBeNull();
  });

  it("accepts the two real values regardless of case or padding, on every boundary", () => {
    expect(parseSessionSettleOverride("settled")).toBe("settled");
    expect(parseSessionSettleOverride("active")).toBe("active");
    // Previously accepted by the service but rejected over IPC/sync.
    expect(parseSessionSettleOverride("Settled")).toBe("settled");
    expect(parseSessionSettleOverride("ACTIVE")).toBe("active");
    expect(parseSessionSettleOverride("  active  ")).toBe("active");
    // iOS sends this string because JSON null is not representable in its
    // [String: Any] argument dictionary.
    expect(parseSessionSettleOverride("Clear")).toBeNull();
  });
});

describe("background work liveness", () => {
  const working = { workingCount: 1, monitoringCount: 0 };
  const monitoring = { workingCount: 0, monitoringCount: 2 };

  it("promotes a resting chat with live background work back to running", () => {
    // Before this, a Claude chat whose turn ended while its background agents
    // kept going read `ready`, so the Work dot, TopBar rollup and dock badge
    // all showed nothing while the agents were mid-run.
    const resting = state({ toolType: "claude-chat", runtimeState: "idle" });
    expect(resting.phase).toBe("ready");
    expect(resting.liveness).toBeNull();

    const promoted = state({ toolType: "claude-chat", runtimeState: "idle", backgroundWork: working });
    expect(promoted.phase).toBe("running");
    expect(promoted.liveness).toBe("background");
  });

  it("promotes a resting CLI session too, not just chats", () => {
    const promoted = state({ toolType: "codex", runtimeState: "idle", backgroundWork: working });
    expect(promoted.phase).toBe("running");
    expect(promoted.liveness).toBe("background");
  });

  it("reads monitoring only when watch loops are the sole live work", () => {
    expect(state({ runtimeState: "idle", backgroundWork: monitoring }).liveness).toBe("monitoring");
    // One real job alongside monitors is still "working" — the loudest live
    // commitment wins, never the quietest.
    expect(
      state({ runtimeState: "idle", backgroundWork: { workingCount: 1, monitoringCount: 3 } }).liveness,
    ).toBe("background");
  });

  it("marks a genuinely live turn as turn liveness", () => {
    expect(state({ runtimeState: "running" }).liveness).toBe("turn");
  });

  it("never lets lingering background work mask a failure", () => {
    // A failed turn with an orphaned monitor still ticking must read Failed.
    expect(
      state({ toolType: "claude-chat", runtimeState: "idle", lastTurnFailedAt: new Date(NOW).toISOString(), backgroundWork: working }).phase,
    ).toBe("failed");
    expect(
      state({ status: "completed", exitCode: 1, backgroundWork: working }).phase,
    ).toBe("failed");
    expect(
      state({ status: "completed", runtimeState: "killed", backgroundWork: working }).phase,
    ).toBe("failed");
  });

  it("never lets background work mask a raised hand or a declared settle", () => {
    expect(state({ pendingInputItemId: "i-1", runtimeState: "idle", backgroundWork: working }).phase).toBe("needs_you");
    expect(
      state({ runtimeState: "idle", settledAt: new Date(NOW).toISOString(), backgroundWork: working }).phase,
    ).toBe("settled");
  });

  it("leaves a silent session stale rather than claiming it is working", () => {
    const silentSince = new Date(NOW - SESSION_STALE_AFTER_MS - 1_000).toISOString();
    expect(state({ lastActivityAt: silentSince, backgroundWork: working }).phase).toBe("stale");
  });

  it("ignores an empty or absent background-work record", () => {
    expect(state({ runtimeState: "idle", backgroundWork: null }).phase).toBe("idle");
    expect(
      state({ runtimeState: "idle", backgroundWork: { workingCount: 0, monitoringCount: 0 } }).phase,
    ).toBe("idle");
  });
});

describe("classifyBackgroundWorkKind", () => {
  it("treats every unrecognised task type as working", () => {
    // The load-bearing property: an allowlist would silently drop a real
    // subagent the first time an SDK renamed a task type.
    expect(classifyBackgroundWorkKind("some_future_sdk_type")).toBe("working");
    expect(classifyBackgroundWorkKind(undefined)).toBe("working");
    expect(classifyBackgroundWorkKind(null)).toBe("working");
    expect(classifyBackgroundWorkKind("  ")).toBe("working");
    expect(classifyBackgroundWorkKind("subagent")).toBe("working");
    expect(classifyBackgroundWorkKind("local_workflow")).toBe("working");
  });

  it("classifies only the known-passive types as monitoring", () => {
    for (const taskType of ["monitor", "monitor_mcp", "local_bash", "shell", "background", "bash"]) {
      expect(classifyBackgroundWorkKind(taskType)).toBe("monitoring");
    }
    expect(classifyBackgroundWorkKind("MONITOR")).toBe("monitoring");
    expect(classifyBackgroundWorkKind(" local_bash ")).toBe("monitoring");
  });

  it("drops inert types entirely", () => {
    expect(classifyBackgroundWorkKind("plan")).toBe("inert");
    expect(classifyBackgroundWorkKind("dream")).toBe("inert");
    expect(summarizeBackgroundWork(["plan", "dream"])).toEqual({ workingCount: 0, monitoringCount: 0 });
  });

  it("folds a mixed list into the two-state count", () => {
    expect(summarizeBackgroundWork(["subagent", "monitor", "local_bash", "plan", null])).toEqual({
      workingCount: 2,
      monitoringCount: 2,
    });
  });
});

describe("backgroundWorkFromSummary", () => {
  it("prefers the explicit split when present", () => {
    expect(
      backgroundWorkFromSummary({ backgroundWork: { workingCount: 0, monitoringCount: 3 }, activeBackgroundTaskCount: 9 }),
    ).toEqual({ workingCount: 0, monitoringCount: 3 });
  });

  it("counts a split-less payload as working, never as passive", () => {
    // An older peer or a remote runtime mid-upgrade sends only the total.
    // Assuming those are monitors would under-report live work.
    expect(backgroundWorkFromSummary({ activeBackgroundTaskCount: 2 })).toEqual({
      workingCount: 2,
      monitoringCount: 0,
    });
  });

  it("returns null when nothing is live", () => {
    expect(backgroundWorkFromSummary({})).toBeNull();
    expect(backgroundWorkFromSummary({ activeBackgroundTaskCount: 0 })).toBeNull();
  });
});
