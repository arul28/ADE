import fs from "node:fs";
import path from "node:path";

import { captureError } from "../../../shared/sentry/capture";
import { brainRunEndpointKey, pidRuns } from "./brainUnplannedRestart";

/**
 * The projects in which a chat turn or an agent CLI turn is running in this
 * brain, kept on disk so the next brain can open exactly those projects right
 * after a crash. A project is otherwise opened only when a window, a phone or
 * the CLI asks for it, so its chats and CLIs would wait for that.
 *
 * `runtime/live-turns/<endpoint>.<pid>.json` lists project roots. Only the
 * brain turns it on (`enableLiveTurnProjectsRecord`); tests, the desktop's
 * own services and chat-only runtimes write nothing. Writes are asynchronous
 * and coalesced, and happen only when a project gains its first running turn
 * or loses its last one. An orderly stop deletes the file
 * (`closeLiveTurnProjectsRecord`), so a file left behind means its brain
 * stopped unplanned. The next brain on the same endpoint claims such a file
 * with a rename, so two brains never both act on it, and keeps the projects
 * it has not opened yet in its own `<endpoint>.<pid>.pending.json`.
 *
 * Process-global (`globalThis`) because the chat and terminal services are
 * bundled more than once.
 */
const RECORD_DIR = "live-turns";
const MAX_PROJECTS = 50;

/** `opening`: in a pending file, the project the brain was opening when it wrote it. */
type RecordFile = { version: 1; pid: number; projects: string[]; opening?: string };

type Holder = {
  filePath: string | null;
  turns: Map<string, Set<string>>;
  writing: boolean;
  dirty: boolean;
  /**
   * Projects this brain took from a crashed brain and has not opened yet
   * (`<endpoint>.<pid>.pending.json`). If this brain crashes too before it
   * opens them, the next brain takes this file like any other. `opening`:
   * the project being opened now. The next brain skips that one, so a project
   * whose open crashes the brain cannot crash every brain after it (the
   * restart-loop guard does not run where crash reports are off).
   */
  pending: { filePath: string; roots: string[]; opening: string | null } | null;
};

const HOLDER_KEY = Symbol.for("ade.liveTurnProjects");

function holder(): Holder {
  const scope = globalThis as { [HOLDER_KEY]?: Holder };
  let value = scope[HOLDER_KEY];
  if (!value) {
    value = { filePath: null, turns: new Map(), writing: false, dirty: false, pending: null };
    scope[HOLDER_KEY] = value;
  }
  return value;
}

/** One report per process: the write runs at every first and last turn of a project. */
let writeFailureReported = false;

function recordDir(runtimeDir: string): string {
  return path.join(runtimeDir, RECORD_DIR);
}

async function flush(): Promise<void> {
  const state = holder();
  if (state.writing) {
    state.dirty = true;
    return;
  }
  state.writing = true;
  try {
    do {
      state.dirty = false;
      const filePath = state.filePath;
      if (!filePath) return;
      const projects = [...state.turns.keys()].slice(0, MAX_PROJECTS);
      if (projects.length === 0) {
        await fs.promises.rm(filePath, { force: true });
        continue;
      }
      const file: RecordFile = { version: 1, pid: process.pid, projects };
      const tmpPath = `${filePath}.tmp`;
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(file));
      if (state.filePath !== filePath) {
        await fs.promises.rm(tmpPath, { force: true });
        return;
      }
      await fs.promises.rename(tmpPath, filePath);
    } while (state.dirty);
  } catch (error) {
    // Without the file a crash leaves the projects to open on first use, as before.
    if (!writeFailureReported) {
      writeFailureReported = true;
      captureError(error, {
        level: "warning",
        tags: { area: "brain_restart" },
        fingerprint: ["brain_restart", "live_turns_write_failed"],
      });
    }
  } finally {
    state.writing = false;
  }
}

/** The brain turns the record on, once, at start. */
export function enableLiveTurnProjectsRecord(args: { runtimeDir: string; socketPath: string }): void {
  const state = holder();
  state.filePath = path.join(recordDir(args.runtimeDir), `${brainRunEndpointKey(args.socketPath)}.${process.pid}.json`);
  if (state.turns.size > 0) void flush();
}

/** An orderly stop: nothing is left for the next brain to open. Synchronous (it runs while stopping). */
export function closeLiveTurnProjectsRecord(): void {
  const state = holder();
  const filePath = state.filePath;
  const pendingPath = state.pending?.filePath ?? null;
  state.filePath = null;
  state.pending = null;
  state.turns.clear();
  // A file left behind only opens those projects early at the next start.
  if (filePath) removeQuietly(filePath);
  if (pendingPath) removeQuietly(pendingPath);
}

/**
 * A turn started (`live: true`) or ended in this project. `key` names the
 * turn's session. A no-op until the brain enables the record.
 */
export function noteLiveTurn(projectRoot: string, key: string, live: boolean): void {
  const state = holder();
  const root = path.resolve(projectRoot);
  let keys = state.turns.get(root);
  const before = state.turns.size;
  if (live) {
    if (keys?.has(key)) return;
    if (!keys) {
      keys = new Set();
      state.turns.set(root, keys);
    }
    keys.add(key);
  } else {
    if (!keys?.delete(key)) return;
    if (keys.size === 0) state.turns.delete(root);
  }
  if (state.filePath && state.turns.size !== before) void flush();
}

/** The project's services are closing: its turns end with them. */
export function forgetLiveTurnProject(projectRoot: string): void {
  const state = holder();
  if (!state.turns.delete(path.resolve(projectRoot))) return;
  if (state.filePath) void flush();
}

/** A leftover file costs a few bytes; a throw here would stop the brain's start. */
function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Windows can hold a just-closed file for a moment (EBUSY).
  }
}

/**
 * `<endpoint>.` then `<pid>.json` (a brain's live turns), `<pid>.pending.json`
 * (projects a brain took after a crash and had not opened yet), either one
 * with `.tmp` (half written) or `.claimed-<pid>` (a brain was reading it).
 */
const RECORD_NAME = /^(\d+)(?:\.pending)?\.json(?:(\.tmp)|\.claimed-(\d+))?$/;

function writePending(state: Holder): void {
  const pending = state.pending;
  if (!pending) return;
  try {
    if (pending.roots.length === 0) {
      state.pending = null;
      fs.rmSync(pending.filePath, { force: true });
      return;
    }
    const file: RecordFile = {
      version: 1,
      pid: process.pid,
      projects: pending.roots,
      ...(pending.opening ? { opening: pending.opening } : {}),
    };
    const tmpPath = `${pending.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(file));
    fs.renameSync(tmpPath, pending.filePath);
  } catch (error) {
    if (!writeFailureReported) {
      writeFailureReported = true;
      captureError(error, {
        level: "warning",
        tags: { area: "brain_restart" },
        fingerprint: ["brain_restart", "live_turns_write_failed"],
      });
    }
  }
}

/**
 * The project roots that brains on this endpoint had a turn running in when
 * they stopped unplanned. Each file is claimed by a rename, so two brains
 * never take one file; a file of a live pid (another brain on the endpoint)
 * is left alone, and a dead brain's half-written `.tmp` goes. The roots stay
 * on disk as this brain's pending file until each project opens
 * (`settleLiveTurnProjectAfterCrash`), so a crash during the opens leaves
 * them to the next brain.
 */
export function takeLiveTurnProjectsFromStoppedBrains(args: { runtimeDir: string; socketPath: string }): string[] {
  const state = holder();
  const dir = recordDir(args.runtimeDir);
  const prefix = `${brainRunEndpointKey(args.socketPath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  const claimedPaths: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = RECORD_NAME.exec(name.slice(prefix.length));
    if (!match) continue;
    // The process that may still act on the file: its reader, else its writer.
    const actor = Number(match[3] ?? match[1]);
    if (actor === process.pid || pidRuns(actor)) continue;
    if (match[2]) {
      removeQuietly(path.join(dir, name));
      continue;
    }
    const base = match[3] ? name.slice(0, name.lastIndexOf(".claimed-")) : name;
    const claimed = path.join(dir, `${base}.claimed-${process.pid}`);
    try {
      fs.renameSync(path.join(dir, name), claimed);
    } catch {
      continue;
    }
    claimedPaths.push(claimed);
    try {
      const parsed = JSON.parse(fs.readFileSync(claimed, "utf8")) as Partial<RecordFile>;
      if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
        const skipped = typeof parsed.opening === "string" ? path.resolve(parsed.opening) : null;
        for (const root of parsed.projects.slice(0, MAX_PROJECTS)) {
          if (typeof root !== "string" || !root.trim()) continue;
          const resolved = path.resolve(root);
          if (resolved !== skipped) roots.add(resolved);
        }
      }
    } catch {
      // Unreadable: nothing to open.
    }
  }
  const taken = [...roots].slice(0, MAX_PROJECTS);
  if (taken.length > 0) {
    state.pending = {
      filePath: path.join(dir, `${prefix}${process.pid}.pending.json`),
      roots: taken,
      opening: null,
    };
    writePending(state);
  }
  // Only now: until the pending file exists, the claimed files are the record.
  for (const claimed of claimedPaths) removeQuietly(claimed);
  return taken;
}

/**
 * This brain starts to open the project (`root`), or the open threw (`null`:
 * a thrown error is not a crash, so a later brain may try it again).
 */
export function noteLiveTurnProjectOpening(root: string | null): void {
  const state = holder();
  const pending = state.pending;
  if (!pending || pending.opening === root) return;
  if (root !== null && !pending.roots.includes(root)) return;
  pending.opening = root;
  writePending(state);
}

/** This brain opened the project (or it no longer exists): the next brain does not need it. */
export function settleLiveTurnProjectAfterCrash(root: string): void {
  const state = holder();
  const pending = state.pending;
  if (!pending) return;
  const next = pending.roots.filter((entry) => entry !== root);
  if (next.length === pending.roots.length) return;
  pending.roots = next;
  if (pending.opening === root) pending.opening = null;
  writePending(state);
}

/** This brain opens none of the taken projects (a restart loop, the setting off). */
export function dropLiveTurnProjectsAfterCrash(): void {
  const state = holder();
  if (!state.pending) return;
  state.pending.roots = [];
  writePending(state);
}
