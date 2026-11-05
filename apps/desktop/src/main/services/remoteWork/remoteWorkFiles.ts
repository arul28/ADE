import { createHash, randomUUID, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../shared/pathCompare";

/* ──────────────────────────────────────────────────────────────────────────
   FILES IN A CHAT'S WORK COPY — `ade files push|pull --machine <name>`.

   A chat on another machine copies one file into or out of its own work copy
   here (remoteWorkCopyService.ts), in chunks over the machine link, instead
   of encoding the file into shell commands. Paths are relative to the copy;
   nothing outside it is reachable, and the caller names no copy: the RPC
   server picks the one its foreign session id owns.

   Push: begin (size, sha256) → chunks in order → commit (size and sha256
   checked, then an atomic rename from a temp file in the same folder).
   Pull: stat (size, sha256) → chunks by offset; the caller checks the hash.
   ────────────────────────────────────────────────────────────────────────── */

/** The largest file either way. A bigger one belongs in git, or a release asset. */
export const REMOTE_WORK_FILE_MAX_BYTES = 256 * 1024 * 1024;
/**
 * One chunk, before base64. A reply is capped at 12 MiB
 * (SYNC_REMOTE_COMMAND_RESULT_MAX_BYTES) and a request carries a work copy's
 * 16 MiB patch already, so 4 MiB (5.4 MiB as base64) fits both ways.
 */
export const REMOTE_WORK_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
/** A push with no chunk this long is given up and its temp file removed. */
const PUSH_IDLE_MS = 10 * 60_000;
/** A temp file left by a brain that exited mid-push is removed after this. */
const STALE_TEMP_MS = 60 * 60_000;
/** Pushes one chat may have open at once. */
const MAX_OPEN_PUSHES_PER_OWNER = 8;
const TEMP_PREFIX = ".ade-push-";
const TEMP_SUFFIX = ".part";
const SHA256 = /^[0-9a-f]{64}$/i;

export class RemoteWorkFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const tooLarge = (bytes: number): RemoteWorkFileError => new RemoteWorkFileError(
  "file_too_large",
  `The file is ${bytes} bytes, over the ${REMOTE_WORK_FILE_MAX_BYTES / (1024 * 1024)} MiB limit for ade files push and pull. `
  + "Commit it (or put it where both machines can download it) instead.",
);

/**
 * The caller's path as segments inside the copy. `/` and `\` both separate
 * (a caller on Windows or not), and anything that could leave the copy or
 * reach its git metadata is refused: an absolute path, a drive or UNC root,
 * `..`, a `:` (a drive or an NTFS stream), or `.git` as the first segment.
 */
export function workCopyRelativeSegments(requested: unknown): string[] {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw || raw.length > 4096 || raw.includes("\0")) {
    throw new RemoteWorkFileError("invalid_path", "Give a path inside this chat's work copy there, like src/config.json.");
  }
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new RemoteWorkFileError(
      "invalid_path",
      `${raw} is an absolute path. Paths are relative to this chat's work copy there (like src/config.json).`,
    );
  }
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (!segments.length) {
    throw new RemoteWorkFileError("invalid_path", "Give a file path inside this chat's work copy there, not the copy itself.");
  }
  if (segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw new RemoteWorkFileError("invalid_path", `${raw} leaves this chat's work copy there; use a path inside it.`);
  }
  // A Windows device name opens the device, not a file; refused everywhere so
  // a path works the same whichever machine it is sent to.
  if (segments.some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment))) {
    throw new RemoteWorkFileError("invalid_path", `${raw} uses a name Windows keeps for a device; pick another name.`);
  }
  if (segments[0]!.toLowerCase() === ".git") {
    throw new RemoteWorkFileError("invalid_path", "The work copy's git metadata is not reachable with ade files.");
  }
  return segments;
}

function realRootOf(copyRoot: string): string {
  try {
    return fs.realpathSync(copyRoot);
  } catch {
    throw new RemoteWorkFileError("copy_missing", "This chat's work copy here is gone. Run `ade shell start --machine <this machine>` to make it again.");
  }
}

function assertInside(realRoot: string, candidate: string, shown: string): void {
  if (!isPathInside(candidate, realRoot)) {
    throw new RemoteWorkFileError("invalid_path", `${shown} leads outside this chat's work copy there (a link); it was refused.`);
  }
}

/**
 * The file `requested` names in the copy, for reading: it must exist, be a
 * regular file, and resolve (links followed) inside the copy.
 */
function resolveForRead(copyRoot: string, requested: unknown): { absolute: string; relative: string } {
  const segments = workCopyRelativeSegments(requested);
  const relative = segments.join("/");
  const realRoot = realRootOf(copyRoot);
  let real: string;
  try {
    real = fs.realpathSync(path.join(realRoot, ...segments));
  } catch {
    throw new RemoteWorkFileError("not_found", `${relative} is not in this chat's work copy there.`);
  }
  assertInside(realRoot, real, relative);
  if (!fs.statSync(real).isFile()) {
    throw new RemoteWorkFileError("not_a_file", `${relative} is not a file in this chat's work copy there.`);
  }
  return { absolute: real, relative };
}

/**
 * Where a pushed file goes: its folder is made (inside the copy, every
 * existing step resolved through links and checked), and the name itself must
 * not be a folder. A link at the name is replaced by the file, never followed.
 */
function resolveForWrite(copyRoot: string, requested: unknown): { absolute: string; relative: string } {
  const segments = workCopyRelativeSegments(requested);
  const relative = segments.join("/");
  const realRoot = realRootOf(copyRoot);
  let folder = realRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(folder, segment);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(next);
    } catch {
      // Missing: made below.
    }
    if (stat && !stat.isDirectory()) {
      throw new RemoteWorkFileError("not_a_folder", `${relative}: ${segment} is a file there, not a folder.`);
    }
    if (!stat) fs.mkdirSync(next);
    folder = fs.realpathSync(next);
    assertInside(realRoot, folder, relative);
  }
  const absolute = path.join(folder, segments[segments.length - 1]!);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(absolute);
  } catch {
    // A new file.
  }
  if (existing?.isDirectory()) {
    throw new RemoteWorkFileError("not_a_file", `${relative} is a folder in this chat's work copy there.`);
  }
  return { absolute, relative };
}

/** Temp files of pushes a brain did not live to finish, in one folder. */
function removeStaleTemps(folder: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
    const file = path.join(folder, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_TEMP_MS) fs.rmSync(file, { force: true });
    } catch {
      // Gone already, or held open on Windows: the next push tries again.
    }
  }
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return hash.digest("hex");
}

type OpenPush = {
  owner: string;
  tempPath: string;
  finalPath: string;
  relative: string;
  size: number;
  sha256: string;
  received: number;
  hash: Hash;
  fd: number;
  touchedAt: number;
};

export type RemoteWorkFilePushBegin = { owner: string; copyRoot: string; path: unknown; size: unknown; sha256: unknown };

export function createRemoteWorkFiles(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const pushes = new Map<string, OpenPush>();

  const drop = (id: string, push: OpenPush): void => {
    pushes.delete(id);
    try {
      fs.closeSync(push.fd);
    } catch {
      // Closed already.
    }
    fs.rmSync(push.tempPath, { force: true });
  };

  const expire = (): void => {
    const cutoff = now() - PUSH_IDLE_MS;
    for (const [id, push] of pushes) if (push.touchedAt < cutoff) drop(id, push);
  };

  /** The caller's own open push; another chat's id reads as unknown. */
  const ownPush = (owner: string, transferId: unknown): [string, OpenPush] => {
    const id = typeof transferId === "string" ? transferId : "";
    const push = pushes.get(id);
    if (!push || push.owner !== owner) {
      throw new RemoteWorkFileError("unknown_transfer", "That push is not open here (it finished, failed, or sat idle for 10 minutes). Run ade files push again.");
    }
    return [id, push];
  };

  return {
    beginPush(input: RemoteWorkFilePushBegin): { transferId: string; path: string; chunkBytes: number } {
      expire();
      const size = typeof input.size === "number" && Number.isInteger(input.size) && input.size >= 0 ? input.size : -1;
      if (size < 0) throw new RemoteWorkFileError("invalid_size", "The push did not say how big the file is.");
      if (size > REMOTE_WORK_FILE_MAX_BYTES) throw tooLarge(size);
      const sha256 = typeof input.sha256 === "string" && SHA256.test(input.sha256) ? input.sha256.toLowerCase() : "";
      if (!sha256) throw new RemoteWorkFileError("invalid_hash", "The push did not carry the file's sha256.");
      if ([...pushes.values()].filter((push) => push.owner === input.owner).length >= MAX_OPEN_PUSHES_PER_OWNER) {
        throw new RemoteWorkFileError("too_many_transfers", `This chat already has ${MAX_OPEN_PUSHES_PER_OWNER} pushes open here. Let them finish first.`);
      }
      const target = resolveForWrite(input.copyRoot, input.path);
      const folder = path.dirname(target.absolute);
      removeStaleTemps(folder, now());
      const id = randomUUID();
      // In the target's own folder, so the rename at the end never crosses a disk.
      const tempPath = path.join(folder, `${TEMP_PREFIX}${id}${TEMP_SUFFIX}`);
      const fd = fs.openSync(tempPath, "wx");
      pushes.set(id, {
        owner: input.owner,
        tempPath,
        finalPath: target.absolute,
        relative: target.relative,
        size,
        sha256,
        received: 0,
        hash: createHash("sha256"),
        fd,
        touchedAt: now(),
      });
      return { transferId: id, path: target.relative, chunkBytes: REMOTE_WORK_FILE_CHUNK_BYTES };
    },

    /** The next chunk, in order: `offset` must be what has arrived so far. */
    writeChunk(owner: string, transferId: unknown, offset: unknown, dataBase64: unknown): { received: number } {
      expire();
      const [id, push] = ownPush(owner, transferId);
      if (offset !== push.received) {
        drop(id, push);
        throw new RemoteWorkFileError("out_of_order", `The push sent bytes at ${String(offset)}, expected ${push.received}. Run ade files push again.`);
      }
      const bytes = typeof dataBase64 === "string" ? Buffer.from(dataBase64, "base64") : Buffer.alloc(0);
      if (bytes.length > REMOTE_WORK_FILE_CHUNK_BYTES || push.received + bytes.length > push.size) {
        drop(id, push);
        throw new RemoteWorkFileError("size_mismatch", `The push sent more than the ${push.size} bytes it announced.`);
      }
      try {
        fs.writeSync(push.fd, bytes, 0, bytes.length, push.received);
      } catch (error) {
        drop(id, push);
        throw new RemoteWorkFileError("write_failed", `Could not write ${push.relative} there: ${error instanceof Error ? error.message : String(error)}`);
      }
      push.hash.update(bytes);
      push.received += bytes.length;
      push.touchedAt = now();
      return { received: push.received };
    },

    /** Checks size and hash, then puts the file in place in one rename. */
    commitPush(owner: string, transferId: unknown): { path: string; bytes: number; sha256: string } {
      expire();
      const [id, push] = ownPush(owner, transferId);
      pushes.delete(id);
      try {
        // Closed before the rename: Windows refuses to move an open file.
        fs.closeSync(push.fd);
        const sha256 = push.hash.digest("hex");
        if (push.received !== push.size || sha256 !== push.sha256) {
          throw new RemoteWorkFileError(
            "hash_mismatch",
            `${push.relative} arrived as ${push.received} bytes with sha256 ${sha256}, not the ${push.size} bytes and ${push.sha256} sent; it was not written.`,
          );
        }
        fs.renameSync(push.tempPath, push.finalPath);
        return { path: push.relative, bytes: push.size, sha256 };
      } catch (error) {
        fs.rmSync(push.tempPath, { force: true });
        if (error instanceof RemoteWorkFileError) throw error;
        throw new RemoteWorkFileError("write_failed", `Could not put ${push.relative} in place there: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    abortPush(owner: string, transferId: unknown): { aborted: boolean } {
      const id = typeof transferId === "string" ? transferId : "";
      const push = pushes.get(id);
      if (!push || push.owner !== owner) return { aborted: false };
      drop(id, push);
      return { aborted: true };
    },

    async statForPull(copyRoot: string, requested: unknown): Promise<{ path: string; size: number; sha256: string; chunkBytes: number }> {
      const file = resolveForRead(copyRoot, requested);
      const size = fs.statSync(file.absolute).size;
      if (size > REMOTE_WORK_FILE_MAX_BYTES) throw tooLarge(size);
      return { path: file.relative, size, sha256: await sha256OfFile(file.absolute), chunkBytes: REMOTE_WORK_FILE_CHUNK_BYTES };
    },

    /** One chunk from `offset`; the path is checked again on every read. */
    readChunk(copyRoot: string, requested: unknown, offset: unknown): { offset: number; length: number; size: number; dataBase64: string; done: boolean } {
      const file = resolveForRead(copyRoot, requested);
      const size = fs.statSync(file.absolute).size;
      if (size > REMOTE_WORK_FILE_MAX_BYTES) throw tooLarge(size);
      const start = typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? Math.min(offset, size) : 0;
      const length = Math.min(REMOTE_WORK_FILE_CHUNK_BYTES, size - start);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file.absolute, "r");
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      return { offset: start, length, size, dataBase64: buffer.toString("base64"), done: start + length >= size };
    },
  };
}

export type RemoteWorkFiles = ReturnType<typeof createRemoteWorkFiles>;
