import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerPool, type CodexAppServerClient, type CodexAppServerLine } from "./codexAppServerPool";

type FakeAppServer = ChildProcessWithoutNullStreams & {
  /** What ADE wrote to the app-server, one parsed JSON-RPC message per line. */
  written: CodexAppServerLine[];
  /** A line from the app-server. */
  say: (line: CodexAppServerLine) => void;
};

function fakeAppServer(): FakeAppServer {
  const proc = new EventEmitter() as FakeAppServer;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  proc.written = [];
  Object.assign(proc, {
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    stdin: {
      writable: true,
      write: (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) proc.written.push(JSON.parse(line));
        return true;
      },
    },
  });
  proc.say = (line) => stdout.write(`${JSON.stringify(line)}\n`);
  return proc;
}

/** Lets readline hand the written lines over (and any setImmediate flush run). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function chat(label: string, threads: string[] = []) {
  const owned = new Set(threads);
  const delivered: CodexAppServerLine[] = [];
  const exits: Array<number | null> = [];
  const client: CodexAppServerClient = {
    label,
    ownsThread: (threadId) => owned.has(threadId),
    awaitingThread: () => owned.size === 0,
    deliver: (line) => { delivered.push(line); },
    onProcessError: () => {},
    onProcessExit: (code) => { exits.push(code); },
  };
  return { client, owned, delivered, exits };
}

function setup() {
  const proc = fakeAppServer();
  const terminate = vi.fn(() => null);
  const pool = createCodexAppServerPool({
    terminate,
    threadIdOf: (params) => {
      const record = params as { threadId?: string; thread?: { id?: string } } | undefined;
      return record?.threadId ?? record?.thread?.id;
    },
    parseLine: (raw) => {
      try { return JSON.parse(raw) as CodexAppServerLine; } catch { return null; }
    },
    onStderr: () => {},
  });
  const host = pool.acquire({ key: "same-launch", spawn: () => proc });
  return { proc, terminate, pool, host };
}

describe("codexAppServerPool", () => {
  it("gives each chat on a shared app-server only its own thread's events, approvals and responses", async () => {
    const { proc, pool, host } = setup();
    const a = chat("chat-a", ["thread-a"]);
    const b = chat("chat-b", ["thread-b"]);
    host.attach(a.client);
    expect(pool.acquire({ key: "same-launch", spawn: () => fakeAppServer() })).toBe(host);
    host.attach(b.client);

    const id = host.nextRequestId();
    const answered: CodexAppServerLine[] = [];
    host.expectResponse(id, a.client, (line) => answered.push(line));
    proc.say({ method: "item/agentMessage/delta", params: { threadId: "thread-a", delta: "secret of a" } });
    proc.say({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-b", command: "rm -rf build" } });
    proc.say({ method: "account/rateLimits/updated", params: { rateLimits: {} } });
    proc.say({ id, result: { ok: true } });
    await settle();

    expect(a.delivered.map((line) => line.method)).toEqual(["item/agentMessage/delta", "account/rateLimits/updated"]);
    expect(b.delivered.map((line) => line.method)).toEqual(["item/commandExecution/requestApproval", "account/rateLimits/updated"]);
    expect(answered).toEqual([{ id, result: { ok: true } }]);
  });

  it("holds a new thread's first lines for the chat that starts it, and keeps a departed chat's lines from the others", async () => {
    const { proc, host, terminate } = setup();
    const starting = chat("chat-starting");
    const other = chat("chat-other", ["thread-other"]);
    host.attach(starting.client);
    host.attach(other.client);

    // Codex announces a new thread before thread/start answers with its id.
    proc.say({ method: "thread/started", params: { thread: { id: "thread-new" } } });
    proc.say({ method: "mcpServer/startupStatus/updated", params: { threadId: "thread-new", status: "starting" } });
    await settle();
    expect(starting.delivered).toEqual([]);
    expect(other.delivered).toEqual([]);

    const id = host.nextRequestId();
    host.expectResponse(id, starting.client, () => { starting.owned.add("thread-new"); });
    proc.say({ id, result: { thread: { id: "thread-new" } } });
    await settle();
    await settle();
    expect(starting.delivered.map((line) => line.method)).toEqual(["thread/started", "mcpServer/startupStatus/updated"]);

    // The chat leaves; its interrupted turn still reports, and still asks.
    expect(host.detach(starting.client, ["thread-new"])).toBe(1);
    proc.say({ method: "turn/completed", params: { threadId: "thread-new", turn: { id: "t1", status: "interrupted" } } });
    proc.say({ id: 9, method: "item/fileChange/requestApproval", params: { threadId: "thread-new" } });
    await settle();
    expect(other.delivered).toEqual([]);
    expect(proc.written).toContainEqual(expect.objectContaining({ id: 9, error: expect.objectContaining({ code: -32001 }) }));
    expect(terminate).not.toHaveBeenCalled();
  });

  it("unloads a thread a departed chat's request created, tells every chat when the process dies, and stops it with the last chat", async () => {
    const { proc, host, terminate } = setup();
    const leaving = chat("chat-leaving");
    const staying = chat("chat-staying", ["thread-staying"]);
    host.attach(leaving.client);
    host.attach(staying.client);

    const startId = host.nextRequestId();
    const leavingHeard = vi.fn();
    host.expectResponse(startId, leaving.client, leavingHeard);
    host.detach(leaving.client);
    proc.say({ id: startId, result: { thread: { id: "thread-orphan" } } });
    await settle();
    expect(leavingHeard).not.toHaveBeenCalled();
    expect(proc.written).toContainEqual(expect.objectContaining({ method: "thread/unsubscribe", params: { threadId: "thread-orphan" } }));

    proc.emit("exit", null, "SIGKILL");
    expect(staying.exits).toEqual([null]);
    expect(leaving.exits).toEqual([]);

    const { host: next, proc: nextProc, terminate: nextTerminate } = setup();
    const only = chat("chat-only", ["thread-only"]);
    next.attach(only.client);
    expect(next.detach(only.client, ["thread-only"])).toBe(0);
    expect(nextTerminate).toHaveBeenCalledWith(nextProc, null);
    expect(terminate).not.toHaveBeenCalled();
  });
});
