import { createRequire } from "node:module";
import path from "node:path";
import { nonAsarFs } from "./nonAsarFs";
import { execFileOffThread } from "./offThreadSpawn";

/**
 * Remove a directory tree from a separate process.
 *
 * Every async `fs` call in a Node process shares one pool of four libuv
 * threads, and a recursive `fs.promises.rm` queues an operation for every file
 * in the tree. Until that queue drains, every other file read, stat and DNS
 * lookup in the process waits behind it. On a Windows brain, removing one 6 GB
 * lane folder (190,000 files, each scanned by Defender) held the pool for 30 s:
 * a one-stat step of the next lane delete took 18 s, and other machines' event
 * reads timed out and dropped their connection. A synchronous `rmSync` is
 * worse: it stops the event loop for the whole removal.
 *
 * A child copy of this runtime (Electron run as Node, or Node itself) removes
 * the tree with its own thread pool. `fs.rm` removes a symlink or junction
 * itself and never what it points to. The child reads its target from the
 * environment, so no shell ever parses the path, and uses `original-fs`, so an
 * `.asar` file inside the tree is removed as a file.
 */

/** A removal still running after this long is stopped; what is left stays for the caller. */
const REMOVE_TREE_TIMEOUT_MS = 30 * 60_000;
/** Removals that run at once. More only compete for the same disk. */
const MAX_CONCURRENT_REMOVALS = 2;
const TARGET_ENV = "ADE_REMOVE_TREE_TARGET";

const CHILD_SCRIPT = [
  `const target = process.env.${TARGET_ENV};`,
  "let fs;",
  "try { fs = require('original-fs'); } catch { fs = require('fs'); }",
  "if (!target) { process.stderr.write('No target.'); process.exit(2); }",
  "fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })",
  "  .then(() => process.exit(0), (error) => {",
  "    process.stderr.write(String((error && error.message) || error));",
  "    process.exit(1);",
  "  });",
].join("\n");

let running = 0;
const waiting: Array<() => void> = [];

async function withRemovalSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_REMOVALS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * A single-executable build runs its own entry point whatever its arguments
 * are, so starting it with `-e` would start another copy of ADE.
 */
function isSingleExecutable(): boolean {
  try {
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    return (require("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

function canRemoveInChild(): boolean {
  return Boolean(process.execPath) && !isSingleExecutable();
}

class RemoveTreeChildUnavailableError extends Error {}

async function removeInChild(targetPath: string): Promise<void> {
  const result = await execFileOffThread(process.execPath, ["-e", CHILD_SCRIPT], {
    timeoutMs: REMOVE_TREE_TIMEOUT_MS,
    envPatch: {
      ELECTRON_RUN_AS_NODE: "1",
      [TARGET_ENV]: targetPath,
      // The child is a bare Node script. ADE's own preloads and flags are not for it.
      NODE_OPTIONS: undefined,
    },
  });
  if (result.exitCode === 0) return;
  if (result.exitCode === null && result.error && !/timed out/i.test(result.error.message)) {
    // It never ran (spawn failed, or the off-thread spawner is gone).
    throw new RemoveTreeChildUnavailableError(result.error.message);
  }
  const detail = result.stderr.trim() || result.error?.message || `exit code ${result.exitCode}`;
  throw new Error(`Could not remove ${targetPath}: ${detail}`);
}

/**
 * Removes `targetPath` and everything under it without loading this process's
 * thread pool or event loop. A missing path is already removed. A file or link
 * is removed here, since that is one operation. When no child process can run,
 * the tree is removed in this process, as before.
 *
 * Rejects when part of the tree could not be removed (a file another process
 * holds open on Windows, say); whatever was removed stays removed.
 */
export async function removeTreeOffProcess(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  let isDirectory: boolean;
  try {
    const stat = await nonAsarFs.promises.lstat(resolved);
    isDirectory = stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  if (!isDirectory || !canRemoveInChild()) {
    await nonAsarFs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    return;
  }
  try {
    await withRemovalSlot(() => removeInChild(resolved));
  } catch (error) {
    if (!(error instanceof RemoveTreeChildUnavailableError)) throw error;
    await nonAsarFs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}
