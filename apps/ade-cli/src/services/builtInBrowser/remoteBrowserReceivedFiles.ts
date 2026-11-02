import fs from "node:fs";
import path from "node:path";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES,
  BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES,
  type BuiltInBrowserRemoteCallFile,
} from "../../../../desktop/src/shared/types/builtInBrowserRemote";

/** Replies whose files are kept for the agent to read; older ones are pruned. */
const RECEIVED_FILE_DIR_CAP = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clear every `filePath` in a result that is not a file written here. A file
 * the desktop did not send (over the size cap, unreadable) keeps a path that
 * exists only on the user's computer, which the agent cannot read.
 */
function clearForeignFilePaths(node: unknown, keep: ReadonlySet<string>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) clearForeignFilePaths(item, keep, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "filePath" && typeof value === "string" && !keep.has(value)) {
      node.filePath = null;
      if ("relativePath" in node) node.relativePath = null;
      continue;
    }
    clearForeignFilePaths(value, keep, depth + 1);
  }
}

function filesFromReply(value: unknown): BuiltInBrowserRemoteCallFile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILES).filter((file): file is BuiltInBrowserRemoteCallFile => (
    isRecord(file)
    && Array.isArray(file.pointer)
    && file.pointer.length > 0
    && file.pointer.length <= 6
    && file.pointer.every((key) => typeof key === "string")
    && typeof file.fileName === "string"
    && typeof file.base64 === "string"
  ));
}

/**
 * Write the files a desktop's reply carries (an observation's screenshot)
 * where the agent can read them, and point the result at them. A path that
 * names a file on the other machine is cleared, never left for the agent.
 */
export function receiveRemoteCallFiles(args: {
requestId: string;
result: unknown;
/** The reply's `files`, unchecked. */
files: unknown;
/** Where to write them; without one every foreign path is cleared. */
dir: string | null;
logger: Logger;
}): unknown {
const { requestId, result } = args;
const files = filesFromReply(args.files);
  if (!isRecord(result)) return result;
  const next = structuredClone(result) as Record<string, unknown>;
  let wroteAny = false;
  const writtenPaths = new Set<string>();
  for (const file of files) {
    const holder = file.pointer.slice(0, -1).reduce<unknown>(
      (node, key) => (isRecord(node) ? node[key] : undefined),
      next,
    );
    const field = file.pointer[file.pointer.length - 1];
    if (!isRecord(holder) || !field || typeof holder[field] !== "string") continue;
    let written: string | null = null;
    try {
      const bytes = Buffer.from(file.base64, "base64");
      const fileName = path.basename(file.fileName).replace(/[^A-Za-z0-9._-]/g, "_");
      if (args.dir && fileName && bytes.length > 0 && bytes.length <= BUILT_IN_BROWSER_REMOTE_CALL_MAX_FILE_BYTES) {
        const dir = path.join(args.dir, requestId);
        // A screenshot of the user's page: readable by this user only.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        written = path.join(dir, fileName);
        fs.writeFileSync(written, bytes, { mode: 0o600 });
        wroteAny = true;
      }
    } catch (error) {
      written = null;
      args.logger.warn("built_in_browser.remote_call_file_write_failed", {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // Never leave a path that names a file on another machine.
    holder[field] = written;
    if (written) writtenPaths.add(written);
    if ("relativePath" in holder) holder.relativePath = null;
  }
  clearForeignFilePaths(next, writtenPaths);
  if (wroteAny && args.dir) pruneReceivedFiles(args.dir);
  return next;
}

function pruneReceivedFiles(root: string): void {
  let dirs: Array<{ name: string; at: number }>;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
      .sort((left, right) => right.at - left.at);
  } catch {
    return;
  }
  for (const stale of dirs.slice(RECEIVED_FILE_DIR_CAP)) {
    try {
      fs.rmSync(path.join(root, stale.name), { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // A directory Windows still holds open is removed by a later prune.
    }
  }
}
