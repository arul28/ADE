import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractIconPngFromIcns, resolveMacAppIconFile } from "./macAppIconFile";

/**
 * A macOS app bundle's own icon: which PNG element of its `.icns` container is
 * read out, and which file in `Contents/Resources` is the application icon.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mac-icon-"));
  tempRoots.push(root);
  const appPath = path.join(root, `${appName}.app`);
  const resources = path.join(appPath, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, icnsFile), bytes);
  return appPath;
}

describe("extractIconPngFromIcns", () => {
  it("returns the smallest PNG element that is still large enough to draw", () => {
    const large = fakePng(1);
    const small = fakePng(2);
    const tiny = fakePng(3);

    expect(extractIconPngFromIcns(icns([
      { type: "ic13", payload: large },
      { type: "ic11", payload: small },
      { type: "icp4", payload: tiny },
    ]))).toEqual(small);
  });

  it.each([
    // 32 and 128 px only, asked for 256: none is that large, so the largest of at least 32 px.
    ["asks for 256 px when only 32 and 128 px exist", [
      { type: "ic11", payload: fakePng(5) },
      { type: "ic13", payload: fakePng(6) },
    ], 256, fakePng(6)],
    // 256 and 512 px, asked for 256: the smallest that is at least 256, not the 512.
    ["asks for 256 px when 256 and 512 px exist", [
      { type: "ic09", payload: fakePng(7) },
      { type: "ic08", payload: fakePng(8) },
    ], 256, fakePng(8)],
  ])("%s", (_label, entries, minPx, expected) => {
    expect(extractIconPngFromIcns(icns(entries), minPx)).toEqual(expected);
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
    expect(extractIconPngFromIcns(buffer)).toBeNull();
  });
});

describe("resolveMacAppIconFile", () => {
  it("prefers the bundle's own icon file over an unrelated one beside it", () => {
    const appPath = writeMacApp("Google Chrome", "app.icns", icns([{ type: "ic11", payload: fakePng(9) }]));
    const resources = path.join(appPath, "Contents", "Resources");
    // A document-type icon that must not win: it sorts first alphabetically.
    fs.writeFileSync(path.join(resources, "aaa-document.icns"), icns([{ type: "ic11", payload: fakePng(8) }]));

    expect(resolveMacAppIconFile(appPath)).toBe(path.join(resources, "app.icns"));
  });
});
