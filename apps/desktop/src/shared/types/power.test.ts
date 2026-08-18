import { describe, expect, it } from "vitest";
import {
  MACHINE_SLEEP_INFERENCE_WINDOW_MS,
  fromMachinePowerRecord,
  normalizeBatteryPercent,
  resolveMachinePresence,
  toMachinePowerRecord,
} from "./power";

const NOW = 1_800_000_000_000;

describe("resolveMachinePresence", () => {
  it("reports an announced suspend as asleep even while a channel still reads connected", () => {
    // The reported bug: a phone said "Connected" to a Mac with its lid shut.
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: NOW - 1_000,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("asleep");
  });

  it("prefers a live channel over the directory's online window", () => {
    expect(resolveMachinePresence({
      connected: true,
      online: false,
      sleepState: "awake",
      lastSeenAt: NOW - 5_000,
      now: NOW,
    })).toBe("connected");
  });

  it("reports a heartbeating machine as online", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: true,
      sleepState: "awake",
      lastSeenAt: NOW - 5_000,
      now: NOW,
    })).toBe("online");
  });

  it("infers asleep from recent silence when no announcement arrived", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: false,
      sleepState: null,
      lastSeenAt: NOW - 120_000,
      now: NOW,
    })).toBe("asleep");
  });

  it("stops inferring sleep once the silence outlives the inference window", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: false,
      sleepState: null,
      lastSeenAt: NOW - MACHINE_SLEEP_INFERENCE_WINDOW_MS,
      now: NOW,
    })).toBe("offline");
  });

  it("does not treat a stale awake announcement as evidence of life", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: false,
      sleepState: "awake",
      lastSeenAt: NOW - MACHINE_SLEEP_INFERENCE_WINDOW_MS - 1,
      now: NOW,
    })).toBe("offline");
  });

  it("reports a machine that has never been seen as offline", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: false,
      sleepState: null,
      lastSeenAt: null,
      now: NOW,
    })).toBe("offline");
  });

  it("stops treating an aged sleep announcement as fact", () => {
    // `sleep_state` is coalesced forward in the directory and has no path back
    // to NULL, so a machine downgraded to a build that omits `sleepState`
    // would otherwise read Asleep forever — outranking `connected` on every
    // client, with nothing the user could do about it.
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: NOW - MACHINE_SLEEP_INFERENCE_WINDOW_MS - 1,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("connected");
  });

  it("keeps trusting a sleep announcement inside the window", () => {
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: NOW - MACHINE_SLEEP_INFERENCE_WINDOW_MS + 1,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("asleep");
  });

  it("discards a sleep announcement it cannot date", () => {
    // Swift's `syncSleepAnnouncementIsStale` is the authoritative twin and has
    // always read an undated announcement as stale; TS honoured it, so the two
    // gates disagreed about the same record. An announcement with no stamp can
    // never age out, and `asleep` outranks `connected` — which is exactly the
    // unrecoverable stuck-Asleep state this gate exists to prevent.
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("connected");
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: null,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("connected");
  });

  it("treats a stamp exactly one window old as stale, as Swift does", () => {
    // The boundary is inclusive on both sides of the port. A one-millisecond
    // disagreement is still a disagreement about the same machine.
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: NOW - MACHINE_SLEEP_INFERENCE_WINDOW_MS,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("connected");
  });

  it("reads a future-dated sleep announcement as skew, not staleness", () => {
    expect(resolveMachinePresence({
      connected: true,
      online: true,
      sleepState: "asleep",
      sleepStateAt: NOW + 60_000,
      lastSeenAt: NOW - 1_000,
      now: NOW,
    })).toBe("asleep");
  });

  it("treats a future-dated heartbeat as recent rather than gone", () => {
    expect(resolveMachinePresence({
      connected: false,
      online: false,
      sleepState: undefined,
      lastSeenAt: NOW + 30_000,
      now: NOW,
    })).toBe("asleep");
  });
});

describe("machine power records", () => {
  it("keeps a battery-less machine battery-less across a round trip", () => {
    const record = toMachinePowerRecord({ onExternalPower: true });
    expect(record).toEqual({ batteryPercent: null, charging: null, onExternalPower: true });
    expect(fromMachinePowerRecord(record)).toEqual({ onExternalPower: true });
  });

  it("round-trips a battery reading", () => {
    const record = toMachinePowerRecord({
      battery: { percent: 42, charging: false },
      onExternalPower: false,
    });
    expect(record).toEqual({ batteryPercent: 42, charging: false, onExternalPower: false });
    expect(fromMachinePowerRecord(record)).toEqual({
      battery: { percent: 42, charging: false },
      onExternalPower: false,
    });
  });

  it("drops an out-of-range percent instead of showing it", () => {
    expect(fromMachinePowerRecord({
      batteryPercent: 240,
      charging: true,
      onExternalPower: true,
    })).toEqual({ onExternalPower: true });
  });

  it("normalizes raw platform percentages", () => {
    expect(normalizeBatteryPercent("87")).toBeNull();
    expect(normalizeBatteryPercent(Number.NaN)).toBeNull();
    expect(normalizeBatteryPercent(86.6)).toBe(87);
    expect(normalizeBatteryPercent(-3)).toBe(0);
    expect(normalizeBatteryPercent(140)).toBe(100);
  });
});
