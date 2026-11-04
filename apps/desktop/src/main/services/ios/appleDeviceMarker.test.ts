import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appleMarkerProjectHolds, type AppleDeviceMarker } from "./appleDeviceMarker";
import { remoteWorkLaneIdFor } from "../remoteWork/remoteWorkCopyService";

/**
 * "free" is the answer that lets another project's cleanup delete a simulator,
 * so a device a chat on another machine still drives through a work copy must
 * read "held", and a copy ADE cannot look at must read "unknown". The project
 * database is the stand-in (its rows are what a real one returns); the work
 * copy list and folders are real files.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { fs.chmodSync(path.join(root, "copies"), 0o700); } catch { /* not made */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const LIVE_OWNER = "remote:device-a:chat-live";
const GONE_OWNER = "remote:device-a:chat-gone";
// A permission bit does not stop root, and Windows has no POSIX modes.
const canDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;

/** A project whose work copy list names `LIVE_OWNER`'s copy, which is on disk. */
function projectWithLiveCopy(): { projectRoot: string; copies: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-holds-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const copies = path.join(root, "copies");
  const live = path.join(copies, "live");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".ade", "remote-work"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".ade", "ade.db"), "");
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(projectRoot, ".ade", "remote-work", "copies.json"), JSON.stringify({
    version: 1,
    copies: [{ owner: LIVE_OWNER, path: live, head: "abc", branch: null, machineName: null, syncedTree: null, createdAt: at, lastUsedAt: at }],
  }));
  return { projectRoot, copies };
}

/** A project database with no lane row for the device, and these work-copy rows. */
const databaseWithRemoteRows = (laneIds: string[]) => () => ({
  prepare: (sql: string) => ({
    get: () => (sql.includes("join lanes") ? undefined : laneIds[0] ? { laneId: laneIds[0] } : undefined),
    all: () => (sql.includes("join lanes") ? [] : laneIds.map((laneId) => ({ laneId }))),
  }),
  close: () => {},
});

const marker = (projectRoot: string, over: Partial<AppleDeviceMarker> = {}): AppleDeviceMarker => ({
  version: 1,
  projectRoot,
  laneId: "lane-unrelated",
  name: "ADE · lane",
  createdAt: new Date(0).toISOString(),
  ...over,
});

describe("appleMarkerProjectHolds — work copies", () => {
  it("holds a device whose rows include a live work-copy lane after a gone one", () => {
    const { projectRoot } = projectWithLiveCopy();
    const answer = appleMarkerProjectHolds(
      marker(projectRoot),
      "UDID-1",
      databaseWithRemoteRows([remoteWorkLaneIdFor(GONE_OWNER), remoteWorkLaneIdFor(LIVE_OWNER)]),
      () => null,
    );
    expect(answer).toBe("held");
  });

  it.skipIf(!canDenyReads)("reads a work copy it cannot look at as unknown, never gone", () => {
    const { projectRoot, copies } = projectWithLiveCopy();
    fs.chmodSync(copies, 0o000);
    try {
      const answer = appleMarkerProjectHolds(
        marker(projectRoot, { laneId: remoteWorkLaneIdFor(LIVE_OWNER) }),
        "UDID-1",
        databaseWithRemoteRows([]),
        () => null,
      );
      expect(answer).toBe("unknown");
    } finally {
      fs.chmodSync(copies, 0o700);
    }
  });
});
