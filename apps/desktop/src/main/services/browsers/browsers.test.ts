import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  _testing as detection,
  type BrowserDetectionDeps,
} from "./browserDetection";
import { _testing as icons, browserIconDataUrl } from "./browserIcons";

/**
 * What is installed, and what its icon looks like.
 *
 * Detection reads the real machine, so every case here drives the injected
 * deps and asserts the two things a caller depends on: which browsers come
 * back, and the command the launcher will later be handed for each.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakePng(fill: number): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(48, fill)]);
}

/** Build an `.icns` container out of `{ type, payload }` elements. */
function icns(entries: ReadonlyArray<{ type: string; payload: Buffer }>): Buffer {
  const elements = entries.map((entry) => {
    const header = Buffer.alloc(8);
    header.write(entry.type, 0, "ascii");
    header.writeUInt32BE(entry.payload.length + 8, 4);
    return Buffer.concat([header, entry.payload]);
  });
  const body = Buffer.concat(elements);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function deps(overrides: Partial<BrowserDetectionDeps>): Partial<BrowserDetectionDeps> {
  return { fileExists: () => false, commandSucceeds: async () => false, env: {}, ...overrides };
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * An element that declares length 0, inside a container long enough that the
 * walk would keep reading it forever. This is the case the `length < 8` guard
 * exists for: without it the parser never advances and the icon read hangs.
 */
function zeroLengthElement(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("icns", 0, "ascii");
  buffer.writeUInt32BE(64, 4);
  buffer.write("ic11", 8, "ascii");
  buffer.writeUInt32BE(0, 12);
  return buffer;
}

/** A minimal `.app` whose resources hold one `.icns`. */
function writeMacApp(appName: string, icnsFile: string, bytes: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browsers-"));
  tempRoots.push(root);
  const appPath = path.join(root, `${appName}.app`);
  const resources = path.join(appPath, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, icnsFile), bytes);
  return appPath;
}

describe("detectBrowsers", () => {
  it("reports a browser whose app bundle is present, and the command to launch it", async () => {
    const found = await detection.detectBrowsers(
      deps({
        platform: "darwin",
        env: { HOME: "/Users/ada" },
        fileExists: (candidate) => candidate === "/Applications/Google Chrome.app",
      }),
    );

    expect(found.map((browser) => browser.id)).toEqual(["chrome"]);
    expect(found[0]?.label).toBe("Google Chrome");
    // The launcher resolves the id back to what detection found, so a browser
    // that was listed is a browser that can actually be opened.
    expect(detection.resolveDetectedBrowserCommand("chrome")).toBe("/Applications/Google Chrome.app");
    expect(detection.resolveDetectedBrowserCommand("firefox")).toBeNull();
  });

  it("finds a browser Launch Services knows but no standard directory holds", async () => {
    const probed: string[] = [];
    const found = await detection.detectBrowsers(
      deps({
        platform: "darwin",
        env: { HOME: "/Users/ada" },
        commandSucceeds: async (command, args) => {
          if (command === "open" && args[0] === "-Ra") probed.push(args[1] ?? "");
          return command === "open" && args[1] === "Arc";
        },
      }),
    );

    expect(found.map((browser) => browser.id)).toEqual(["arc"]);
    expect(probed).toContain("Arc");
    // No path was found, so the bundle name is what `open -a` gets.
    expect(found[0]?.appPath).toBeNull();
    expect(detection.resolveDetectedBrowserCommand("arc")).toBe("Arc");
  });

  it("finds a Windows browser from its install path and records that exact executable", async () => {
    const executable = "C:\\Users\\ada\\AppData\\Local\\Mozilla Firefox\\firefox.exe";
    const found = await detection.detectBrowsers(
      deps({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" },
        fileExists: (candidate) => candidate === executable,
      }),
    );

    expect(found.map((browser) => browser.id)).toEqual(["firefox"]);
    expect(found[0]?.appPath).toBe(executable);
    expect(detection.resolveDetectedBrowserCommand("firefox")).toBe(executable);
  });

  it("does not treat a missing environment directory as an install location", async () => {
    // With no LOCALAPPDATA, `{{LocalAppData}}` used to expand to "", leaving a
    // drive-rooted relative path that `fs.existsSync` resolves against the
    // current drive root — a file there would be listed and then launched.
    const relative = "\\Mozilla Firefox\\firefox.exe";
    const found = await detection.detectBrowsers(
      deps({
        platform: "win32",
        env: {},
        fileExists: (candidate) => candidate === relative,
      }),
    );

    expect(found).toEqual([]);
    expect(detection.expandWindowsBrowserExecutable("{{LocalAppData}}/Mozilla Firefox/firefox.exe", {}))
      .toBeNull();
  });

  it("finds a Linux browser through PATH and remembers the name that worked", async () => {
    const found = await detection.detectBrowsers(
      deps({
        platform: "linux",
        commandSucceeds: async (command, args) =>
          command === "which" && args[0] === "google-chrome-stable",
      }),
    );

    expect(found.map((browser) => browser.id)).toEqual(["chrome"]);
    expect(detection.resolveDetectedBrowserCommand("chrome")).toBe("google-chrome-stable");
  });

  it("detects nothing on a platform it has no browser locations for", async () => {
    const found = await detection.detectBrowsers(
      deps({
        platform: null,
        // Everything a naive probe could find, so only the platform gate can
        // be what keeps this empty.
        fileExists: () => true,
        commandSucceeds: async () => true,
      }),
    );

    expect(found).toEqual([]);
  });
});

describe("extractIconPngFromIcns", () => {
  it("returns the smallest PNG element that is still large enough to draw", () => {
    const large = fakePng(1);
    const small = fakePng(2);
    const tiny = fakePng(3);

    expect(icons.extractIconPngFromIcns(icns([
      { type: "ic13", payload: large },
      { type: "ic11", payload: small },
      { type: "icp4", payload: tiny },
    ]))).toEqual(small);
  });

  it.each([
    ["a file that is not a container", Buffer.from("plain text, not an icns")],
    ["a header shorter than the format", Buffer.from("icns")],
    ["nothing but a header", icns([])],
    ["an element whose length would not advance the walk", zeroLengthElement()],
    ["an element longer than the file", Buffer.concat([
      Buffer.from("icns"),
      Buffer.from([0, 0, 0, 40]),
      Buffer.from("ic11"),
      Buffer.from([0, 0, 255, 255]),
      fakePng(4),
    ])],
  ])("returns null for %s instead of throwing", (_label, buffer) => {
    expect(icons.extractIconPngFromIcns(buffer)).toBeNull();
  });

  it("prefers the bundle's own icon file over an unrelated one beside it", () => {
    const appPath = writeMacApp("Google Chrome", "app.icns", icns([{ type: "ic11", payload: fakePng(9) }]));
    const resources = path.join(appPath, "Contents", "Resources");
    // A document-type icon that must not win: it sorts first alphabetically.
    fs.writeFileSync(path.join(resources, "aaa-document.icns"), icns([{ type: "ic11", payload: fakePng(8) }]));

    expect(icons.resolveMacAppIconFile(appPath)).toBe(path.join(resources, "app.icns"));
  });
});

describe("browserIconDataUrl", () => {
  it("reads the app's own icon out of the bundle", async () => {
    const png = fakePng(11);
    const appPath = writeMacApp("Safari", "AppIconUpdated.icns", icns([{ type: "ic11", payload: png }]));

    const url = await browserIconDataUrl(appPath, { platform: "darwin" });

    expect(url?.startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(url!.split(",")[1]!, "base64")).toEqual(png);
  });

  it("does not serve one platform's answer for a path to another", async () => {
    const appPath = writeMacApp("Vivaldi", "app.icns", icns([{ type: "ic11", payload: fakePng(12) }]));

    // Linux has no per-app icon this process can read, so it caches "none".
    expect(await browserIconDataUrl(appPath, { platform: "linux" })).toBeNull();
    // The same path asked about macOS still has to be read, not served the
    // cached miss.
    expect(await browserIconDataUrl(appPath, { platform: "darwin" }))
      .toMatch(/^data:image\/png;base64,/);
  });
});
