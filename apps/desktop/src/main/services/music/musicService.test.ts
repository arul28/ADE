import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Music service against a fake player host: the child process is faked at
 * `spawn` and speaks the host's NDJSON protocol (`musicHostProcess.ts`), and
 * Apple's API is faked at `fetch`.
 */
type Command = { cmd: string; rid?: string; [key: string]: unknown };

const hosts = vi.hoisted(() => ({
  list: [] as Array<EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    commands: Array<{ cmd: string; rid?: string; [key: string]: unknown }>;
    exit: (code?: number) => void;
    kill: () => boolean;
  }>,
  /** Whether a host leaves as soon as it is told to quit. */
  exitOnQuit: true,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const host = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 5000 + hosts.list.length,
        exitCode: null as number | null,
        signalCode: null as string | null,
        commands: [] as Command[],
        queue: [] as string[],
        exit(code = 0) {
          if (host.exitCode !== null) return;
          host.exitCode = code;
          host.emit("exit", code, null);
        },
        kill: () => {
          host.exit(1);
          return true;
        },
      });
      const send = (line: unknown) => host.stdout.write(`${JSON.stringify(line)}\n`);
      const reply = (rid: string | undefined, result: unknown) => send({ reply: rid, ok: true, result });
      createInterface({ input: host.stdin }).on("line", (line) => {
        const command = JSON.parse(line) as Command;
        host.commands.push(command);
        switch (command.cmd) {
          case "quit":
            if (hosts.exitOnQuit) setImmediate(() => host.exit(0));
            return;
          case "playItems":
            host.queue = command.ids as string[];
            return reply(command.rid, { state: "playing", isPlaying: true, queueLength: host.queue.length, queuePosition: command.index });
          case "pause":
            return reply(command.rid, { state: "paused", isPlaying: false });
          case "resume":
            return reply(command.rid, { state: "playing", isPlaying: true });
          case "snapshot":
            return reply(command.rid, { ids: host.queue, index: 0, position: 42, shuffle: 0, repeat: 0, volume: 1, nowPlaying: null });
          default:
            return reply(command.rid, { ready: true });
        }
      });
      setImmediate(() => {
        send({ event: "hostReady", browserPid: 1 });
        send({ event: "loaded" });
      });
      hosts.list.push(host);
      return host;
    },
  };
});

const { createMusicService } = await import("./musicService");

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-music-service-"));
  dirs.push(dir);
  return dir;
}

/** Apple's catalog: which of the asked song ids still exist. */
let catalogSongs = new Set<string>();
const fetchImpl = vi.fn(async (url: string | URL) => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith("/songs")) {
    const ids = (parsed.searchParams.get("ids") ?? "").split(",").filter((id) => catalogSongs.has(id));
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id, type: "songs" })) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

function service() {
  const dir = tempDir();
  const executable = path.join(dir, "ade-music-host.exe");
  fs.writeFileSync(executable, "");
  const stored = new Map<string, string>([["music.appleMusic.userToken", "user-token"]]);
  const music = createMusicService({
    hostExecutable: executable,
    isPackaged: true,
    userDataDir: path.join(dir, "profile"),
    appVersion: "1.0.0",
    tokens: { get: async () => ({ token: "developer-token", expiresAt: Date.now() + 86_400_000, source: "worker" as const }) },
    credentials: {
      get: async (key) => stored.get(key) ?? null,
      set: async (key, value) => { stored.set(key, value); },
      delete: async (key) => { stored.delete(key); },
    },
    broadcast: () => {},
    idleUnloadMs: 1_000,
    fetchImpl,
  });
  return { music, stored };
}

/** Lets the fake host's streams and the service's promises run. */
async function settle(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

const commandsOf = (index: number, cmd: string) => hosts.list[index]!.commands.filter((command) => command.cmd === cmd);

beforeEach(() => {
  hosts.list.length = 0;
  hosts.exitOnQuit = true;
  catalogSongs = new Set();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("music service: the player host's lifetime", () => {
  it("waits for an unloading player to leave before starting the next, then picks up the same queue", async () => {
    const { music } = service();
    await music.command({ type: "playItems", ids: ["l.song-1", "l.song-2"], index: 0 });
    await music.command({ type: "pause" });
    expect(hosts.list).toHaveLength(1);

    // The idle unload starts, and this player is slow to leave.
    hosts.exitOnQuit = false;
    const unloading = music.unloadPlayer();
    await settle();
    expect(commandsOf(0, "quit")).toHaveLength(1);

    // Play arrives while it is still on its way out: no second player yet.
    const playing = music.command({ type: "play" });
    await settle();
    expect(hosts.list).toHaveLength(1);

    hosts.list[0]!.exit(0);
    await unloading;
    expect(await playing).toEqual({ ok: true });
    expect(hosts.list).toHaveLength(2);
    expect(commandsOf(1, "playItems")).toEqual([
      expect.objectContaining({ ids: ["l.song-1", "l.song-2"], index: 0, position: 42 }),
    ]);
    await music.dispose();
  });

  it("forgets the queue on Disconnect, so the next play does not bring it back", async () => {
    const { music, stored } = service();
    await music.command({ type: "playItems", ids: ["l.song-1", "l.song-2"], index: 1 });

    await music.disconnect();

    expect(stored.has("music.appleMusic.userToken")).toBe(false);
    expect(await music.queue()).toEqual({ position: -1, items: [] });
    const state = await music.getState();
    expect(state.authorized).toBe(false);
    expect(state.playback.nowPlaying).toBeNull();

    await music.command({ type: "play" });
    expect(hosts.list).toHaveLength(2);
    expect(commandsOf(1, "playItems")).toEqual([]);
    await music.dispose();
  });
});

describe("music service: playing a list", () => {
  it.each([
    ["the chosen song survives: it still plays first", ["111", "222", "333", "444"], 2, ["222", "333", "444"], 1],
    ["the chosen song left the catalog: the nearest place plays", ["111", "222", "333"], 1, ["111", "333"], 1],
    ["library songs are never dropped", ["i.lib1", "222", "333"], 0, ["i.lib1", "333"], 0],
  ])("drops songs Apple no longer has before queueing (%s)", async (_label, ids, index, queued, queuedIndex) => {
    catalogSongs = new Set(index === 2 ? ["222", "333", "444"] : ["111", "333"]);
    const { music } = service();

    await expect(music.command({ type: "playItems", ids, index })).resolves.toEqual({ ok: true });

    expect(commandsOf(0, "playItems")).toEqual([expect.objectContaining({ ids: queued, index: queuedIndex })]);
    await music.dispose();
  });

  it("refuses a list none of whose songs still exist", async () => {
    const { music } = service();
    const result = await music.command({ type: "playItems", ids: ["111", "222"], index: 0 });
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(commandsOf(0, "playItems")).toEqual([]);
    await music.dispose();
  });
});
