import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import { Drawer } from "../components/Drawer";
import { BUILTIN_COMMANDS, paletteCommands, parseCommand } from "../commands";
import type { TuiChatSessionSummary } from "../adeApi";
import {
  SNOOZE_CHOICES,
  clearWokeMarkerOnVisit,
  isSessionFiledAsSnoozed,
  isSessionSnoozed,
  resolveSessionTarget,
  resolveSnoozeChoice,
  resolveSnoozeFreeText,
  sessionLifecycleCommandFor,
  sessionLifecycleMarker,
  shouldClearWokeMarkerOnVisit,
} from "../sessionLifecycle";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

/**
 * Strips BOTH SGR color and every other CSI sequence, then asserts the result
 * still carries the state. This is the no-color legibility check: whatever the
 * drawer says about snooze/settle/wake has to survive a terminal that renders
 * no styling at all.
 */
function stripAnsi(text: string): string {
  return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "");
}

/** The stripped row a session's title appears on. */
function rowFor(frame: string, title: string): string {
  return frame.split("\n").find((line) => line.includes(title)) ?? "";
}

function lane(id: string, name: string): LaneSummary {
  return {
    id,
    name,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `feat/${id}`,
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
    createdAt: "2026-07-26T10:00:00.000Z",
  };
}

function session(overrides: Partial<TuiChatSessionSummary> & { sessionId: string }): TuiChatSessionSummary {
  return {
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.5",
    title: overrides.sessionId,
    status: "idle",
    startedAt: "2026-07-26T11:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-07-26T11:30:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  } as TuiChatSessionSummary;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("/session slash commands", () => {
  it("registers every lifecycle verb with a description and an optional-id hint", () => {
    for (const name of [
      "/session snooze",
      "/session wake",
      "/session settle",
      "/session unsettle",
      "/session keep-active",
    ]) {
      const spec = BUILTIN_COMMANDS.find((command) => command.name === name);
      expect(spec, name).toBeDefined();
      expect(spec!.description.length).toBeGreaterThan(0);
      expect(spec!.placement).toBe("right");
      expect(spec!.argumentHint).toContain("session-id");
      expect(sessionLifecycleCommandFor(name)).not.toBeNull();
    }
  });

  it("parses the multi-word forms without shadowing each other, and surfaces them in the palette", () => {
    expect(parseCommand("/session snooze abc 1h")?.name).toBe("/session snooze");
    expect(parseCommand("/session snooze abc 1h")?.args).toBe("abc 1h");
    expect(parseCommand("/session keep-active")?.name).toBe("/session keep-active");
    expect(parseCommand("/session unsettle sess-9")?.args).toBe("sess-9");

    expect(paletteCommands("/session sn")).toContainEqual(expect.objectContaining({
      name: "/session snooze",
      source: "ade",
    }));
  });

  it("routes a bare /session to the right pane rather than into the chat", () => {
    const parsed = parseCommand("/session");
    expect(parsed?.name).toBe("/session");
    expect(parsed?.spec?.placement).toBe("right");
    expect(sessionLifecycleCommandFor("/session")).toBeNull();
  });

  it("keeps the pre-existing active-only /chat settle and /chat unsettle working", () => {
    expect(parseCommand("/chat settle PR merged")?.name).toBe("/chat settle");
    expect(parseCommand("/chat settle PR merged")?.args).toBe("PR merged");
    expect(parseCommand("/chat unsettle")?.name).toBe("/chat unsettle");
    // They are NOT routed through the /session dispatcher.
    expect(sessionLifecycleCommandFor("/chat settle")).toBeNull();
    expect(sessionLifecycleCommandFor("/chat unsettle")).toBeNull();
  });
});

describe("per-session targeting", () => {
  const known = ["sess-alpha-1111", "sess-beta-2222", "sess-beta-3333"];

  it("falls back to the active session when no id is given", () => {
    const resolved = resolveSessionTarget({
      input: "",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
    });
    expect(resolved).toEqual({ ok: true, sessionId: "sess-alpha-1111", explicit: false, rest: "" });
  });

  it("targets an explicit id and hands the remaining text back as the verb's argument", () => {
    const resolved = resolveSessionTarget({
      input: "sess-beta-2222 1h",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
    });
    expect(resolved).toEqual({ ok: true, sessionId: "sess-beta-2222", explicit: true, rest: "1h" });
  });

  it("resolves an unambiguous id prefix but refuses an ambiguous one", () => {
    expect(resolveSessionTarget({
      input: "sess-beta-22",
      activeSessionId: null,
      knownSessionIds: known,
    })).toMatchObject({ ok: true, sessionId: "sess-beta-2222", explicit: true });

    expect(resolveSessionTarget({
      input: "sess-beta",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
    })).toMatchObject({ ok: false, code: "ambiguous-session" });
  });

  it("reads a lone duration as a duration, not as a session id", () => {
    // The whole point of matching against known ids first: `/session snooze 1h`
    // must snooze the ACTIVE session for an hour.
    const resolved = resolveSessionTarget({
      input: "1h",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
    });
    expect(resolved).toEqual({ ok: true, sessionId: "sess-alpha-1111", explicit: false, rest: "1h" });
  });

  it("rejects a stray leading token for the verbs that take no argument", () => {
    expect(resolveSessionTarget({
      input: "sess-nope",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
      strictLeadingToken: true,
    })).toMatchObject({ ok: false, code: "unknown-session" });

    // …but the same token is passed through as an outcome for settle.
    expect(resolveSessionTarget({
      input: "shipped it",
      activeSessionId: "sess-alpha-1111",
      knownSessionIds: known,
    })).toMatchObject({ ok: true, sessionId: "sess-alpha-1111", explicit: false, rest: "shipped it" });
  });

  it("reports a missing target instead of silently doing nothing", () => {
    expect(resolveSessionTarget({
      input: "",
      activeSessionId: null,
      knownSessionIds: known,
    })).toMatchObject({ ok: false, code: "no-active" });
  });
});

describe("duration entry", () => {
  it("offers the shared four options in the shared order", () => {
    expect(SNOOZE_CHOICES.map((choice) => choice.label)).toEqual([
      "1 hour",
      "Until this evening",
      "Until tomorrow 9am",
      "Until I'm asked",
    ]);
  });

  it("resolves a menu choice to a concrete future deadline", () => {
    const resolved = resolveSnoozeChoice("hour", NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(Date.parse(resolved.untilIso)).toBe(NOW + 60 * 60_000);
    expect(resolved.confirmation).toBe("Snoozed for 1 hour.");
  });

  it("accepts free text through the shared parser and reuses the shared wake copy", () => {
    const resolved = resolveSnoozeFreeText("3h", NOW);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(Date.parse(resolved.untilIso)).toBe(NOW + 3 * 60 * 60_000);
    expect(resolved.confirmation).toBe("Snoozed · wakes in 3h.");
  });

  it("rewrites the CLI's flag-worded failures into terminal copy", () => {
    expect(resolveSnoozeFreeText("soon", NOW)).toEqual({
      ok: false,
      message: "'soon' is not a duration. Try 30m, 1h, 4h, or 1d.",
    });
    // The cap on relative durations points at the open-ended choice instead of
    // dead-ending — that choice is how a >30d intent is actually expressed.
    expect(resolveSnoozeFreeText("31d", NOW)).toEqual({
      ok: false,
      message: "Snooze for 30d or less, or pick \"Until I'm asked\" for an open-ended snooze.",
    });
  });

  it("calls an overflowing duration too long, never too short", () => {
    // Regression: the magnitude check used to run after the floor check, so a
    // number big enough to leave the safe-integer range fell into the "too
    // short" branch and the TUI answered "snooze for at least one second" —
    // precisely backwards. Both an overflowing and an infinite amount are
    // long-side failures.
    const tooLong = "Snooze for 30d or less, or pick \"Until I'm asked\" for an open-ended snooze.";
    expect(resolveSnoozeFreeText("999999999999999w", NOW)).toEqual({ ok: false, message: tooLong });
    expect(resolveSnoozeFreeText(`${"9".repeat(400)}d`, NOW)).toEqual({ ok: false, message: tooLong });
    // The genuine short case still reads as short.
    expect(resolveSnoozeFreeText("0.001s", NOW)).toEqual({
      ok: false,
      message: "Snooze for at least one second.",
    });
  });
});

describe("lifecycle markers", () => {
  it("labels a snoozed row with the shared wake copy and never from a phase check", () => {
    const marker = sessionLifecycleMarker(
      { snoozedUntil: new Date(NOW + 3 * 60 * 60_000).toISOString(), snoozedAt: new Date(NOW).toISOString() },
      { nowMs: NOW },
    );
    expect(marker).toEqual({ kind: "snoozed", glyph: "z", text: "z wakes in 3h" });
  });

  it("prefers a live snooze over a settled state — snooze is an overlay, not a phase", () => {
    const marker = sessionLifecycleMarker(
      {
        settledAt: "2026-07-26T11:00:00.000Z",
        snoozedUntil: new Date(NOW + 30 * 60_000).toISOString(),
        snoozedAt: new Date(NOW).toISOString(),
      },
      { nowMs: NOW },
    );
    expect(marker?.kind).toBe("snoozed");
    expect(marker?.text).toBe("z wakes in 30m");
  });

  it("explains why a woken row came back", () => {
    expect(sessionLifecycleMarker(
      { wokeAt: "2026-07-26T11:59:00.000Z", wokeReason: "needs_you" },
      { nowMs: NOW },
    )).toEqual({ kind: "woke", glyph: "*", text: "* needs approval" });
    expect(sessionLifecycleMarker(
      { wokeAt: "2026-07-26T11:59:00.000Z", wokeReason: "error" },
      { nowMs: NOW },
    )?.text).toBe("* errored");
    expect(sessionLifecycleMarker(
      { wokeAt: "2026-07-26T11:59:00.000Z", wokeReason: "turn_complete" },
      { nowMs: NOW },
    )?.text).toBe("* turn finished");
  });

  it("files a settled row in the quiet tier, with its outcome when it left one", () => {
    expect(sessionLifecycleMarker({ settledAt: "2026-07-26T11:00:00.000Z" }, { nowMs: NOW }))
      .toEqual({ kind: "settled", glyph: "", text: "done" });
    expect(sessionLifecycleMarker(
      { settledAt: "2026-07-26T11:00:00.000Z" },
      { note: "PR merged", nowMs: NOW },
    )?.text).toBe("done: PR merged");
  });

  it("honours the tri-state override: a keep-active pin suppresses the quiet tier", () => {
    expect(sessionLifecycleMarker(
      { settledAt: "2026-07-26T11:00:00.000Z", settleOverride: "active" },
      { nowMs: NOW },
    )).toBeNull();
    // …and a "settled" override settles a row that never declared one.
    expect(sessionLifecycleMarker({ settleOverride: "settled" }, { nowMs: NOW })?.kind).toBe("settled");
  });

  it("leaves an ordinary row unmarked", () => {
    expect(sessionLifecycleMarker({}, { nowMs: NOW })).toBeNull();
  });

  // Regression: an "Until I'm asked" snooze (~100 years) marked a blocked row
  // `z wakes when asked` forever. Every early-wake trigger was chat-only, and a
  // explicit and structured needs-input states raise a hand — so a
  // needs-you row must never READ as snoozed either.
  it("does NOT mark a snoozed row as snoozed while it is asking for you", () => {
    const snooze = {
      snoozedUntil: new Date(NOW + 100 * 365 * 86_400_000).toISOString(),
      snoozedAt: new Date(NOW).toISOString(),
    };
    // Runtime/prompt inference is non-interrupting; only explicit or
    // provider-structured requests raise the hand.
    expect(sessionLifecycleMarker({ ...snooze, runtimeState: "waiting-input" }, { nowMs: NOW })?.kind).toBe("snoozed");
    expect(sessionLifecycleMarker({ ...snooze, awaitingInput: true }, { nowMs: NOW })?.kind).toBe("snoozed");
    expect(sessionLifecycleMarker({ ...snooze, pendingInputItemId: "item-1" }, { nowMs: NOW })).toBeNull();
    expect(sessionLifecycleMarker(
      { ...snooze, attentionRequestedAt: "2026-07-26T11:59:00.000Z" },
      { nowMs: NOW },
    )).toBeNull();

    // …and the same row with no raised hand is still marked snoozed.
    expect(sessionLifecycleMarker(snooze, { nowMs: NOW })).toEqual({
      kind: "snoozed",
      glyph: "z",
      text: "z wakes when asked",
    });
    // The RAW read is unchanged — chips and wake copy still see the snooze.
    expect(isSessionSnoozed(snooze, NOW)).toBe(true);
    expect(isSessionFiledAsSnoozed(snooze, "needs_you", NOW)).toBe(false);
  });
});

describe("clearing the woke marker on visit", () => {
  const clearable = { sessionId: "sess-persisted", wokeAt: "2026-07-26T11:58:00.000Z" };
  // A snooze that lapsed on its own. `sessionWokeMarker` still DERIVES a marker
  // for this row, but the host never wrote one, so there is nothing to clear.
  const derivedOnly = {
    sessionId: "sess-derived",
    wokeAt: null,
    snoozedUntil: "2026-07-26T11:00:00.000Z",
    snoozedAt: "2026-07-26T10:00:00.000Z",
  };

  it("fires the action when the opened row carries a persisted wokeAt", () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    expect(clearWokeMarkerOnVisit({
      sessionId: "sess-persisted",
      sessions: [derivedOnly, clearable],
      clear,
    })).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith("sess-persisted");
  });

  it("does NOT fire for a purely derived marker, even though the row still shows one", () => {
    // The row genuinely renders a marker…
    expect(sessionLifecycleMarker(derivedOnly, { nowMs: NOW })).toMatchObject({ kind: "woke" });
    // …but nothing is persisted, so visiting it must not round-trip.
    const clear = vi.fn().mockResolvedValue(undefined);
    expect(clearWokeMarkerOnVisit({
      sessionId: "sess-derived",
      sessions: [derivedOnly, clearable],
      clear,
    })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(shouldClearWokeMarkerOnVisit(derivedOnly)).toBe(false);
  });

  it("stays quiet for rows with no marker at all, unknown ids, and deselection", () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    expect(clearWokeMarkerOnVisit({ sessionId: null, sessions: [clearable], clear })).toBe(false);
    expect(clearWokeMarkerOnVisit({ sessionId: "sess-missing", sessions: [clearable], clear })).toBe(false);
    expect(clearWokeMarkerOnVisit({
      sessionId: "sess-plain",
      sessions: [{ sessionId: "sess-plain", wokeAt: null }],
      clear,
    })).toBe(false);
    // Whitespace is not a marker.
    expect(shouldClearWokeMarkerOnVisit({ wokeAt: "   " })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it("never lets a failed clear block or delay opening the session", async () => {
    const clear = vi.fn().mockRejectedValue(new Error("runtime went away"));
    // Synchronous return, no throw: the caller proceeds to open the row.
    expect(() => clearWokeMarkerOnVisit({
      sessionId: "sess-persisted",
      sessions: [clearable],
      clear,
    })).not.toThrow();
    // And the rejection is swallowed rather than surfacing as an unhandled one.
    await new Promise((resolve) => setImmediate(resolve));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("session list legibility with no color at all", () => {
  it("renders snoozed, woken, and settled rows as plain text in the lane drawer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "Lifecycle")]}
        sessions={[
          session({
            sessionId: "chat-snoozed",
            title: "Snoozed chat",
            snoozedUntil: new Date(NOW + 3 * 60 * 60_000).toISOString(),
            snoozedAt: new Date(NOW - 60_000).toISOString(),
          }),
          session({
            sessionId: "chat-woke",
            title: "Woken chat",
            wokeAt: "2026-07-26T11:58:00.000Z",
            wokeReason: "needs_you",
          }),
          session({ sessionId: "chat-settled", title: "Settled chat", settledAt: "2026-07-26T11:00:00.000Z" }),
        ]}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
        width={48}
      />,
    ).lastFrame() ?? "");

    // Every state is carried by text on its OWN row: strip all styling and the
    // three rows are still told apart without a single color.
    expect(rowFor(frame, "Snoozed chat")).toContain("z wakes in 3h");
    expect(rowFor(frame, "Woken chat")).toContain("* needs approval");
    expect(rowFor(frame, "Settled chat")).toContain("done");
    expect(rowFor(frame, "Snoozed chat")).not.toContain("done");
    expect(rowFor(frame, "Settled chat")).not.toContain("wakes");
    // Nothing escaped the strip: no residual escape byte is doing the work.
    expect(frame).not.toContain("");
  });

  it("keeps the same markers in chats mode, where rows have no status suffix column", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const frame = stripAnsi(render(
      <Drawer
        mode="chats"
        lanes={[lane("lane-1", "Lifecycle")]}
        sessions={[
          session({
            sessionId: "chat-snoozed",
            title: "Snoozed",
            snoozedUntil: new Date(NOW + 26 * 60 * 60_000).toISOString(),
            snoozedAt: new Date(NOW - 60_000).toISOString(),
          }),
          session({ sessionId: "chat-settled", title: "Settled", settledAt: "2026-07-26T11:00:00.000Z" }),
        ]}
        activeLaneId="lane-1"
        activeSessionId={null}
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
        width={48}
      />,
    ).lastFrame() ?? "");

    expect(rowFor(frame, "Snoozed")).toContain("z wakes tomorrow");
    expect(rowFor(frame, "Settled")).toContain("done");
  });

  it("does not mark a running session as done just because it once settled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const running: AgentChatSessionSummary = session({
      sessionId: "chat-running",
      title: "Running chat",
      status: "active",
      settledAt: "2026-07-26T11:00:00.000Z",
      lastOutputPreview: "compiling",
    });

    const frame = stripAnsi(render(
      <Drawer
        lanes={[lane("lane-1", "Lifecycle")]}
        sessions={[running]}
        activeLaneId="lane-1"
        activeSessionId="chat-running"
        browsingLaneId="lane-1"
        selectedLaneIndex={0}
        selectedChatIndex={-1}
        panelHeight={30}
        width={48}
      />,
    ).lastFrame() ?? "");

    expect(frame).not.toContain("done");
    expect(frame).toContain("compiling");
  });
});
