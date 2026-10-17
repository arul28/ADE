import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMusicSettings } from "./musicProviderRouter";
import { createVolumeMemory } from "./musicVolume";

/**
 * Where the two players' volume sliders are kept between launches: the
 * settings file (provider, Spotify Client ID and one volume per provider) and
 * the session copy each service hands its player at startup.
 *
 * The writes are coalesced, so these run in fake time and read the real file.
 */

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-music-settings-"));
  dirs.push(dir);
  return dir;
};

const readSettings = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "music-settings.json"), "utf8")) as {
  provider: string;
  spotifyClientId: string | null;
  volume: { apple: number | null; spotify: number | null };
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the music settings store", () => {
  it("writes a drag's value once it settles, and flush writes it at once", () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const settings = createMusicSettings(dir);
    const apple = settings.volumeFor("apple");

    // A drag: each percent reaches the store, the file waits for the burst.
    apple.set(0.38);
    apple.set(0.4);
    apple.set(0.42);
    expect(fs.existsSync(path.join(dir, "music-settings.json"))).toBe(false);
    expect(settings.get().volume.apple).toBe(0.42);

    vi.advanceTimersByTime(250);
    expect(readSettings(dir).volume).toEqual({ apple: 0.42, spotify: null });

    // A move made after that, flushed on the way out.
    apple.set(0.5);
    settings.flush();
    expect(readSettings(dir).volume.apple).toBe(0.5);
  });

  it("keeps a position the write could not take, and flush lands it once the store is writable", () => {
    vi.useFakeTimers();
    const root = tempDir();
    // A file where the settings folder goes: every write fails, on every OS.
    const dir = path.join(root, "music-player");
    fs.writeFileSync(dir, "");
    const settings = createMusicSettings(dir);
    const apple = settings.volumeFor("apple");

    apple.set(0.3);
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(2_000);
    // Nothing landed, and the session still has the value the user picked.
    expect(fs.statSync(dir).isFile()).toBe(true);
    expect(settings.get().volume.apple).toBe(0.3);

    // The folder is back: the pending position is written by the next flush.
    fs.rmSync(dir);
    settings.flush();
    expect(readSettings(dir).volume.apple).toBe(0.3);
  });

  it("keeps the provider and the Spotify Client ID while a volume changes", () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const settings = createMusicSettings(dir);
    settings.set({ provider: "spotify", spotifyClientId: "0123456789abcdef0123456789abcdef" });

    settings.volumeFor("apple").set(0.6);
    vi.advanceTimersByTime(250);

    expect(readSettings(dir)).toEqual({
      provider: "spotify",
      spotifyClientId: "0123456789abcdef0123456789abcdef",
      volume: { apple: 0.6, spotify: null },
    });
  });
});

describe("a provider's remembered volume", () => {
  it("clamps to the slider's steps and ignores a value it already has", () => {
    const writes: number[] = [];
    const memory = createVolumeMemory({ get: () => 0.35, set: (value) => writes.push(value) });

    expect(memory.saved).toBe(0.35);
    for (const [asked, expected] of [[0.333, 0.33], [1.4, 1], [-0.2, 0], [Number.NaN, null]] as const) {
      const before = writes.length;
      memory.remember(asked);
      expect(writes.length).toBe(expected == null ? before : before + 1);
      if (expected != null) expect(writes.at(-1)).toBe(expected);
    }

    // The same position again costs nothing.
    memory.remember(0);
    const settled = writes.length;
    memory.remember(0);
    expect(writes).toHaveLength(settled);
    expect(memory.saved).toBe(0);
  });

  it("carries no value when nothing was ever set", () => {
    const memory = createVolumeMemory();
    expect(memory.saved).toBeNull();
    memory.remember(0.4);
    expect(memory.saved).toBe(0.4);
  });
});
