import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractZip } from "./androidZipExtract";

/*
 * The SDK install unpacks archives it downloaded into a folder the person
 * chose. Nothing in an archive may write, or point, outside that folder
 * ("zip slip"), while the emulator's own links and executable bits survive.
 */

type FixtureEntry = { name: string; data?: string; mode: number };

const FILE = 0o100644;
const EXEC = 0o100755;
const LINK = 0o120777;
const DIR = 0o040755;

/** A stored (uncompressed) zip with Unix modes, as Google's SDK archives carry. */
function writeZip(zipPath: string, entries: readonly FixtureEntry[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "", "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...locals, directory, end]));
}

/** Every path under `dir`, links not followed. */
function tree(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const full = path.join(dir, dirent.name);
    const relative = path.relative(base, full);
    return dirent.isDirectory() ? [relative, ...tree(full, base)] : [relative];
  });
}

const posixLinks = process.platform !== "win32";

describe("extractZip", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-zip-"));
  });
  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    { label: "an archive whose files and links stay inside", posixOnly: true, refused: false, entries: [
      { name: "emulator/", mode: DIR },
      { name: "emulator/qemu", data: "binary", mode: EXEC },
      { name: "emulator/qemu-alias", data: "qemu", mode: LINK },
    ] },
    { label: "a `..` file name", posixOnly: false, refused: true, entries: [
      { name: "../escape.txt", data: "x", mode: FILE },
    ] },
    { label: "a link to an absolute path", posixOnly: true, refused: true, entries: [
      { name: "etc", data: "/etc", mode: LINK },
    ] },
    { label: "a link that climbs out", posixOnly: true, refused: true, entries: [
      { name: "up", data: "..", mode: LINK },
    ] },
    { label: "a chain of links that climbs out only once both exist", posixOnly: true, refused: true, entries: [
      { name: "d/", mode: DIR },
      { name: "d/l1", data: "..", mode: LINK },
      { name: "l2", data: "d/l1/..", mode: LINK },
    ] },
  ].filter((row) => posixLinks || !row.posixOnly))("$label", async ({ entries, refused }) => {
    const zipPath = path.join(scratch, "part.zip");
    const destination = path.join(scratch, "sdk", "emulator-part");
    writeZip(zipPath, entries);

    const run = extractZip(zipPath, destination);
    if (refused) {
      await expect(run).rejects.toThrow();
    } else {
      await expect(run).resolves.toMatchObject({ entries: entries.length });
      expect(fs.readFileSync(path.join(destination, "emulator", "qemu"), "utf8")).toBe("binary");
      expect(fs.statSync(path.join(destination, "emulator", "qemu")).mode & 0o111).not.toBe(0);
      expect(fs.readlinkSync(path.join(destination, "emulator", "qemu-alias"))).toBe("qemu");
    }
    // Nothing was written beside the archive or the chosen folder.
    expect(tree(scratch).filter((entry) => !entry.startsWith(path.join("sdk", "emulator-part")))).toEqual(["part.zip", "sdk"]);
  });
});
