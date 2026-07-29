import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearRuntimeSpawnRecord,
  hasRecentRuntimeSpawn,
  readRuntimeSpawnRecord,
  recordRuntimeSpawn,
  RUNTIME_SPAWN_RECORD_GRACE_MS,
  runtimeSpawnRecordPath,
} from "./runtimeSpawnRecord";

const sockets = ["/tmp/ade-runtime-spawn-record-test.sock", "/tmp/other/ade.sock"];
const originalAdeHome = process.env.ADE_HOME;
let tempAdeHome = "";

// Records live under the machine ADE home; without an override the suite would
// write into the developer's real ~/.ade.
beforeAll(() => {
  tempAdeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-spawn-record-home-"));
  process.env.ADE_HOME = tempAdeHome;
});

afterAll(() => {
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
  if (tempAdeHome) fs.rmSync(tempAdeHome, { recursive: true, force: true });
});

afterEach(() => {
  for (const socketPath of sockets) {
    fs.rmSync(runtimeSpawnRecordPath(socketPath), { force: true });
  }
});

describe("runtimeSpawnRecord", () => {
  const socketPath = sockets[0]!;

  it("reports no recent spawn when nothing was recorded", () => {
    expect(readRuntimeSpawnRecord(socketPath)).toBe(null);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(false);
  });

  it("suppresses a duplicate spawn while the recorded brain is alive and recent", () => {
    recordRuntimeSpawn(socketPath, process.pid);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(true);
  });

  // A wedged brain must not block recovery forever, so the record expires.
  it("allows a new spawn once the grace window lapses", () => {
    recordRuntimeSpawn(socketPath, process.pid);
    const later = Date.now() + RUNTIME_SPAWN_RECORD_GRACE_MS + 1;
    expect(hasRecentRuntimeSpawn(socketPath, later)).toBe(false);
  });

  it("allows a new spawn when the recorded brain is gone", () => {
    // pid 1 is always alive, so use an implausible-but-valid pid instead.
    recordRuntimeSpawn(socketPath, 2_147_483_646);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(false);
  });

  // A deliberate shutdown makes the record stale immediately: the pid may
  // outlive the shutdown, and the replacement spawn must not be suppressed.
  it("stops suppressing once the record is cleared", () => {
    recordRuntimeSpawn(socketPath, process.pid);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(true);
    clearRuntimeSpawnRecord(socketPath);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(false);
  });

  it("keys records per socket so one socket's spawn cannot gate another's", () => {
    recordRuntimeSpawn(socketPath, process.pid);
    expect(hasRecentRuntimeSpawn(sockets[1]!)).toBe(false);
    expect(runtimeSpawnRecordPath(socketPath)).not.toBe(runtimeSpawnRecordPath(sockets[1]!));
  });

  it("treats a corrupt record as absent rather than throwing", () => {
    const recordPath = runtimeSpawnRecordPath(socketPath);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, "not-json", "utf8");
    expect(readRuntimeSpawnRecord(socketPath)).toBe(null);
    expect(hasRecentRuntimeSpawn(socketPath)).toBe(false);
  });
});
