import { createRequire } from "node:module";
import path from "node:path";
import { captureProblem } from "../../../shared/sentry/capture";
import { REMOVE_TREE_TIMEOUT_MS } from "../../../shared/removeTreeTimeouts";
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

const TARGET_ENV = "ADE_REMOVE_TREE_TARGET";
const EXPECTED_REAL_PATH_ENV = "ADE_REMOVE_TREE_EXPECTED_REAL_PATH";

const CHILD_SCRIPT = [
  `const target = process.env.${TARGET_ENV};`,
  "let fs;",
  "try { fs = require('original-fs'); } catch { fs = require('fs'); }",
  "const fail = (code, message) => { process.stderr.write(JSON.stringify({ code, message })); process.exit(1); };",
  "if (!target) fail(null, 'No target.');",
  // The caller checked this path. If a folder on the way was swapped for a
  // link since, it now leads somewhere else: refuse rather than remove that.
  `const expected = process.env.${EXPECTED_REAL_PATH_ENV};`,
  "let real;",
  "try { real = fs.realpathSync.native(target); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); fail((error && error.code) || null, String((error && error.message) || error)); }",
  "if (expected && real !== expected) fail('ECHANGED', 'The folder moved after it was checked.');",
  "fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })",
  "  .then(() => process.exit(0), (error) => fail((error && error.code) || null, String((error && error.message) || error)));",
].join("\n");

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

class RemoveTreeChildUnavailableError extends Error {}

/** The child's error, with the `code` (EBUSY, EPERM...) of what stopped it. */
function childRemoveError(targetPath: string, stderr: string, fallback: string): Error {
  let code: string | null = null;
  let message = stderr.trim() || fallback;
  try {
    const parsed = JSON.parse(stderr) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Not the child's own report (it was killed, say): keep the raw text.
  }
  return Object.assign(new Error(`Could not remove ${targetPath}: ${message}`), code ? { code } : {});
}

async function removeInChild(targetPath: string, expectedRealPath: string): Promise<void> {
  const result = await execFileOffThread(process.execPath, ["-e", CHILD_SCRIPT], {
    timeoutMs: REMOVE_TREE_TIMEOUT_MS,
    envPatch: {
      ELECTRON_RUN_AS_NODE: "1",
      [TARGET_ENV]: targetPath,
      [EXPECTED_REAL_PATH_ENV]: expectedRealPath,
      // The child is a bare Node script. ADE's own preloads and flags are not for it.
      NODE_OPTIONS: undefined,
    },
  });
  if (result.exitCode === 0) return;
  if (result.exitCode === null && result.error && !/timed out/i.test(result.error.message)) {
    // It never ran (spawn failed, or the off-thread spawner is gone).
    throw new RemoveTreeChildUnavailableError(result.error.message);
  }
  throw childRemoveError(targetPath, result.stderr, result.error?.message ?? `exit code ${result.exitCode}`);
}

/**
 * Removes `targetPath` and everything under it without loading this process's
 * thread pool or event loop. A missing path is already removed. A file or link
 * is removed here, since that is one operation. When no child process can run,
 * the tree is removed in this process, as before.
 *
 * Rejects when part of the tree could not be removed; the error carries the
 * `code` of what stopped it (a file another process holds open on Windows is
 * EBUSY or EPERM). Whatever was removed stays removed.
 */
export async function removeTreeOffProcess(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  let isDirectory: boolean;
  try {
    isDirectory = (await nonAsarFs.promises.lstat(resolved)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  if (!isDirectory || isSingleExecutable()) {
    await nonAsarFs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    return;
  }
  let realPath: string;
  try {
    realPath = await nonAsarFs.promises.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  try {
    await removeInChild(resolved, realPath);
  } catch (error) {
    if (!(error instanceof RemoveTreeChildUnavailableError)) throw error;
    captureProblem("Tree removal child process could not start; removing in process", {
      tags: { area: "remove_tree" },
      extra: { reason: error.message },
      fingerprint: ["remove-tree", "child-unavailable"],
    });
    await nonAsarFs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}
