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
  /** When set, a restore (`playItems` with `play: false`) answers only after it resolves. */
  restoreGate: null as Promise<void> | null,
  /** What the host answers to `authorize`. */
  authorizeReply: { userToken: null as string | null, authorized: false },
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
          case "playItems": {
            host.queue = command.ids as string[];
            if (command.play === false) {
              const restored = { state: "none", isPlaying: false, time: command.position, queueLength: host.queue.length, queuePosition: command.index };
              void (hosts.restoreGate ?? Promise.resolve()).then(() => reply(command.rid, restored));
              return;
            }
            return reply(command.rid, { state: "playing", isPlaying: true, queueLength: host.queue.length, queuePosition: command.index });
          }
          case "pause":
            return reply(command.rid, { state: "paused", isPlaying: false });
          case "seek":
            return reply(command.rid, { time: command.position });
          case "authorize":
            return reply(command.rid, hosts.authorizeReply);
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
type MusicState = Awaited<ReturnType<ReturnType<typeof createMusicService>["getState"]>>;

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-music-service-"));
  dirs.push(dir);
  return dir;
}

/** Apple's catalog: which of the asked song ids still exist. */
let catalogSongs = new Set<string>();
/** What Apple answers for a collection's tracks, by `offset`. */
let trackPages = new Map<number, { count: number; next: boolean; total?: number }>();
const fetchImpl = vi.fn(async (url: string | URL) => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith("/tracks")) {
    const offset = Number(parsed.searchParams.get("offset"));
    const page = trackPages.get(offset);
    if (!page || parsed.searchParams.get("limit") !== "100") return new Response("{}", { status: 400 });
    const data = Array.from({ length: page.count }, (_, at) => ({ id: `i.${offset + at}`, type: "library-songs", attributes: { name: `Song ${offset + at}` } }));
    return new Response(
      JSON.stringify({ data, ...(page.next ? { next: "/next" } : {}), ...(page.total === undefined ? {} : { meta: { total: page.total } }) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (parsed.pathname.endsWith("/songs")) {
    const ids = (parsed.searchParams.get("ids") ?? "").split(",").filter((id) => catalogSongs.has(id));
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id, type: "songs" })) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

function service(broadcast: (state: MusicState) => void = () => {}) {
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
    broadcast,
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
  hosts.restoreGate = null;
  hosts.authorizeReply = { userToken: null, authorized: false };
  catalogSongs = new Set();
  trackPages = new Map();
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

  it("holds a command until the tab's warm-up has put the unloaded queue back", async () => {
    const { music } = service();
    await music.command({ type: "playItems", ids: ["l.song-1", "l.song-2"], index: 0 });
    await music.command({ type: "pause" });
    await music.unloadPlayer();

    // The Music tab opens (warm) and play is pressed while the restore is still loading.
    let releaseRestore: () => void = () => {};
    hosts.restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const warming = music.warm();
    const playing = music.command({ type: "play" });
    await settle();
    expect(commandsOf(1, "playItems")).toEqual([expect.objectContaining({ play: false, position: 42 })]);
    expect(commandsOf(1, "resume")).toEqual([]);

    releaseRestore();
    await warming;
    expect(await playing).toEqual({ ok: true });
    // Once, after the restore, and the queue was put back only once.
    expect(hosts.list[1]!.commands.map((command) => command.cmd).filter((cmd) => cmd === "playItems" || cmd === "resume")).toEqual(["playItems", "resume"]);
    await music.dispose();
  });

  it.each([
    ["a sign-in that returns no token closes Apple's window", null, false, 1],
    ["a finished sign-in leaves nothing to close", "user-token-2", true, 0],
  ])("%s", async (_label, userToken, ok, closes) => {
    hosts.authorizeReply = { userToken, authorized: Boolean(userToken) };
    const { music, stored } = service();

    const result = await music.connect();
    await settle();

    expect(result.ok).toBe(ok);
    expect(commandsOf(0, "authorize")).toHaveLength(1);
    expect(commandsOf(0, "closeAuth")).toHaveLength(closes);
    expect(stored.get("music.appleMusic.userToken")).toBe(userToken ?? "user-token");
    await music.dispose();
  });
});

describe("music service: the playback position", () => {
  it("pushes a position only when the windows' own estimate would be wrong", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pushed: MusicState[] = [];
    const { music } = service((state) => pushed.push(state));
    await music.command({ type: "playItems", ids: ["l.song-1"], index: 0 });
    const tick = async (time: number) => {
      hosts.list[0]!.stdout.write(`${JSON.stringify({ event: "time", time, duration: 200, isPlaying: true })}\n`);
      await settle();
      vi.advanceTimersByTime(50);
    };

    // The first tick brings the duration, so it anchors the position.
    await tick(10);
    expect(pushed.at(-1)?.playback).toMatchObject({ position: 10, duration: 200, isPlaying: true });
    const anchored = pushed.length;

    // A tick the windows already predict is not news.
    await tick(10.4);
    expect(pushed).toHaveLength(anchored);

    // A jump (a stall, a seek made elsewhere) is.
    await tick(60);
    expect(pushed).toHaveLength(anchored + 1);
    expect(pushed.at(-1)?.playback.position).toBe(60);

    // A seek's own reply moves the position even by a fraction of a second.
    await music.command({ type: "pause" });
    await music.command({ type: "seek", position: 60.5 });
    expect((await music.getState()).playback).toMatchObject({ position: 60.5, isPlaying: false });
    await music.dispose();
  });
});

describe("music service: a collection's songs, one page at a time", () => {
  it.each([
    ["a middle page says where the next one starts and how many songs there are", 100, 500, { count: 100, next: true, total: 1804 }, 200, 1804],
    ["a short last page ends the list", 1800, 100, { count: 4, next: false, total: 1804 }, null, 1804],
    ["the last page ADE reads ends the list even when Apple has more", 1900, 100, { count: 100, next: true }, null, null],
  ])("%s", async (_label, offset, limit, page, nextOffset, total) => {
    trackPages.set(offset, page);
    const { music } = service();

    const result = await music.tracks({ kind: "playlist", id: "p.1", library: true, offset, limit });

    expect(result.items).toHaveLength(page.count);
    expect(result.items[0]).toMatchObject({ id: `i.${offset}`, title: `Song ${offset}` });
    expect(result.nextOffset).toBe(nextOffset);
    expect(result.total).toBe(total);
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
