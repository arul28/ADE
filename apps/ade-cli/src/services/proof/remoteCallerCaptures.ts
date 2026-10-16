import fs from "node:fs";
import path from "node:path";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";

/** How long a caller on another machine may read back what was captured for it. */
const REMOTE_CALLER_CAPTURE_TTL_MS = 15 * 60_000;
/** One chunk of a capture; the transport caps a reply at 25 MiB. */
const REMOTE_CALLER_CAPTURE_CHUNK_BYTES = 4 * 1024 * 1024;

export type RemoteCallerCaptureChunk = {
  size: number;
  offset: number;
  length: number;
  dataBase64: string;
  done: boolean;
};

/**
 * Captures one of ADE's capture actions wrote for a caller on ANOTHER machine
 * (`ade apple proof --machine …`), by path. That caller files its proof in its
 * own machine's drawer, so it reads the bytes back here — only its own, and
 * only while they are fresh. Nothing else on this machine is readable this way.
 */
export function createRemoteCallerCaptures(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const captures = new Map<string, { owner: string; expiresAt: number }>();
  return {
    remember(filePath: string, owner: string): void {
      if (!path.isAbsolute(filePath)) return;
      const at = now();
      for (const [key, entry] of captures) if (entry.expiresAt <= at) captures.delete(key);
      captures.set(pathKey(filePath), { owner, expiresAt: at + REMOTE_CALLER_CAPTURE_TTL_MS });
    },
    /** A chunk of `filePath` for `owner`, or null when it is not theirs to read. */
    readChunk(owner: string, filePath: string, offset: number): RemoteCallerCaptureChunk | null {
      if (!path.isAbsolute(filePath)) return null;
      const entry = captures.get(pathKey(filePath));
      if (!entry || entry.owner !== owner || entry.expiresAt <= now()) return null;
      const size = fs.statSync(filePath).size;
      const start = Math.max(0, Math.floor(offset));
      const length = Math.min(REMOTE_CALLER_CAPTURE_CHUNK_BYTES, Math.max(0, size - start));
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      return { size, offset: start, length, dataBase64: buffer.toString("base64"), done: start + length >= size };
    },
  };
}

export type RemoteCallerCaptures = ReturnType<typeof createRemoteCallerCaptures>;
