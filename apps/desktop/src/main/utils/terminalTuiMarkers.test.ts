import { describe, expect, it } from "vitest";
import {
  clearTuiWaitingInput,
  createTuiMarkerState,
  scanTuiMarkers,
  tuiActivityFromState,
} from "./terminalTuiMarkers";

const T0 = 1_000_000;

describe("terminalTuiMarkers", () => {
  it("allocates no state for untracked tools so unknown CLIs keep today's behavior", () => {
    expect(createTuiMarkerState("shell" as never)).toBeNull();
    expect(createTuiMarkerState(null)).toBeNull();
    expect(scanTuiMarkers(null, { chunk: "Do you want to proceed? (y/n)\n", nowMs: T0 })).toBeNull();
    expect(tuiActivityFromState(null)).toBeNull();
  });

  it("reports planning while the Claude plan-mode footer keeps repainting, and decays after the TTL", () => {
    const state = createTuiMarkerState("claude");
    expect(state, "claude must have a marker pack").toBeTruthy();
    expect(scanTuiMarkers(state, { chunk: "[2m⏸ plan mode on[0m\n", nowMs: T0 })).toBe("planning");
    // Still believed shortly after the last repaint…
    expect(tuiActivityFromState(state, { nowMs: T0 + 30_000 })).toBe("planning");
    // …but a footer that stopped saying it expires on its own.
    expect(tuiActivityFromState(state, { nowMs: T0 + 61_000 })).toBeNull();
  });

  it("latches waiting-input on an approval prompt and holds it through silence without re-stamping", () => {
    const state = createTuiMarkerState("claude");
    expect(scanTuiMarkers(state, { chunk: "Do you want to proceed?\n❯ 1. Yes\n  2. No\n", nowMs: T0 })).toBe("waiting-input");
    const firstStamp = state!.waitingSince;
    expect(firstStamp).toBe(T0);
    // The TUI repaints the same prompt every frame; the latch must stay at the
    // ORIGINAL edge so a later user settle can outrank it.
    scanTuiMarkers(state, { chunk: "Do you want to proceed?\n❯ 1. Yes\n", nowMs: T0 + 5_000 });
    expect(state!.waitingSince).toBe(firstStamp);
    // A settle floor newer than the latch silences it; a floor older does not.
    expect(tuiActivityFromState(state, { nowMs: T0 + 10_000, waitingFloorMs: T0 })).toBeNull();
    expect(tuiActivityFromState(state, { nowMs: T0 + 10_000, waitingFloorMs: T0 - 1 })).toBe("waiting-input");
  });

  it("releases the waiting latch when a working marker paints after the prompt", () => {
    const state = createTuiMarkerState("claude");
    expect(scanTuiMarkers(state, { chunk: "Do you want to run this command? (y/n)\n", nowMs: T0 })).toBe("waiting-input");
    expect(scanTuiMarkers(state, { chunk: "Running… esc to interrupt\n", nowMs: T0 + 2_000 })).toBeNull();
    expect(state!.waitingSince).toBeNull();
  });

  it("resolves prompt-vs-spinner in one window by position: the later marker wins", () => {
    const state = createTuiMarkerState("codex");
    // Prompt then spinner → the agent already resumed working.
    expect(scanTuiMarkers(state, { chunk: "Allow command? (y/n)\nWorking (esc to interrupt)\n", nowMs: T0 })).toBeNull();
    // Spinner then prompt → the prompt is the current truth.
    const second = createTuiMarkerState("codex");
    expect(scanTuiMarkers(second, { chunk: "esc to interrupt\nAllow command? (y/n)\n", nowMs: T0 })).toBe("waiting-input");
    expect(second!.waitingSince).toBe(T0);
  });

  it("clears the latch AND the carry when the user types, so the answered prompt cannot re-latch", () => {
    const state = createTuiMarkerState("claude");
    scanTuiMarkers(state, { chunk: "Do you want to proceed? (y/n)\n", nowMs: T0 });
    expect(state!.waitingSince).toBe(T0);
    clearTuiWaitingInput(state);
    expect(state!.waitingSince).toBeNull();
    expect(state!.carry).toBe("");
    // Next frame with no prompt stays clear.
    expect(scanTuiMarkers(state, { chunk: "some plain output\n", nowMs: T0 + 1_000 })).toBeNull();
  });

  it("matches a marker split across two PTY chunks via the carry", () => {
    const state = createTuiMarkerState("claude");
    expect(scanTuiMarkers(state, { chunk: "Do you want to pro", nowMs: T0 })).toBeNull();
    expect(scanTuiMarkers(state, { chunk: "ceed? (y/n)\n", nowMs: T0 + 100 })).toBe("waiting-input");
    expect(state!.waitingSince).toBe(T0 + 100);
  });

  it("only latches an end-anchored yes/no prompt, not the same characters quoted mid-sentence", () => {
    const state = createTuiMarkerState("droid");
    expect(scanTuiMarkers(state, { chunk: "answer with (y/n) when asked later\n", nowMs: T0 })).toBeNull();
    expect(state!.waitingSince).toBeNull();
    expect(scanTuiMarkers(state, { chunk: "Apply this change? (y/n) ", nowMs: T0 + 1_000 })).toBe("waiting-input");
  });

  it("bounds a false-positive latch with the 30-minute TTL", () => {
    const state = createTuiMarkerState("claude");
    scanTuiMarkers(state, { chunk: "Do you want to proceed? (y/n)\n", nowMs: T0 });
    expect(tuiActivityFromState(state, { nowMs: T0 + 29 * 60_000 })).toBe("waiting-input");
    expect(tuiActivityFromState(state, { nowMs: T0 + 31 * 60_000 })).toBeNull();
    expect(state!.waitingSince, "TTL expiry must not mutate the stamp").toBe(T0);
  });

  it("scans both ends of an oversized burst so a prompt at its head still latches", () => {
    const state = createTuiMarkerState("claude");
    const burst = `Do you want to proceed? (y/n)\n${"x".repeat(40_000)}\nquiet tail\n`;
    expect(scanTuiMarkers(state, { chunk: burst, nowMs: T0 })).toBe("waiting-input");
    // But a burst that ENDS working resolves to working by the position rule.
    const resumed = createTuiMarkerState("claude");
    const burst2 = `Do you want to proceed? (y/n)\n${"x".repeat(40_000)}\nesc to interrupt\n`;
    expect(scanTuiMarkers(resumed, { chunk: burst2, nowMs: T0 })).toBeNull();
    expect(resumed!.waitingSince).toBeNull();
  });

  it("recognizes per-provider planning vocabulary (codex read-only, opencode plan agent, droid spec mode)", () => {
    expect(scanTuiMarkers(createTuiMarkerState("codex"), { chunk: "read-only mode\n", nowMs: T0 })).toBe("planning");
    expect(scanTuiMarkers(createTuiMarkerState("opencode"), { chunk: "agent: plan\n", nowMs: T0 })).toBe("planning");
    expect(scanTuiMarkers(createTuiMarkerState("droid"), { chunk: "spec mode\n", nowMs: T0 })).toBe("planning");
    // Waiting outranks planning when both are believed.
    const both = createTuiMarkerState("claude");
    scanTuiMarkers(both, { chunk: "⏸ plan mode on\n", nowMs: T0 });
    expect(scanTuiMarkers(both, { chunk: "Ready to code?\n", nowMs: T0 + 1_000 })).toBe("waiting-input");
  });
});
