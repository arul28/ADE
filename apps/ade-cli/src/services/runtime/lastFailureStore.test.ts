import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdeLastFailureReport } from "../../../../desktop/src/shared/types/recovery";
import {
  clearLastFailure,
  computeStartupBackoffMs,
  lastFailurePathForMachine,
  lastFailurePathForProject,
  readLastFailure,
  recordLastFailure,
} from "../../../../desktop/src/main/services/runtime/lastFailureStore";

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lastFailureStore", () => {
  it("uses the machine and project runtime paths", () => {
    const home = makeRoot("ade-last-failure-home-");
    const projectRoot = makeRoot("ade-last-failure-project-");
    expect(lastFailurePathForMachine({ ADE_HOME: home })).toBe(path.join(home, "runtime", "last-failure.json"));
    expect(lastFailurePathForProject(projectRoot)).toBe(path.join(projectRoot, ".ade", "runtime", "last-failure.json"));
  });

  it("increments identical signatures and keeps the first timestamp", () => {
    const home = makeRoot("ade-last-failure-count-");
    const target = { kind: "machine" as const, env: { ADE_HOME: home } };
    recordLastFailure(target, {
      code: "disk_full",
      component: "project_db_open",
      projectRoot: "/project-a",
      message: "first",
      at: "2026-07-12T10:00:00.000Z",
    });
    recordLastFailure(target, {
      code: "disk_full",
      component: "project_db_open",
      projectRoot: "/project-a",
      message: "second",
      at: "2026-07-12T10:00:10.000Z",
    });
    expect(readLastFailure(target)).toMatchObject({
      count: 2,
      firstAt: "2026-07-12T10:00:00.000Z",
      at: "2026-07-12T10:00:10.000Z",
      message: "second",
    });
  });

  it("keeps exactly one previous incident when the signature changes", () => {
    const home = makeRoot("ade-last-failure-prev-");
    const target = { kind: "machine" as const, env: { ADE_HOME: home } };
    for (const code of ["disk_full", "db_integrity", "migration_incomplete"] as const) {
      recordLastFailure(target, { code, component: "brain_startup", message: code });
    }
    const runtimeDir = path.join(home, "runtime");
    expect(fs.readdirSync(runtimeDir).filter((name) => name.startsWith("last-failure")).sort()).toEqual([
      "last-failure.json",
      "last-failure.prev.json",
    ]);
    const previous = JSON.parse(fs.readFileSync(path.join(runtimeDir, "last-failure.prev.json"), "utf8"));
    expect(previous.code).toBe("db_integrity");
  });

  it("leaves the existing JSON valid when the atomic rename fails", () => {
    const home = makeRoot("ade-last-failure-atomic-");
    const target = { kind: "machine" as const, env: { ADE_HOME: home } };
    recordLastFailure(target, { code: "disk_full", component: "brain_startup", message: "first" });
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".last-failure.json.tmp-")) throw new Error("injected rename failure");
      return originalRename(from, to);
    });
    expect(recordLastFailure(target, {
      code: "disk_full",
      component: "brain_startup",
      message: "second",
    })).toBeNull();
    expect(() => JSON.parse(fs.readFileSync(lastFailurePathForMachine({ ADE_HOME: home }), "utf8"))).not.toThrow();
    expect(readLastFailure(target)?.message).toBe("first");
  });

  const primarySocket = "/home/.ade/sock/ade.sock";
  const isolatedSocket = "/home/.ade/sock/i-41d6ff7a.sock";
  // The socket columns: where the recorded failure happened, and the socket of
  // the brain that is starting (undefined = no scope given). A desktop's
  // isolated brain slept 60 s for the service's socket fight (ADE-DESKTOP-8).
  it.each([
    [2, "2026-07-12T10:00:00.000Z", 0, undefined, undefined],
    [3, "2026-07-12T10:00:00.000Z", 10_000, undefined, undefined],
    [4, "2026-07-12T10:00:00.000Z", 20_000, undefined, undefined],
    [8, "2026-07-12T10:00:00.000Z", 60_000, undefined, undefined],
    [20, "2026-07-12T09:54:59.999Z", 0, undefined, undefined],
    [8, "2026-07-12T10:00:00.000Z", 0, primarySocket, isolatedSocket],
    [8, "2026-07-12T10:00:00.000Z", 0, undefined, isolatedSocket],
    [8, "2026-07-12T10:00:00.000Z", 60_000, undefined, primarySocket],
    [8, "2026-07-12T10:00:00.000Z", 60_000, isolatedSocket, isolatedSocket],
  ])("computes bounded startup backoff for count %i (window from %s) as %i ms, failure on %s, starting on %s", (
    count,
    firstAt,
    expected,
    recordedSocket,
    startingSocket,
  ) => {
    const report: AdeLastFailureReport = {
      version: 1,
      code: "socket_owned_by_other",
      message: "failure",
      at: "2026-07-12T10:00:00.000Z",
      component: "brain_startup",
      count,
      firstAt,
      ...(recordedSocket ? { socketPath: recordedSocket } : {}),
    };
    const scope = startingSocket ? { socketPath: startingSocket, primarySocketPath: primarySocket } : undefined;
    expect(computeStartupBackoffMs(report, Date.parse("2026-07-12T10:00:00.000Z"), scope)).toBe(expected);
  });

  it("moves the current incident to previous when cleared", () => {
    const projectRoot = makeRoot("ade-last-failure-clear-");
    const target = { kind: "project" as const, projectRoot };
    recordLastFailure(target, { code: "db_integrity", component: "project_db_open", message: "bad db" });
    clearLastFailure(target);
    expect(readLastFailure(target)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, ".ade", "runtime", "last-failure.prev.json"), "utf8"))).toMatchObject({
      code: "db_integrity",
    });
  });
});
