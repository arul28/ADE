import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { HOME_WIDGETS_IPC, type HomeNowPlayingSession, type HomeNowPlayingState } from "../../../shared/types/homeWidgets";

/**
 * The home widgets' main-process seam: the IPC handlers (Electron faked at
 * its boundary), the Now Playing service with its Windows helper (the child
 * process faked), and the browser tabs it reads (WebContents faked).
 */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
  userData: "",
  clipboardText: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electron.userData,
    getAppPath: () => electron.userData,
    isPackaged: false,
    getAppMetrics: () => [],
    getFileIcon: async () => ({ isEmpty: () => true }),
    once: () => undefined,
  },
  BrowserWindow: {
    fromWebContents: (wc: { window?: unknown }) => wc.window ?? null,
    getAllWindows: () => electron.windows,
  },
  clipboard: {
    readText: () => electron.clipboardText,
    writeText: (text: string) => { electron.clipboardText = text; },
    readBuffer: () => Buffer.alloc(0),
    has: () => false,
    availableFormats: () => ["text/plain"],
    readImage: () => ({ isEmpty: () => true }),
    writeImage: () => undefined,
  },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => electron.handlers.set(channel, fn) },
  net: { fetch: async () => { throw new Error("offline"); } },
  powerMonitor: { isOnBatteryPower: () => false },
  webContents: { getAllWebContents: () => [] },
}));

const helper = vi.hoisted(() => ({
  children: [] as Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; kill: () => void }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null as number | null,
        kill: () => undefined,
      });
      helper.children.push(child);
      return child;
    },
  };
});

const { registerHomeWidgetsIpc, getNowPlayingService } = await import("./registerHomeWidgetsIpc");
const { createNowPlayingService } = await import("./nowPlayingService");
const { createBrowserMediaSessions } = await import("./browserMediaSessions");

const TRUSTED_URL = "file:///C:/Program%20Files/ADE/resources/app.asar/dist/renderer/index.html";

/** A renderer: in an ADE window loading ADE's renderer, or not. */
function sender(id: number, options: { url?: string; window?: boolean } = {}) {
  const emitter = new EventEmitter();
  const window = options.window === false ? null : { isDestroyed: () => false, webContents: { send: vi.fn() } };
  if (window) electron.windows.push(window);
  const wc = Object.assign(emitter, { id, window, getURL: () => options.url ?? TRUSTED_URL });
  return { wc, window, event: { sender: wc, senderFrame: { url: options.url ?? TRUSTED_URL } } };
}

function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(event, ...args);
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-home-ipc-"));
  dirs.push(dir);
  return dir;
}

function session(overrides: Partial<HomeNowPlayingSession> = {}): HomeNowPlayingSession {
  return {
    id: "ade-music",
    kind: "ade-music",
    app: "Apple Music",
    appIcon: null,
    title: "Song",
    artist: "Artist",
    album: "",
    status: "playing",
    positionMs: 0,
    durationMs: 180_000,
    updatedAt: 1,
    canPlay: true,
    canPause: true,
    canNext: true,
    canPrevious: true,
    artwork: null,
    ...overrides,
  };
}

const previousVite = process.env.VITE_DEV_SERVER_URL;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  delete process.env.VITE_DEV_SERVER_URL;
  electron.handlers.clear();
  electron.windows.length = 0;
  electron.userData = tempDir();
  electron.clipboardText = "";
  helper.children.length = 0;
});

afterEach(() => {
  getNowPlayingService()?.dispose();
  vi.useRealTimers();
  if (previousVite === undefined) delete process.env.VITE_DEV_SERVER_URL;
  else process.env.VITE_DEV_SERVER_URL = previousVite;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("home widgets IPC", () => {
  it("answers only ADE's own renderer, on every channel", async () => {
    registerHomeWidgetsIpc({});
    const outsiders = [
      sender(1, { url: "https://evil.example.test/" }).event,
      sender(2, { window: false }).event,
      sender(3, { url: "http://127.0.0.1:4100/scene-frame.html" }).event,
    ];
    const channels = [...electron.handlers.keys()];
    expect(channels.length).toBeGreaterThan(15);
    for (const event of outsiders) {
      for (const channel of channels) {
        await expect(invoke(channel, event, {}), channel).rejects.toThrow(/only available to the ADE window/);
      }
    }
    // The same call from ADE's renderer goes through.
    await expect(invoke(HOME_WIDGETS_IPC.focusClaimCompletion, sender(4).event, 1_000)).resolves.toBe(true);
  });

  it("lets exactly one window complete each focus phase", async () => {
    registerHomeWidgetsIpc({});
    const first = sender(1).event;
    const second = sender(2).event;
    const claim = (event: unknown, endsAt: unknown) => invoke(HOME_WIDGETS_IPC.focusClaimCompletion, event, endsAt);

    expect(await claim(first, 1_700_000_000_000)).toBe(true);
    expect(await claim(second, 1_700_000_000_000)).toBe(false);
    expect(await claim(second, 1_700_000_060_000)).toBe(true);
    for (const junk of ["1700000000000", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(await claim(first, junk)).toBe(false);
    }
  });

  it("keeps Now Playing live while any of a window's widgets is subscribed, and lets go when the window does", async () => {
    registerHomeWidgetsIpc({});
    const service = getNowPlayingService()!;
    let current = session();
    const push = service.setOverride({ getState: () => ({ available: true, session: current, sessions: [], source: "ade-music" }), command: () => {} });
    const a = sender(1);
    const b = sender(2);
    const broadcasts = () => a.window!.webContents.send.mock.calls.filter(([channel]) => channel === HOME_WIDGETS_IPC.nowPlayingChanged).length;
    /** Changes the song and says whether any window was told. */
    const songChangeReaches = async (title: string) => {
      await vi.advanceTimersByTimeAsync(50);
      const before = broadcasts();
      current = session({ title });
      push({} as HomeNowPlayingState);
      await vi.advanceTimersByTimeAsync(50);
      return broadcasts() > before;
    };

    // Window A shows the widget twice (the page and a gallery preview), then closes the preview.
    await invoke(HOME_WIDGETS_IPC.nowPlayingSubscribe, a.event);
    await invoke(HOME_WIDGETS_IPC.nowPlayingSubscribe, a.event);
    await invoke(HOME_WIDGETS_IPC.nowPlayingUnsubscribe, a.event);
    expect(await songChangeReaches("Second song")).toBe(true);

    await invoke(HOME_WIDGETS_IPC.nowPlayingUnsubscribe, a.event);
    expect(await songChangeReaches("Third song")).toBe(false);

    // Window B subscribes, then closes without unsubscribing.
    await invoke(HOME_WIDGETS_IPC.nowPlayingSubscribe, b.event);
    expect(await songChangeReaches("Fourth song")).toBe(true);
    b.wc.emit("destroyed");
    expect(await songChangeReaches("Fifth song")).toBe(false);
  });

  it("drops a window's Clipboard view when it closes or navigates", async () => {
    fs.mkdirSync(path.join(electron.userData, "home-widgets"), { recursive: true });
    fs.writeFileSync(path.join(electron.userData, "home-widgets", "settings.json"), JSON.stringify({ clipboard: { enabled: true, persist: false } }));
    registerHomeWidgetsIpc({});
    const shown = sender(1);
    const hidden = sender(2);
    const texts = async () => ((await invoke(HOME_WIDGETS_IPC.clipboardGetState, shown.event)) as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text);
    const copy = async (text: string) => {
      electron.clipboardText = text;
      await vi.advanceTimersByTimeAsync(1_000);
    };

    await invoke(HOME_WIDGETS_IPC.clipboardPresence, shown.event, "shown");
    await invoke(HOME_WIDGETS_IPC.clipboardPresence, hidden.event, "hidden");
    await copy("while shown");
    // The window that showed it closes; the other still hides it.
    shown.wc.emit("destroyed");
    await vi.advanceTimersByTimeAsync(0);
    await copy("nobody watching");
    expect(await texts()).toEqual(["while shown"]);

    // The hiding window leaves home: no view is left, so the saved switch rules again.
    hidden.wc.emit("did-navigate");
    await vi.advanceTimersByTimeAsync(0);
    await copy("watched again");
    expect(await texts()).toEqual(["watched again", "while shown"]);
  });
});

describe("Now Playing's Windows helper", () => {
  function windowsService(broadcast: (state: HomeNowPlayingState) => void) {
    const resources = tempDir();
    fs.mkdirSync(path.join(resources, "native"), { recursive: true });
    fs.writeFileSync(path.join(resources, "native", "ade-now-playing.exe"), "");
    return createNowPlayingService({ platform: "win32", isPackaged: true, resourcesPath: resources, appPath: resources, broadcast });
  }

  const line = (title: string) => `${JSON.stringify({ type: "sessions", sessions: [{ id: "Spotify.exe", app: "Spotify.exe", title, artist: "Band", status: "playing" }] })}\n`;

  it.each([
    ["exits", (child: EventEmitter) => child.emit("exit", 1)],
    ["fails to start", (child: EventEmitter) => child.emit("error", new Error("spawn EACCES"))],
  ])("clears what the helper reported when it %s, and the next subscribe starts a fresh one", async (_label, die) => {
    const states: HomeNowPlayingState[] = [];
    const service = windowsService((state) => states.push(state));

    service.subscribe(1);
    expect(helper.children).toHaveLength(1);
    helper.children[0]!.stdout.write(line("From the helper"));
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)?.session?.title).toBe("From the helper");

    die(helper.children[0]!);
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)?.session).toBeNull();
    expect(states.at(-1)?.available).toBe(false);

    // The next widget to come on screen (here another window's) starts it again,
    // though the first one never left.
    service.subscribe(2);
    expect(helper.children).toHaveLength(2);
    helper.children[1]!.stdout.write(line("After the restart"));
    await vi.advanceTimersByTimeAsync(50);
    expect(states.at(-1)?.session?.title).toBe("After the restart");
    service.dispose();
  });
});

describe("Now Playing from browser tabs", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  /** A browser tab whose page answers the read script with `read`, and whose session serves `images`. */
  function tab(read: unknown, images: Record<string, { type: string | null; body: Buffer }>) {
    const emitter = new EventEmitter();
    const frame = { executeJavaScript: vi.fn(async () => read), framesInSubtree: [] as unknown[] };
    frame.framesInSubtree = [frame];
    const fetch = vi.fn(async (url: string) => {
      const image = images[url];
      if (!image) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(image.body), { status: 200, headers: image.type ? { "content-type": image.type } : {} });
    });
    return Object.assign(emitter, {
      id: 77,
      mainFrame: frame,
      session: { fetch },
      isDestroyed: () => false,
      getURL: () => "https://music.example.test/watch?v=1",
      getTitle: () => "Tab title",
    }) as unknown as WebContents & EventEmitter;
  }

  async function readTab(wc: WebContents & EventEmitter) {
    const media = createBrowserMediaSessions({ browserTabIdFor: () => "tab-1", allowBackgroundAudio: () => {}, onChange: () => {} });
    media.watch(wc);
    wc.emit("media-started-playing");
    await vi.advanceTimersByTimeAsync(200);
    // The artwork and icon fetches are real promises; let them settle.
    for (let turn = 0; turn < 20; turn += 1) await vi.advanceTimersByTimeAsync(0);
    return media;
  }

  it("rebuilds a hostile page's answer from plain values before using any of it", async () => {
    const hostile = {
      title: { toString: () => "injected" },
      artist: "A".repeat(5_000),
      album: 42,
      artwork: Array.from({ length: 500 }, () => ({ src: "javascript:alert(1)", sizes: 9 })),
      playbackState: "playing",
      actions: ["play", { evil: true }, "nexttrack", 7],
      icons: "not a list",
      docTitle: ["x"],
      media: { paused: "no", muted: 0, currentTime: Number.NaN, duration: "180" },
    };
    const media = await readTab(tab(hostile, {}));

    const [read] = media.sessions();
    expect(read).toMatchObject({
      id: "tab:77",
      title: "Tab title",
      artist: "A".repeat(1024),
      album: "",
      // Only `paused === false` means playing.
      status: "paused",
      positionMs: 0,
      durationMs: 0,
      canNext: true,
      artwork: null,
      browserTabId: "tab-1",
    });
    media.dispose();
  });

  it.each([
    ["a declared image type", "image/jpeg", PNG, "data:image/jpeg;base64,"],
    ["no type, decided by the bytes", null, PNG, "data:image/png;base64,"],
    ["a generic octet-stream, decided by the bytes", "application/octet-stream", PNG, "data:image/png;base64,"],
    ["an HTML error page", "text/html", PNG, null],
    ["untyped bytes that are no image", null, Buffer.from("<html>nope</html>"), null],
  ])("reads artwork served with %s", async (_label, type, body, prefix) => {
    const read = {
      title: "Song",
      artist: "Band",
      album: "",
      artwork: [{ src: "https://cdn.example.test/cover", sizes: "512x512" }],
      playbackState: "playing",
      actions: [],
      icons: [],
      docTitle: "",
      media: { paused: false, muted: false, currentTime: 12, duration: 200 },
    };
    const media = await readTab(tab(read, { "https://cdn.example.test/cover": { type, body } }));

    const artwork = media.sessions()[0]?.artwork ?? null;
    if (prefix) expect(artwork?.startsWith(prefix)).toBe(true);
    else expect(artwork).toBeNull();
    media.dispose();
  });
});
