import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import zlib from "node:zlib";

/*
 * Extracts the SDK's zip archives (platform-tools, the emulator, a system
 * image) with Node built-ins only.
 *
 * `fflate` and the renderer's zip readers drop the Unix file modes and the
 * symlinks, and the emulator needs both: its binaries must stay executable and
 * the macOS build links its frameworks. System images are close to 2 GB, so
 * the reader handles Zip64 and streams each entry instead of reading it whole.
 *
 * Every entry name is checked before anything is written: an absolute path, a
 * drive letter or a `..` segment is refused, and so is a symlink whose target
 * leaves the destination ("zip slip").
 */

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The EOCD record is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** Unix mode bits when the archive came from a Unix host, else null. */
  mode: number | null;
  directory: boolean;
  symlink: boolean;
  encrypted: boolean;
};

export class ZipExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipExtractError";
  }
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (read === 0) throw new ZipExtractError("The archive ended early.");
    offset += read;
  }
  return buffer;
}

/** Reads a 64-bit little-endian size; archives here stay far below 2^53. */
function readUInt64(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigUInt64LE(offset));
}

/** The central directory, with the Zip64 records when the 32-bit fields overflow. */
export function readZipEntries(zipPath: string): ZipEntry[] {
  const fd = fs.openSync(zipPath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const tailLength = Math.min(fileSize, EOCD_SEARCH_BYTES);
    const tail = readExactly(fd, tailLength, fileSize - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new ZipExtractError(`${path.basename(zipPath)} is not a zip archive.`);
    let entryCount = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new ZipExtractError("The archive's Zip64 locator is missing.");
      }
      const zip64Offset = readUInt64(tail, locator + 8);
      const zip64 = readExactly(fd, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw new ZipExtractError("The archive's Zip64 record is damaged.");
      entryCount = readUInt64(zip64, 32);
      directorySize = readUInt64(zip64, 40);
      directoryOffset = readUInt64(zip64, 48);
    }
    const directory = readExactly(fd, directorySize, directoryOffset);
    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new ZipExtractError("The archive's file list is damaged.");
      const madeBy = directory.readUInt16LE(cursor + 4);
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let size = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      let localHeaderOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      // Zip64 extra field (0x0001): only the fields whose 32-bit value overflowed, in this order.
      let extra = cursor + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = directory.readUInt16LE(extra);
        const length = directory.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) { size = readUInt64(directory, field); field += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = readUInt64(directory, field); field += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = readUInt64(directory, field); }
        }
        extra += 4 + length;
      }
      const unixMode = madeBy >> 8 === UNIX_HOST ? externalAttributes >>> 16 : 0;
      const mode = unixMode ? unixMode : null;
      const directoryEntry = name.endsWith("/") || (mode !== null && (mode & S_IFMT) === S_IFDIR);
      entries.push({
        name,
        method,
        compressedSize,
        size,
        localHeaderOffset,
        mode,
        directory: directoryEntry,
        symlink: mode !== null && (mode & S_IFMT) === S_IFLNK,
        encrypted: (flags & 0x1) === 0x1,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The entry's path relative to the destination, or null when it is not safe:
 * absolute, a drive letter, a `..` segment, or an empty name.
 */
export function safeZipEntryPath(name: string): string | null {
  const normalized = name.replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) return null;
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

/** The one top-level folder every entry shares (`platform-tools/`), or null. */
export function zipCommonRoot(entries: readonly ZipEntry[]): string | null {
  let root: string | null = null;
  for (const entry of entries) {
    const safe = safeZipEntryPath(entry.name);
    if (!safe) continue;
    const first = safe.split("/")[0]!;
    const isOnlyTopFile = !safe.includes("/") && !entry.directory;
    if (isOnlyTopFile) return null;
    if (root === null) root = first;
    else if (root !== first) return null;
  }
  return root;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where the entry's data starts: after its local header, whose extra field can differ from the central one. */
function entryDataOffset(fd: number, entry: ZipEntry): number {
  const header = readExactly(fd, 30, entry.localHeaderOffset);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipExtractError(`The archive entry ${entry.name} is damaged.`);
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

export type ZipExtractProgress = { entriesDone: number; entryCount: number; bytesDone: number; bytesTotal: number };

export type ZipExtractOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ZipExtractProgress) => void;
  platform?: NodeJS.Platform;
};

/**
 * Extracts every entry of `zipPath` under `destination` (made if missing).
 * Throws on a damaged archive, an unsafe name, an encrypted entry or an
 * unknown compression method; the caller removes the half-written folder.
 * Progress counts compressed bytes, the part a download already measured.
 */
export async function extractZip(zipPath: string, destination: string, options: ZipExtractOptions = {}): Promise<{ entries: number; bytes: number }> {
  const platform = options.platform ?? process.platform;
  const entries = readZipEntries(zipPath);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const bytesTotal = entries.reduce((sum, entry) => sum + entry.compressedSize, 0);
  let bytesDone = 0;
  let entriesDone = 0;
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    options.onProgress?.({ entriesDone, entryCount: entries.length, bytesDone, bytesTotal });
  };
  const symlinks: Array<{ target: string; linkPath: string }> = [];
  const fileModes: Array<{ filePath: string; mode: number }> = [];
  const fd = fs.openSync(zipPath, "r");
  try {
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const relative = safeZipEntryPath(entry.name);
      if (!relative) throw new ZipExtractError(`The archive has an unsafe file name: ${entry.name}`);
      const outPath = path.join(root, ...relative.split("/"));
      if (!isInside(root, outPath)) throw new ZipExtractError(`The archive has an unsafe file name: ${entry.name}`);
      if (entry.encrypted) throw new ZipExtractError(`The archive entry ${entry.name} is encrypted.`);
      if (entry.directory) {
        fs.mkdirSync(outPath, { recursive: true });
        entriesDone += 1;
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipExtractError(`The archive entry ${entry.name} uses compression method ${entry.method}, which ADE cannot read.`);
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const start = entryDataOffset(fd, entry);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesDone += chunk.length;
          report();
          callback(null, chunk);
        },
      });
      if (entry.symlink) {
        // A symlink's data is its target path; collect it and make the links last.
        const raw = entry.compressedSize === 0
          ? Buffer.alloc(0)
          : readExactly(fd, entry.compressedSize, start);
        const data = entry.method === 8 ? zlib.inflateRawSync(raw) : raw;
        bytesDone += entry.compressedSize;
        symlinks.push({ target: data.toString("utf8"), linkPath: outPath });
        entriesDone += 1;
        continue;
      }
      const source = entry.compressedSize === 0
        ? null
        : fs.createReadStream(zipPath, { start, end: start + entry.compressedSize - 1, signal: options.signal });
      const sink = fs.createWriteStream(outPath, { signal: options.signal });
      if (!source) {
        sink.end();
        await new Promise<void>((resolve, reject) => {
          sink.once("finish", resolve);
          sink.once("error", reject);
        });
      } else if (entry.method === 8) {
        await pipeline(source, counter, zlib.createInflateRaw(), sink, { signal: options.signal });
      } else {
        await pipeline(source, counter, sink, { signal: options.signal });
      }
      if (entry.mode !== null && platform !== "win32") fileModes.push({ filePath: outPath, mode: entry.mode & 0o7777 });
      entriesDone += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  for (const link of symlinks) {
    options.signal?.throwIfAborted();
    const resolvedTarget = path.resolve(path.dirname(link.linkPath), link.target);
    if (path.isAbsolute(link.target) || !isInside(root, resolvedTarget)) {
      throw new ZipExtractError(`The archive has a link that points outside its folder: ${path.relative(root, link.linkPath)}`);
    }
    fs.rmSync(link.linkPath, { force: true });
    if (platform === "win32") {
      // Windows needs a privilege for symlinks; Google's Windows archives have none. Copy the target instead.
      if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile()) fs.copyFileSync(resolvedTarget, link.linkPath);
      continue;
    }
    fs.symlinkSync(link.target, link.linkPath);
  }
  for (const { filePath, mode } of fileModes) fs.chmodSync(filePath, mode);
  report(true);
  return { entries: entries.length, bytes: bytesTotal };
}
