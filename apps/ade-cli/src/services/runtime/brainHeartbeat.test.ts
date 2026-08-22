import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BRAIN_HEARTBEAT_STALE_MS,
  BRAIN_WATCHER_CHECK_INTERVAL_MS,
  brainWatcherSuspendFloorMs,
  evaluateBrainHeartbeat,
  parseBrainHeartbeat,
  readBrainHeartbeat,
  startBrainHeartbeat,
  writeBrainHeartbeat,
} from "./brainHeartbeat";

function tempRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-heartbeat-"));
}

const alive = () => true;
const dead = () => false;

describe("parseBrainHeartbeat", () => {
  it("rejects records that cannot identify a process", () => {
    expect(parseBrainHeartbeat("not json")).toBeNull();
    expect(parseBrainHeartbeat(JSON.stringify({ ts: 1, seq: 0 }))).toBeNull();
    expect(parseBrainHeartbeat(JSON.stringify({ pid: 0, ts: 1, seq: 0 }))).toBeNull();
    expect(parseBrainHeartbeat(JSON.stringify({ pid: 7, seq: 0 }))).toBeNull();
  });

  it("defaults startedAt to the beat timestamp for older records", () => {
    expect(parseBrainHeartbeat(JSON.stringify({ pid: 7, ts: 100, seq: 2 }))).toEqual({
      pid: 7,
      ts: 100,
      seq: 2,
      startedAt: 100,
    });
  });
});

describe("evaluateBrainHeartbeat", () => {
  const heartbeat = { pid: 4242, ts: 1_000_000, seq: 9, startedAt: 900_000 };

  it("treats an absent heartbeat as no judgement, never as a wedge", () => {
    expect(
      evaluateBrainHeartbeat({ heartbeat: null, nowMs: 9_999_999, pidAlive: alive }),
    ).toEqual({ action: "absent" });
  });

  it("reports a fresh beat as healthy", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS,
        pidAlive: alive,
        selfPid: 1,
      }),
    ).toEqual({ action: "healthy", ageMs: BRAIN_HEARTBEAT_STALE_MS, pid: 4242 });
  });

  /** The watcher ran on time, and already saw this exact beat stale. */
  const confirmedWedge = {
    watcherGapMs: BRAIN_WATCHER_CHECK_INTERVAL_MS,
    previousStaleBeat: { pid: heartbeat.pid, ts: heartbeat.ts },
  };

  it("kills a stale beat whose writer is still alive", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS + 1,
        pidAlive: alive,
        selfPid: 1,
        ...confirmedWedge,
      }),
    ).toEqual({
      action: "kill",
      ageMs: BRAIN_HEARTBEAT_STALE_MS + 1,
      pid: 4242,
      // Carried so the kill path can check identity without re-reading the file.
      heartbeat,
    });
  });

  it("waits for a second check before killing a beat it has only just seen stale", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS + 1,
        pidAlive: alive,
        selfPid: 1,
        watcherGapMs: BRAIN_WATCHER_CHECK_INTERVAL_MS,
        previousStaleBeat: null,
      }),
    ).toEqual({
      action: "stale_unconfirmed",
      ageMs: BRAIN_HEARTBEAT_STALE_MS + 1,
      pid: 4242,
      heartbeat,
    });
  });

  it("kills again once the brain writes a new beat and wedges on that one", () => {
    // A beat the watcher remembers from an earlier silence must not confirm a
    // different one: the brain beat in between, so this silence is new.
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS + 1,
        pidAlive: alive,
        selfPid: 1,
        watcherGapMs: BRAIN_WATCHER_CHECK_INTERVAL_MS,
        previousStaleBeat: { pid: heartbeat.pid, ts: heartbeat.ts - 60_000 },
      }).action,
    ).toBe("stale_unconfirmed");
  });

  it("blames a machine that slept, not the brain that slept with it", () => {
    // 12 minutes of silence, and the 60-second watcher was 12 minutes late too.
    const gapMs = 12 * 60_000;
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + gapMs,
        pidAlive: alive,
        selfPid: 1,
        watcherGapMs: gapMs,
        previousStaleBeat: { pid: heartbeat.pid, ts: heartbeat.ts },
      }),
    ).toEqual({
      action: "machine_slept",
      ageMs: gapMs,
      pid: 4242,
      watcherGapMs: gapMs,
    });
  });

  it("still kills a brain that went quiet long before the machine slept", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        // Silent for three days; the nap explains ten minutes of that.
        nowMs: heartbeat.ts + 3 * 24 * 60 * 60_000,
        pidAlive: alive,
        selfPid: 1,
        watcherGapMs: 10 * 60_000,
        previousStaleBeat: { pid: heartbeat.pid, ts: heartbeat.ts },
      }).action,
    ).toBe("kill");
  });

  it("does not excuse an ordinary check cadence as a suspension", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS + 1,
        pidAlive: alive,
        selfPid: 1,
        watcherGapMs: BRAIN_WATCHER_CHECK_INTERVAL_MS + 5_000,
        previousStaleBeat: { pid: heartbeat.pid, ts: heartbeat.ts },
      }).action,
    ).toBe("kill");
  });

  it("leaves a stale beat alone when the writer already exited", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + 10 * BRAIN_HEARTBEAT_STALE_MS,
        pidAlive: dead,
        selfPid: 1,
      }).action,
    ).toBe("already_exited");
  });

  it("never judges its own heartbeat", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + 10 * BRAIN_HEARTBEAT_STALE_MS,
        pidAlive: alive,
        selfPid: heartbeat.pid,
      }),
    ).toEqual({ action: "self", pid: 4242 });
  });

  it("treats a clock step that puts the beat in the future as healthy", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts - 10 * BRAIN_HEARTBEAT_STALE_MS,
        pidAlive: alive,
        selfPid: 1,
      }),
    ).toEqual({ action: "healthy", ageMs: 0, pid: 4242 });
  });
});

describe("heartbeat file round trip", () => {
  it("writes a heartbeat an external reader can parse", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 11, ts: 500, seq: 1, startedAt: 400 });
    expect(readBrainHeartbeat(runtimeDir)).toEqual({
      pid: 11,
      ts: 500,
      seq: 1,
      startedAt: 400,
    });
  });

  it("replaces an existing heartbeat and leaves no temp files behind", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 11, ts: 500, seq: 1, startedAt: 400 });
    writeBrainHeartbeat(runtimeDir, { pid: 11, ts: 900, seq: 2, startedAt: 400 });
    expect(readBrainHeartbeat(runtimeDir)?.ts).toBe(900);
    expect(fs.readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads an unreadable heartbeat as absent rather than stale", () => {
    const runtimeDir = tempRuntimeDir();
    fs.writeFileSync(path.join(runtimeDir, "heartbeat.json"), "{ truncated");
    expect(readBrainHeartbeat(runtimeDir)).toBeNull();
  });
});

describe("startBrainHeartbeat", () => {
  it("beats immediately and removes the file when stopped", () => {
    const runtimeDir = tempRuntimeDir();
    const stop = startBrainHeartbeat({
      runtimeDir,
      pid: 777,
      now: () => 12_345,
      env: {},
    });
    expect(readBrainHeartbeat(runtimeDir)).toEqual({
      pid: 777,
      ts: 12_345,
      seq: 1,
      startedAt: 12_345,
    });
    stop();
    expect(readBrainHeartbeat(runtimeDir)).toBeNull();
  });

  it("records the suspension a late beat closes", () => {
    const runtimeDir = tempRuntimeDir();
    let clock = 1_000_000;
    const timers: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    // The brain's interval fires once, twelve minutes late: the shape of a
    // process the OS stopped scheduling.
    globalThis.setInterval = ((handler: () => void) => {
      timers.push(handler);
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval;
    try {
      const stop = startBrainHeartbeat({
        runtimeDir,
        pid: 777,
        intervalMs: 15_000,
        now: () => clock,
        env: {},
      });
      expect(readBrainHeartbeat(runtimeDir)?.suspendGapMs).toBeUndefined();
      clock += 12 * 60_000;
      timers[0]?.();
      expect(readBrainHeartbeat(runtimeDir)?.suspendGapMs).toBe(12 * 60_000);
      stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  it("reports the suspension through warn when no info sink is wired", () => {
    const runtimeDir = tempRuntimeDir();
    let clock = 1_000_000;
    const timers: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((handler: () => void) => {
      timers.push(handler);
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval;
    const warned: Array<[string, Record<string, unknown>]> = [];
    try {
      const stop = startBrainHeartbeat({
        runtimeDir,
        pid: 777,
        intervalMs: 15_000,
        now: () => clock,
        env: {},
        warn: (event, meta) => warned.push([event, meta]),
      });
      clock += 12 * 60_000;
      timers[0]?.();
      stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(warned).toEqual([
      ["brain.suspend_gap", { source: "heartbeat", gapMs: 12 * 60_000 }],
    ]);
  });

  it("prefers the info sink over warn for the suspension", () => {
    const runtimeDir = tempRuntimeDir();
    let clock = 1_000_000;
    const timers: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((handler: () => void) => {
      timers.push(handler);
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval;
    const infos: string[] = [];
    const warned: string[] = [];
    try {
      const stop = startBrainHeartbeat({
        runtimeDir,
        pid: 777,
        intervalMs: 15_000,
        now: () => clock,
        env: {},
        info: (event) => infos.push(event),
        warn: (event) => warned.push(event),
      });
      clock += 12 * 60_000;
      timers[0]?.();
      stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(infos).toEqual(["brain.suspend_gap"]);
    expect(warned).toEqual([]);
  });

  it("sizes the suspension floor above any ordinary check cadence", () => {
    expect(brainWatcherSuspendFloorMs({})).toBe(3 * BRAIN_WATCHER_CHECK_INTERVAL_MS);
    expect(brainWatcherSuspendFloorMs({ checkIntervalMs: 15_000 })).toBe(BRAIN_HEARTBEAT_STALE_MS);
  });

  it("publishes nothing when heartbeats are disabled", () => {
    const runtimeDir = tempRuntimeDir();
    const stop = startBrainHeartbeat({
      runtimeDir,
      pid: 777,
      env: { ADE_DISABLE_BRAIN_HEARTBEAT: "1" },
    });
    expect(readBrainHeartbeat(runtimeDir)).toBeNull();
    stop();
  });
});
