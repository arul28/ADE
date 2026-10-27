import { spawn } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import { TOOL_SPACE_HEADROOM_BYTES, readFreeBytes } from "./diskSpace";
import { ToolError } from "./errors";
import type { ToolDecompressStep } from "./manifest";

export type ToolExtractor = (archivePath: string, destDir: string) => Promise<void>;

/**
 * Resolve the `tar` to run. On Windows this must be System32's bsdtar by
 * absolute path — a PATH-planted `tar.exe` would otherwise get to unpack a
 * 300 MB archive with our privileges.
 */
function resolveTarCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? resolveTrustedWindowsTool("tar") : "tar";
}

function extractError(message: string, cause?: unknown): ToolError {
  return new ToolError(message, { kind: "extract", cause });
}

async function runTar(
  archivePath: string,
  destDir: string,
  stripComponents: number,
  compression: "gzip" | "xz" = "gzip",
): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const command = resolveTarCommand(process.platform);
  const args = [compression === "xz" ? "-xJf" : "-xzf", archivePath, "-C", destDir];
  if (stripComponents > 0) args.push("--strip-components", String(stripComponents));

  const failure = await new Promise<string | null>((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the tail only; a corrupt archive can produce megabytes of noise.
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      resolve(stderr.trim() || `tar failed with ${reason}`);
    });
  });

  if (failure) {
    throw extractError(`Failed to unpack ${archivePath}: ${failure}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Walk an unpacked tree and refuse anything a tool archive has no business
 * containing: a symlink that points outside the tree (or anywhere absolute),
 * and anything that is not a file, a directory or a symlink (fifos, sockets,
 * devices). Both GNU tar and bsdtar already refuse `..` members and strip
 * leading `/` by default; this is the check that does not depend on which tar
 * the machine has. Iterative, so a deep tree cannot overflow the stack.
 */
async function auditExtractedTree(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile()) continue;
      if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(entryPath);
        if (path.isAbsolute(target) || !isInside(resolvedRoot, path.resolve(dir, target))) {
          throw extractError(
            `Refusing ${path.relative(resolvedRoot, entryPath)}: it links to ${target}, outside the tool's own directory.`,
          );
        }
        continue;
      }
      throw extractError(`Refusing ${path.relative(resolvedRoot, entryPath)}: it is not a file, directory or symlink.`);
    }
  }
}

/**
 * Unpack an npm tarball into `destDir`.
 *
 * Uses the system `tar` for the same reason `commands/brainUpdate.ts` does —
 * ADE ships no tar library and adding one to unpack a 300 MB binary would cost
 * more than it saves. `--strip-components 1` drops npm's `package/` root so the
 * destination mirrors what a `node_modules/<pkg>` directory looks like.
 *
 * Async on purpose: this runs inside the long-lived brain, where a synchronous
 * multi-hundred-megabyte extraction would stall every other session.
 */
export const extractNpmTarball: ToolExtractor = async (archivePath, destDir) => {
  await runTar(archivePath, destDir, 1);
  await auditExtractedTree(destDir);
};

/**
 * Unpack a vendor release archive (`archive` pins) into `destDir`, which must
 * not exist yet or be empty. `.tar.gz` and `.tar.xz` go through the system tar like an npm
 * tarball. `.zip` is read by {@link extractZip} on every OS: GNU tar on Linux
 * cannot read zips, and one reader everywhere keeps the guards identical.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  options: { archive: "tar.gz" | "tar.xz" | "zip"; stripComponents: number },
): Promise<void> {
  if (options.archive === "zip") {
    await extractZip(archivePath, destDir, options.stripComponents);
  } else {
    await runTar(archivePath, destDir, options.stripComponents, options.archive === "tar.xz" ? "xz" : "gzip");
  }
  await auditExtractedTree(destDir);
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT_BYTES = 0xffff;
/** A vendor tool's central directory is kilobytes; anything near this is not one. */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

type ZipEntry = {
  /** Destination path relative to `destDir`, POSIX separators, already stripped. */
  relativePath: string;
  directory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  executable: boolean;
};

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw extractError("The zip archive is truncated.");
  return buffer;
}

function readUInt64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw extractError("The zip archive declares an impossible size.");
  return Number(value);
}

/**
 * The archive member's destination, or null for a member that the strip
 * removes entirely (the root directory itself). Every name is validated
 * before stripping, so a stripped `../` can never hide a traversal.
 */
function zipDestination(name: string, directory: boolean, stripComponents: number): string | null {
  const trimmed = directory ? name.replace(/\/+$/, "") : name;
  if (
    trimmed.length === 0
    || trimmed.includes("\\")
    || trimmed.includes("\0")
    || trimmed.startsWith("/")
    || /^[A-Za-z]:/.test(trimmed)
  ) {
    throw extractError(`Refusing zip member ${JSON.stringify(name)}: not a relative path.`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw extractError(`Refusing zip member ${JSON.stringify(name)}: it contains an empty or traversal segment.`);
  }
  if (segments.length <= stripComponents) {
    if (directory) return null;
    throw extractError(
      `Zip member ${JSON.stringify(name)} sits above the ${stripComponents} leading director${stripComponents === 1 ? "y" : "ies"} the pin strips.`,
    );
  }
  return segments.slice(stripComponents).join("/");
}

async function readZipEntries(
  handle: fs.promises.FileHandle,
  fileSize: number,
  stripComponents: number,
): Promise<{ entries: ZipEntry[]; centralOffset: number }> {
  if (fileSize < EOCD_MIN_BYTES) throw extractError("The file is too small to be a zip archive.");
  const tailLength = Math.min(fileSize, EOCD_MIN_BYTES + EOCD_MAX_COMMENT_BYTES);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  let eocd = -1;
  for (let offset = tail.length - EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    // The comment length must reach exactly to the end of the file, so a
    // signature-shaped run of bytes inside a comment is not mistaken for one.
    if (tail.readUInt32LE(offset) === EOCD_SIGNATURE && offset + EOCD_MIN_BYTES + tail.readUInt16LE(offset + 20) === tail.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw extractError("The archive has no zip end-of-central-directory record.");

  let diskNumber = tail.readUInt16LE(eocd + 4);
  let centralDisk = tail.readUInt16LE(eocd + 6);
  let entryCount = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locatorAt = tailStart + eocd - 20;
    if (locatorAt < 0) throw extractError("The zip64 archive has no end-of-central-directory locator.");
    const locator = await readAt(handle, locatorAt, 20);
    if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw extractError("The zip64 archive has no end-of-central-directory locator.");
    }
    const record = await readAt(handle, readUInt64(locator, 8), 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw extractError("The zip64 end-of-central-directory record is missing.");
    diskNumber = record.readUInt32LE(16);
    centralDisk = record.readUInt32LE(20);
    entryCount = readUInt64(record, 32);
    centralSize = readUInt64(record, 40);
    centralOffset = readUInt64(record, 48);
  }
  if (diskNumber !== 0 || centralDisk !== 0) throw extractError("Multi-part zip archives are not supported.");
  if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > fileSize) {
    throw extractError("The zip central directory is out of bounds.");
  }

  const central = await readAt(handle, centralOffset, centralSize);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_ENTRY_SIGNATURE) {
      throw extractError("The zip central directory is corrupt.");
    }
    const madeBy = central.readUInt16LE(cursor + 4);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    let compressedSize = central.readUInt32LE(cursor + 20);
    let uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    let localHeaderOffset = central.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > central.length) throw extractError("The zip central directory is corrupt.");
    // Bit 11 marks a UTF-8 name; older tools wrote CP437, which only differs
    // above ASCII and no vendor tool ships such names.
    const name = central.subarray(nameStart, extraStart).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");

    // A zip64 extra field carries, in order, whichever sizes and offset the
    // fixed fields left saturated at 0xffffffff.
    for (let extra = extraStart; extra + 4 <= extraStart + extraLength;) {
      const id = central.readUInt16LE(extra);
      const size = central.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = readUInt64(central, field); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = readUInt64(central, field); field += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = readUInt64(central, field); }
      }
      extra += 4 + size;
    }

    const unixMode = madeBy >> 8 === UNIX_HOST ? externalAttributes >>> 16 : 0;
    if ((unixMode & S_IFMT) === S_IFLNK) throw extractError(`Refusing zip member ${JSON.stringify(name)}: it is a symlink.`);
    if ((flags & 0x1) !== 0) throw extractError(`Refusing zip member ${JSON.stringify(name)}: it is encrypted.`);
    const directory = name.endsWith("/");
    if (!directory && method !== 0 && method !== 8) {
      throw extractError(`Zip member ${JSON.stringify(name)} uses compression method ${method}; only stored and deflate are supported.`);
    }
    const relativePath = zipDestination(name, directory, stripComponents);
    cursor = next;
    if (relativePath === null) continue;
    // Case-folded, so two members cannot land on the same file on a
    // case-insensitive volume (macOS, Windows) and overwrite each other.
    const key = relativePath.toLowerCase();
    if (seen.has(key)) throw extractError(`The zip archive lists ${JSON.stringify(relativePath)} twice.`);
    seen.add(key);
    entries.push({
      relativePath,
      directory,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      executable: (unixMode & 0o111) !== 0,
    });
  }
  return { entries, centralOffset };
}

async function extractZipEntry(
  archivePath: string,
  handle: fs.promises.FileHandle,
  entry: ZipEntry,
  destPath: string,
  dataLimit: number,
): Promise<void> {
  const local = await readAt(handle, entry.localHeaderOffset, 30);
  if (local.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw extractError(`Zip member ${entry.relativePath} has no local header.`);
  }
  const dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (dataStart + entry.compressedSize > dataLimit) {
    throw extractError(`Zip member ${entry.relativePath} runs past the archive's file data.`);
  }

  let written = 0;
  let crc = 0;
  // Counts and checksums what is about to be written, and fails the first
  // chunk that would go past the declared size, so a member cannot inflate
  // to more than the central directory promised.
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > entry.uncompressedSize) {
        callback(extractError(`Zip member ${entry.relativePath} inflates past its declared ${entry.uncompressedSize} bytes.`));
        return;
      }
      crc = zlib.crc32(chunk, crc);
      callback(null, chunk);
    },
  });
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const source = entry.compressedSize === 0
    ? Readable.from([])
    : fs.createReadStream(archivePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const sink = fs.createWriteStream(destPath, { flags: "wx", mode: entry.executable ? 0o755 : 0o644 });
  try {
    if (entry.method === 8) {
      await pipeline(source, zlib.createInflateRaw(), guard, sink);
    } else {
      await pipeline(source, guard, sink);
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
      throw new ToolError(`Ran out of disk space while unpacking ${archivePath}.`, { kind: "disk-space", cause: error });
    }
    throw extractError(`Failed to unpack zip member ${entry.relativePath}: ${(error as Error).message}`, error);
  }
  if (written !== entry.uncompressedSize || crc !== entry.crc32) {
    throw extractError(`Zip member ${entry.relativePath} failed its CRC-32 or size check.`);
  }
}

/**
 * Unpack a zip from its central directory, one member at a time, streaming
 * through Node's own inflate: bounded memory for a 1 GB tool, and no zip
 * dependency in either the brain or the desktop bundle.
 *
 * Refused outright: symlinks, encryption, multi-part archives, compression
 * other than stored/deflate, absolute or traversing names, two members that
 * fold to one path, and a member that inflates past its declared size or
 * fails its CRC-32. The declared total is checked against free space before
 * anything is written.
 */
async function extractZip(archivePath: string, destDir: string, stripComponents: number): Promise<void> {
  const handle = await fsp.open(archivePath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const { entries, centralOffset } = await readZipEntries(handle, fileSize, stripComponents);
    const declaredBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    const available = readFreeBytes(destDir);
    if (available !== null && available < declaredBytes + TOOL_SPACE_HEADROOM_BYTES) {
      throw new ToolError(
        `Not enough free disk space to unpack ${path.basename(archivePath)}: ${declaredBytes} bytes needed, ${available} available.`,
        { kind: "disk-space", requiredBytes: declaredBytes + TOOL_SPACE_HEADROOM_BYTES, availableBytes: available },
      );
    }
    await fsp.mkdir(destDir, { recursive: true });
    for (const entry of entries) {
      const destPath = path.join(destDir, ...entry.relativePath.split("/"));
      if (entry.directory) {
        await fsp.mkdir(destPath, { recursive: true });
        continue;
      }
      // Every member's data lies before the central directory.
      await extractZipEntry(archivePath, handle, entry, destPath, centralOffset);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Inflate each brotli-compressed file of an unpacked payload in place, then
 * drop the compressed copy (Grok ships `bin/grok.br`). The source must be a
 * regular file inside the payload, and the destination must not exist yet,
 * so a step can neither read through nor write through a link.
 */
export async function applyDecompressSteps(payloadDir: string, steps: readonly ToolDecompressStep[]): Promise<void> {
  for (const step of steps) {
    const from = path.join(payloadDir, ...step.from.split("/"));
    const to = path.join(payloadDir, ...step.to.split("/"));
    let stats: fs.Stats;
    try {
      stats = await fsp.lstat(from);
    } catch (error) {
      throw extractError(`The package has no ${step.from} to decompress.`, error);
    }
    if (!stats.isFile()) throw extractError(`${step.from} is not a regular file.`);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await pipeline(fs.createReadStream(from), zlib.createBrotliDecompress(), fs.createWriteStream(to, { flags: "wx" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new ToolError(`Ran out of disk space while decompressing ${step.from}.`, { kind: "disk-space", cause: error });
      }
      throw extractError(`Failed to decompress ${step.from}: ${(error as Error).message}`, error);
    }
    await fsp.rm(from, { force: true });
  }
}
