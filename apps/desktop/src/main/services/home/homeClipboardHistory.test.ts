import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClipboardHistory, type HomeWidgetsClipboard } from "./homeClipboardHistory";

/**
 * The Clipboard widget's history, driven the way the app drives it: a fake
 * system clipboard (the Electron boundary), the real files under a temp
 * user-data dir, and the once-a-second poll on fake timers.
 */

type FakeClipboard = HomeWidgetsClipboard & {
  text: string;
  markers: Set<string>;
  dword: number | null;
};

function fakeClipboard(): FakeClipboard {
  const clip: FakeClipboard = {
    text: "",
    markers: new Set<string>(),
    dword: null,
    readText: () => clip.text,
    writeText: (text) => { clip.text = text; },
    readBuffer: (format) => {
      if (format === "CanIncludeInClipboardHistory" && clip.dword != null) {
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32LE(clip.dword, 0);
        return buffer;
      }
      return Buffer.alloc(0);
    },
    has: (format) => clip.markers.has(format),
    availableFormats: () => ["text/plain"],
  };
  return clip;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-clipboard-history-"));
  dirs.push(dir);
  return dir;
}

function history(dir: string, platform: NodeJS.Platform = "win32") {
  const clip = fakeClipboard();
  const service = createClipboardHistory({ dir, clipboard: clip, platform, broadcast: () => {} });
  return { clip, service };
}

/** Puts `text` on the clipboard and lets one poll see it. */
async function copy(clip: FakeClipboard, text: string): Promise<void> {
  clip.text = text;
  await vi.advanceTimersByTimeAsync(1_000);
}

/** The debounced write runs on real file I/O: yield to it until a whole history has landed. */
async function writtenHistory(file: string): Promise<unknown> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw new Error(`${file} was never written`);
}

function writeSettings(dir: string, settings: { enabled: boolean; persist: boolean }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ clipboard: settings }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("clipboard history: what is kept", () => {
  const TOKEN_TAIL = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  it.each([
    // [what, platform, copied text, password-manager marker, CanIncludeInClipboardHistory, kept]
    ["a link with mixed case and digits", "win32", "https://Docs.Example.com/Guide-2?Tab=Setup&v=3", null, null, true],
    ["a bare host and path", "win32", "api.Example.io:8443/v2/Users?id=9", null, null, true],
    ["a Windows path", "win32", "C:\\Users\\Ada\\Project-2\\src\\App.tsx", null, null, true],
    ["a UNC path", "win32", "\\\\fileserver\\Share-2\\Q3 Report.xlsx", null, null, true],
    ["a relative path", "win32", "./src/components/Home-2/Widget.tsx", null, null, true],
    ["a package spec", "win32", "@scope/Pkg-Name@^1.2.3", null, null, true],
    ["code that reads a token", "win32", "const token = getToken();", null, null, true],
    ["a typed field", "win32", "password: string", null, null, true],
    ["a commit hash", "win32", "9fceb02d0ae598e95dc970b74767f19372d61af8", null, null, true],
    ["a GitHub token", "win32", `ghp_${TOKEN_TAIL}`, null, null, false],
    ["an API key in a sentence", "win32", `use sk-proj-${TOKEN_TAIL} for this`, null, null, false],
    ["a private key", "win32", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----", null, null, false],
    ["a secret assignment", "win32", 'DB_PASSWORD="hunter2-correct-horse"', null, null, false],
    ["a generated password", "win32", "Tr0ub4dor&3xK!9qZ", null, null, false],
    ["text a password manager marked (Windows opt-out)", "win32", "plain words", "ExcludeClipboardContentFromMonitorProcessing", null, false],
    ["text KeePass marked", "win32", "plain words", "Clipboard Viewer Ignore", null, false],
    ["text with CanIncludeInClipboardHistory = 0", "win32", "plain words", null, 0, false],
    ["text with CanIncludeInClipboardHistory = 1", "win32", "plain words", null, 1, true],
    ["text a macOS password manager marked", "darwin", "plain words", "org.nspasteboard.ConcealedType", null, false],
    ["a Windows marker on macOS (not a macOS marker)", "darwin", "plain words", "Clipboard Viewer Ignore", null, true],
  ] as const)("%s", async (_label, platform, text, marker, dword, kept) => {
    const dir = tempDir();
    writeSettings(dir, { enabled: true, persist: false });
    const { clip, service } = history(dir, platform);
    if (marker) clip.markers.add(marker);
    clip.dword = dword;
    await service.load();

    await copy(clip, text);

    const state = await service.getState();
    expect(state.entries.map((entry) => entry.text)).toEqual(kept ? [text] : []);
    expect(state.skippedSecrets).toBe(kept ? 0 : 1);
    service.dispose();
  });
});

describe("clipboard history: what reaches the disk", () => {
  const historyFile = (dir: string) => path.join(dir, "clipboard-history.json");

  it("writes a kept history, and deletes it the moment Keep after restart goes off", async () => {
    const dir = tempDir();
    writeSettings(dir, { enabled: true, persist: true });
    const { clip, service } = history(dir);
    await service.load();
    await copy(clip, "first note");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await writtenHistory(historyFile(dir))).toEqual([expect.objectContaining({ text: "first note" })]);

    await service.configure({ persist: false });
    // No timer had to run: the file is already gone.
    expect(fs.existsSync(historyFile(dir))).toBe(false);
    service.dispose();
  });

  it("lands a write still waiting on its debounce when the app quits", async () => {
    const dir = tempDir();
    writeSettings(dir, { enabled: true, persist: true });
    const { clip, service } = history(dir);
    await service.load();
    await copy(clip, "copied just before quit");

    service.dispose();
    expect(JSON.parse(fs.readFileSync(historyFile(dir), "utf8"))).toEqual([
      expect.objectContaining({ text: "copied just before quit" }),
    ]);
  });

  it("removes a history a crash left behind when it is not kept", async () => {
    const dir = tempDir();
    writeSettings(dir, { enabled: false, persist: false });
    fs.writeFileSync(historyFile(dir), JSON.stringify([{ id: "a", text: "left over", copiedAt: 1 }]));
    fs.mkdirSync(path.join(dir, "clipboard-images"));
    const { service } = history(dir);

    await service.load();
    expect(fs.existsSync(historyFile(dir))).toBe(false);
    expect(fs.existsSync(path.join(dir, "clipboard-images"))).toBe(false);
    expect((await service.getState()).entries).toEqual([]);
  });

  it.each([
    ["not JSON", "{oops", []],
    ["not a list", JSON.stringify({ text: "x" }), []],
    ["a list with broken rows", JSON.stringify([{ id: 1 }, { id: "ok", text: "kept", copiedAt: 5 }, null]), ["kept"]],
  ])("starts from what survives of a history that is %s", async (_label, content, texts) => {
    const dir = tempDir();
    writeSettings(dir, { enabled: false, persist: true });
    fs.writeFileSync(historyFile(dir), content);
    const { service } = history(dir);

    const state = await service.getState();
    expect(state.entries.map((entry) => entry.text)).toEqual(texts);
    expect(state.persist).toBe(true);
  });
});

describe("clipboard history: which windows keep the watch on", () => {
  it("watches while any window shows the widget, and stops only when every view hides it", async () => {
    const dir = tempDir();
    writeSettings(dir, { enabled: true, persist: false });
    const { clip, service } = history(dir);
    await service.load();
    const texts = async () => (await service.getState()).entries.map((entry) => entry.text);

    await service.setPresence(1, "shown");
    await service.setPresence(2, "hidden");
    await copy(clip, "seen by window 1");
    expect(await texts()).toEqual(["seen by window 1"]);

    // Window 1 closes; window 2 still hides the widget for lack of room.
    await service.setPresence(1, null);
    await copy(clip, "nobody is watching");
    expect(await texts()).toEqual(["seen by window 1"]);

    // Window 2 navigates away from home: no window has an opinion, so the switch rules.
    await service.setPresence(2, null);
    await copy(clip, "watched again");
    expect(await texts()).toEqual(["watched again", "seen by window 1"]);
    service.dispose();
  });
});
