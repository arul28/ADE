import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The background removal spawns a process; the test checks what was moved, not how the trash is emptied.
vi.mock("../shared/removeTreeOffProcess", () => ({ removeTreeOffProcess: vi.fn(async () => undefined) }));

import { createXcodeDerivedData } from "./xcodeDerivedData";

/**
 * Deleting Xcode build data removes folders from disk, so the contract that
 * matters is what it will and will not touch: only folders Xcode made, only
 * directly inside DerivedData, never through a link, never unconfirmed, never
 * while a build runs. Real folders in a temp home; `defaults` and `pgrep` are
 * the process boundary.
 */

const plist = (workspace: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>LastAccessedDate</key><date>2026-11-01T10:00:00Z</date>
<key>WorkspacePath</key><string>${workspace}</string>
</dict></plist>`;

let home: string;
let root: string;
let outside: string;

function folder(dir: string, files: Record<string, string> = { "data.bin": "x".repeat(4096) }): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

function service(opts: { building?: boolean; probeFails?: boolean } = {}) {
  const run = vi.fn(async (command: string) => {
    if (command === "pgrep" && opts.building) return { stdout: "4242\n", stderr: "" };
    // A probe that times out or cannot start says nothing about a build.
    if (command === "pgrep" && opts.probeFails) throw Object.assign(new Error("pgrep: timed out"), { code: "ETIMEDOUT" });
    // `pgrep` exits 1 when nothing matches; `defaults` has no custom location.
    throw Object.assign(new Error(`${command}: no result`), { code: 1 });
  });
  return createXcodeDerivedData({
    run,
    logger: { info: vi.fn(), warn: vi.fn() },
    homedir: () => home,
    platform: "darwin",
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-derived-data-"));
  root = path.join(home, "Library", "Developer", "Xcode", "DerivedData");
  outside = folder(path.join(home, "Documents", "precious"));
  folder(path.join(root, "App-abcdefghijklmnopqrstuvwxyz"), { "info.plist": plist("/Users/ada/App/App.xcodeproj"), "Build.bin": "y".repeat(8192) });
  folder(path.join(root, "ModuleCache.noindex"));
  // The person's own folders that happen to sit there.
  folder(path.join(root, "Notes"));
  folder(path.join(root, "Archive.noindex"));
  // A link inside DerivedData pointing at the person's folder ("junction" so Windows needs no admin).
  fs.symlinkSync(outside, path.join(root, "Shortcut-abcdefghijklmnopqrstuvwxyz"), "junction");
  // A link inside DerivedData pointing at one of Xcode's own folders there.
  fs.symlinkSync(path.join(root, "App-abcdefghijklmnopqrstuvwxyz"), path.join(root, "Alias-abcdefghijklmnopqrstuvwxyz"), "junction");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("xcodeDerivedData", () => {
  it("lists only the folders Xcode made", async () => {
    const result = await service().list({});
    expect(result.entries.map((entry) => entry.folderName).sort()).toEqual(["App-abcdefghijklmnopqrstuvwxyz", "ModuleCache.noindex"]);
  });

  it("moves only Xcode's folders out and reports what it freed", async () => {
    const app = path.join(root, "App-abcdefghijklmnopqrstuvwxyz");
    const cache = path.join(root, "ModuleCache.noindex");
    const result = await service().remove({ paths: [app, cache], confirmedByUser: true });
    expect(result.errors).toEqual([]);
    expect(result.deleted.map((entry) => entry.path).sort()).toEqual([app, cache].sort());
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.existsSync(cache)).toBe(false);
    expect(fs.existsSync(path.join(root, "Notes"))).toBe(true);
  });

  it.each([
    ["a folder outside DerivedData", () => outside],
    ["DerivedData itself", () => root],
    ["a link to a folder outside", () => path.join(root, "Shortcut-abcdefghijklmnopqrstuvwxyz")],
    ["a link to an Xcode folder", () => path.join(root, "Alias-abcdefghijklmnopqrstuvwxyz")],
    ["a folder Xcode did not make", () => path.join(root, "Notes")],
    ["a person's own .noindex folder", () => path.join(root, "Archive.noindex")],
    ["a relative path", () => "Notes"],
  ])("refuses %s and leaves it on disk", async (_label, target) => {
    const asked = target();
    const result = await service().remove({ paths: [asked], confirmedByUser: true });
    expect(result.deleted).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(path.isAbsolute(asked) ? asked : path.join(root, asked))).toBe(true);
    expect(fs.existsSync(path.join(outside, "data.bin"))).toBe(true);
    expect(fs.existsSync(path.join(root, "App-abcdefghijklmnopqrstuvwxyz", "info.plist"))).toBe(true);
  });

  it.each([
    ["without the person's confirmation", { building: false }, false],
    ["while Xcode or xcodebuild runs", { building: true }, true],
    ["when ADE can't tell whether a build runs", { probeFails: true }, true],
  ])("deletes nothing %s", async (_label, opts, confirmed) => {
    const app = path.join(root, "App-abcdefghijklmnopqrstuvwxyz");
    await expect(service(opts).remove({ paths: [app], confirmedByUser: confirmed as true })).rejects.toThrow();
    expect(fs.existsSync(app)).toBe(true);
  });
});
