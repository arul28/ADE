import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESSAGES_READ_WORKER_TIMEOUT_MS,
  readMessagesInWorker,
  terminateMessagesReadWorkers,
} from "./messagesReadWorkerClient";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function optionsFor(child: FakeChild) {
  return {
    spawnWorker: (() => child) as never,
    workerPath: "/messagesReadWorker.cjs",
  };
}

afterEach(() => {
  vi.useRealTimers();
  terminateMessagesReadWorkers();
});

describe("readMessagesInWorker", () => {
  it("sends the request on stdin and resolves a recent-messages answer", async () => {
    const child = fakeChild();
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));

    const pending = readMessagesInWorker(
      { op: "recent", limit: 3, handle: "+1 555 123 4567" },
      optionsFor(child),
    );
    child.stdout.write(JSON.stringify({ ok: true, op: "recent", messages: [] }));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true, op: "recent", messages: [] });
    expect(JSON.parse(written.join(""))).toEqual({
      op: "recent",
      limit: 3,
      handle: "+1 555 123 4567",
    });
  });

  it("resolves a chats answer", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "chats", limit: 5 }, optionsFor(child));
    child.stdout.write(JSON.stringify({
      ok: true,
      op: "chats",
      chats: [{
        chatGuid: "iMessage;-;+15551234567",
        chatName: null,
        isGroup: false,
        lastMessageAt: "2026-11-13T00:00:00.000Z",
        participants: ["+15551234567"],
      }],
    }));
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      op: "chats",
      chats: [{ isGroup: false, participants: ["+15551234567"] }],
    });
  });

  it("passes a classified failure straight through", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "access" }, optionsFor(child));
    child.stdout.write(JSON.stringify({
      ok: false,
      code: "needs_full_disk_access",
      message: "ADE needs Full Disk Access to read Messages.",
    }));
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({
      ok: false,
      code: "needs_full_disk_access",
      message: "ADE needs Full Disk Access to read Messages.",
    });
  });

  it("reports a worker that dies without answering rather than hanging", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "access" }, optionsFor(child));
    child.emit("close", 1);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "error" });
  });

  it("rejects unreadable worker output instead of returning an empty list", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "recent" }, optionsFor(child));
    child.stdout.write("not json");
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "error" });
  });

  it("rejects a success answer whose payload is missing", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "recent" }, optionsFor(child));
    child.stdout.write(JSON.stringify({ ok: true, op: "recent" }));
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ ok: false, code: "error" });
  });

  it("reports a spawn failure and kills the child", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "access" }, optionsFor(child));
    child.emit("error", new Error("EACCES"));

    await expect(pending).resolves.toMatchObject({ ok: false, code: "error", message: "EACCES" });
    expect(child.kill).toHaveBeenCalled();
    expect(terminateMessagesReadWorkers()).toBe(0);
  });

  it("gives up after the timeout rather than waiting forever", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "access" }, optionsFor(child));

    vi.advanceTimersByTime(MESSAGES_READ_WORKER_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      code: "error",
      message: "The Messages helper did not answer in time.",
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("answers unsupported_platform without spawning when the worker file is absent", async () => {
    // Off macOS the client refuses before touching the filesystem; on macOS a
    // missing bundled worker is a build error, not a permission problem.
    const pending = readMessagesInWorker({ op: "access" }, {
      workerPath: "/definitely/not/a/real/messages-worker.cjs",
    });
    if (process.platform === "darwin") {
      await expect(pending).resolves.toMatchObject({ ok: false, code: "error" });
    } else {
      await expect(pending).resolves.toMatchObject({ ok: false, code: "unsupported_platform" });
    }
  });

  it("kills every in-flight child at app quit", async () => {
    const child = fakeChild();
    const pending = readMessagesInWorker({ op: "access" }, optionsFor(child));

    expect(terminateMessagesReadWorkers()).toBe(1);
    expect(child.kill).toHaveBeenCalled();

    child.emit("close", 143);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "error" });
    expect(terminateMessagesReadWorkers()).toBe(0);
  });
});
