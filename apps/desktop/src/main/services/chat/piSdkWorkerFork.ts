import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PiSdkForkPayload, PiSdkForkResult, PiSdkWorkerInit } from "./piSdkProtocol";
import { piSessionHeaderMatchesCwd, readPiSessionHeader } from "./piSessionStore";

/**
 * The Pi worker's fork primitive, and the checks on which session files it
 * may read. Bundled into the worker process (`piSdkWorker.ts`); like the
 * worker, it has no static import from Pi and gets the loaded module passed in.
 */

type Callable = (...args: unknown[]) => unknown;
type PiSessionManager = Record<string, unknown>;

/** The worker's checked method lookup; its error names the loaded Pi package. */
export type PiSdkWorkerMethod = (target: unknown, name: string) => Callable;

/** What a fork needs from an initialized worker. */
export type PiSdkWorkerForkContext = {
  /** The loaded Pi SDK module. */
  pi: Record<string, unknown>;
  init: PiSdkWorkerInit;
  method: PiSdkWorkerMethod;
  assertAbsolute: (label: string, value: string) => void;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionFileIsAuthorized(filePath: string, sessionRoot: string | null): boolean {
  if (!sessionRoot) return true;
  try {
    // `.native` on both sides, matching piSessionLease: on Windows the JS
    // realpath keeps 8.3 short names and junction casing, so one spelling of a
    // directory fails containment against another spelling of itself.
    const resolvedFile = fs.realpathSync.native(filePath);
    const resolvedDir = fs.realpathSync.native(sessionRoot);
    const relative = path.relative(resolvedDir, resolvedFile);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function validatedSessionFile(
  filePath: string,
  sessionRoot: string | null,
  expectedId: string | null,
  expectedCwd: string,
): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(path.resolve(filePath));
  } catch {
    return null;
  }
  if (!sessionFileIsAuthorized(resolved, sessionRoot)) return null;
  // A native file may be inside the authorized Pi root while belonging to a
  // different project. Require a non-empty, exact normalized header cwd at
  // this worker boundary; blank cwd must never act as a wildcard.
  const header = readPiSessionHeader(resolved);
  if (!header || !piSessionHeaderMatchesCwd(header, expectedCwd)) return null;
  if (expectedId && header.id !== expectedId) return null;
  return resolved;
}

/**
 * The authorized native file of Pi session `id` in this worker's cwd, or null.
 * Pi 1.x's `findById` reads only headers; older builds list every session.
 */
export async function authorizedSessionFileForId(
  manager: Record<string, unknown>,
  init: PiSdkWorkerInit,
  id: string,
  method: PiSdkWorkerMethod,
): Promise<string | null> {
  const storageDir = nonEmpty(init.sessionStorageDir) ?? undefined;
  let foundPath: string | null;
  if (typeof manager.findById === "function") {
    foundPath = nonEmpty((manager.findById as Callable).call(manager, init.cwd, id, storageDir));
  } else {
    const list = await method(manager, "list").call(manager, init.cwd, storageDir);
    const found = (Array.isArray(list) ? list : []).find((item) => record(item)?.id === id);
    foundPath = nonEmpty(record(found)?.path);
  }
  return foundPath ? validatedSessionFile(foundPath, nonEmpty(init.sessionRoot), id, init.cwd) : null;
}

/** Assistant stop reasons that end a turn. `toolUse` hands over to tool results; `pending`/`deferred` are unfinished. */
const PI_TURN_ENDING_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

/**
 * Whether no turn is in flight after `entry`, given the state before it.
 *
 * Pi persists each message at its `message_end`: the user prompt as a turn
 * starts, then each assistant response and tool result. A turn is settled
 * from an assistant response that does not hand over to tools until the next
 * user prompt or steering message. Every other entry (model and thinking
 * changes, labels, compaction, system and custom messages) keeps the state.
 */
function piEntryLeavesTurnSettled(entry: unknown, settledBefore: boolean): boolean {
  const item = record(entry);
  if (item?.type !== "message") return settledBefore;
  const message = record(item.message);
  if (message?.role === "assistant") return PI_TURN_ENDING_STOP_REASONS.has(String(message.stopReason));
  if (message?.role === "user" || message?.role === "toolResult") return false;
  return settledBefore;
}

/**
 * The bytes of a session file up to its last complete line.
 *
 * The source may be a live session another worker is appending to, so the
 * last line can be half written. Pi's own loader (`SessionManager.open`,
 * `forkFrom`) repairs such a file by appending a newline to it, which on a
 * live file would split the writer's line in two. Copying the complete lines
 * first means Pi only ever opens ADE's private snapshot.
 */
function completeSessionLines(filePath: string): Buffer {
  const bytes = fs.readFileSync(filePath);
  const lastNewline = bytes.lastIndexOf(0x0a);
  return lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
}

/** Point a fork's header at its real source instead of the snapshot Pi branched from. */
function rewriteForkParent(forkFile: string, parentSessionFile: string): void {
  const content = fs.readFileSync(forkFile, "utf8");
  const newline = content.indexOf("\n");
  const headerLine = newline < 0 ? content : content.slice(0, newline);
  const header = record(JSON.parse(headerLine));
  if (header?.type !== "session") throw new Error(`Pi fork ${forkFile} has no session header.`);
  header.parentSession = parentSessionFile;
  const staged = `${forkFile}.${process.pid}.tmp`;
  fs.writeFileSync(staged, `${JSON.stringify(header)}${newline < 0 ? "\n" : content.slice(newline)}`, { flag: "wx", mode: 0o600 });
  fs.renameSync(staged, forkFile);
}

/**
 * Copy a session's history into a new session in this worker's cwd, with
 * Pi's own branching (`createBranchedSession`, which `/fork` and `/clone` use:
 * the root-to-cut path of the active branch, labels kept, a fresh id, and a
 * `parentSession` header). The source is only read, so it may be live and
 * mid-turn in another worker; without `entryId` the cut is the last point at
 * which no turn was in flight, so the copy never ends in a half-finished
 * tool loop. This worker's own session, if any, is untouched.
 */
export async function forkSession(payload: PiSdkForkPayload, context: PiSdkWorkerForkContext): Promise<PiSdkForkResult> {
  const { pi, init, method, assertAbsolute } = context;
  const SessionManager = pi.SessionManager;
  if (!SessionManager || typeof SessionManager !== "function") throw new Error("Pi SDK export SessionManager is unavailable.");
  const manager = SessionManager as unknown as Record<string, unknown>;

  const requestedFile = nonEmpty(payload.sessionFile);
  const requestedId = nonEmpty(payload.sessionId);
  let sourceFile: string | null = null;
  if (requestedFile) {
    assertAbsolute("sessionFile", requestedFile);
    sourceFile = validatedSessionFile(requestedFile, nonEmpty(init.sessionRoot), requestedId, init.cwd);
    if (!sourceFile && !requestedId) {
      throw new Error(`Pi session file "${requestedFile}" is missing, outside the authorized session directory, or belongs to another project.`);
    }
  }
  if (!sourceFile && requestedId) {
    sourceFile = await authorizedSessionFileForId(manager, init, requestedId, method);
    if (!sourceFile) throw new Error(`Pi session "${requestedId}" was not found in the authorized session directory.`);
  }
  if (!sourceFile) throw new Error("Pi fork needs a source sessionFile or sessionId.");
  const sourceHeader = readPiSessionHeader(sourceFile);
  if (!sourceHeader) throw new Error(`Pi session file "${sourceFile}" has no valid header.`);

  // The fork lands where this worker's sessions land: the configured store,
  // or Pi's per-cwd directory, which is the source's own directory.
  const destinationDir = nonEmpty(init.sessionStorageDir) ?? path.dirname(sourceFile);
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-fork-"));
  try {
    const snapshotFile = path.join(snapshotDir, "source.jsonl");
    fs.writeFileSync(snapshotFile, completeSessionLines(sourceFile), { flag: "wx", mode: 0o600 });
    const snapshot = method(manager, "open").call(manager, snapshotFile, destinationDir, init.cwd) as PiSessionManager;
    const branch = method(snapshot, "getBranch").call(snapshot);
    const entries = Array.isArray(branch) ? branch : [];

    let cutId: string | null = null;
    let cutIndex = -1;
    const requestedEntry = nonEmpty(payload.entryId);
    if (requestedEntry) {
      if (!record(method(snapshot, "getEntry").call(snapshot, requestedEntry))) {
        throw new Error(`Pi session "${sourceHeader.id}" has no entry "${requestedEntry}".`);
      }
      cutId = requestedEntry;
      cutIndex = entries.findIndex((entry) => record(entry)?.id === requestedEntry);
    } else {
      let settled = true;
      let finishedTurn = false;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        settled = piEntryLeavesTurnSettled(entry, settled);
        if (settled && record(record(entry)?.message)?.role === "assistant") finishedTurn = true;
        const id = nonEmpty(record(entry)?.id);
        if (settled && finishedTurn && id) {
          cutId = id;
          cutIndex = index;
        }
      }
      if (!cutId) throw new Error(`Pi session "${sourceHeader.id}" has no finished turn to fork yet.`);
    }

    const forkFile = nonEmpty(method(snapshot, "createBranchedSession").call(snapshot, cutId));
    // Pi writes the file only when the copied path holds a message.
    if (!forkFile || !fs.existsSync(forkFile)) {
      throw new Error(`Pi could not fork session "${sourceHeader.id}" at "${cutId}": the copy would hold no messages.`);
    }
    rewriteForkParent(forkFile, sourceFile);
    const forkHeader = readPiSessionHeader(forkFile);
    if (!forkHeader || !validatedSessionFile(forkFile, nonEmpty(init.sessionRoot), forkHeader.id, init.cwd)) {
      fs.rmSync(forkFile, { force: true });
      throw new Error(`Pi wrote the fork of "${sourceHeader.id}" outside the authorized session directory.`);
    }
    const forkEntries = method(snapshot, "getEntries").call(snapshot);
    return {
      sessionFile: fs.realpathSync.native(forkFile),
      sessionId: forkHeader.id,
      parentSessionFile: sourceFile,
      parentSessionId: sourceHeader.id,
      entryId: cutId,
      cut: requestedEntry ? "requested" : "last_settled",
      entryCount: Array.isArray(forkEntries) ? forkEntries.length : 0,
      omittedEntryCount: cutIndex >= 0 ? entries.length - cutIndex - 1 : 0,
    };
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}
