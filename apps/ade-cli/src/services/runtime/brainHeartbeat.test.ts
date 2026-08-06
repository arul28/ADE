import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BRAIN_HEARTBEAT_STALE_MS,
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

  it("kills a stale beat whose writer is still alive", () => {
    expect(
      evaluateBrainHeartbeat({
        heartbeat,
        nowMs: heartbeat.ts + BRAIN_HEARTBEAT_STALE_MS + 1,
        pidAlive: alive,
        selfPid: 1,
      }),
    ).toEqual({
      action: "kill",
      ageMs: BRAIN_HEARTBEAT_STALE_MS + 1,
      pid: 4242,
      // Carried so the kill path can check identity without re-reading the file.
      heartbeat,
    });
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
