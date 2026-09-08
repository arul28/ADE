import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { LoginImportReadRequest } from "./loginImportRead";
import { readLoginImportSourceInWorker } from "./loginImportReadWorkerClient";

const REQUEST: LoginImportReadRequest = {
  engine: "chromium",
  cookieDatabasePath: "/tmp/does-not-matter/Cookies",
  platform: "darwin",
  keychainService: "Chrome Safe Storage",
  keychainAccount: "Chrome",
  chromiumUserDataDirectory: "/tmp/does-not-matter",
};

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

describe("readLoginImportSourceInWorker", () => {
  it("sends the request on stdin and resolves the worker's answer", async () => {
    const child = fakeChild();
    const spawnWorker = vi.fn(() => child) as never;
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));

    const pending = readLoginImportSourceInWorker(REQUEST, { spawnWorker, workerPath: "/w.cjs" });
    child.stdout.write(JSON.stringify({ ok: true, cookies: [], unreadable: 2 }));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true, cookies: [], unreadable: 2 });
    expect(JSON.parse(written.join(""))).toEqual(REQUEST);
  });

  it("passes a classified failure straight through", async () => {
    const child = fakeChild();
    const pending = readLoginImportSourceInWorker(REQUEST, {
      spawnWorker: (() => child) as never,
      workerPath: "/w.cjs",
    });
    child.stdout.write(JSON.stringify({
      ok: false,
      status: "needs_full_disk_access",
      reason: "ADE needs Full Disk Access to read Safari's cookies.",
    }));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({
      ok: false,
      status: "needs_full_disk_access",
      reason: "ADE needs Full Disk Access to read Safari's cookies.",
    });
  });

  it("reports a worker that dies without answering rather than hanging", async () => {
    const child = fakeChild();
    const pending = readLoginImportSourceInWorker(REQUEST, {
      spawnWorker: (() => child) as never,
      workerPath: "/w.cjs",
    });
    child.emit("close", 1);
    await expect(pending).resolves.toEqual({
      ok: false,
      status: "read_failed",
      reason: "The login import helper exited without answering.",
    });
  });

  it("reports unreadable worker output rather than throwing into the IPC handler", async () => {
    const child = fakeChild();
    const pending = readLoginImportSourceInWorker(REQUEST, {
      spawnWorker: (() => child) as never,
      workerPath: "/w.cjs",
    });
    child.stdout.write("not json");
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ ok: false, status: "read_failed" });
  });

  it("reports a spawn failure", async () => {
    const child = fakeChild();
    const pending = readLoginImportSourceInWorker(REQUEST, {
      spawnWorker: (() => child) as never,
      workerPath: "/w.cjs",
    });
    child.emit("error", new Error("EACCES"));
    await expect(pending).resolves.toEqual({
      ok: false,
      status: "read_failed",
      reason: "EACCES",
    });
  });
});
