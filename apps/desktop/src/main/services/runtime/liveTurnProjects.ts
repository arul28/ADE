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
 * with a rename, so two brains never both act on it.
 *
 * Process-global (`globalThis`) because the chat and terminal services are
 * bundled more than once.
 */
const RECORD_DIR = "live-turns";
const MAX_PROJECTS = 50;

type RecordFile = { version: 1; pid: number; projects: string[] };

type Holder = {
  filePath: string | null;
  turns: Map<string, Set<string>>;
  writing: boolean;
  dirty: boolean;
};

const HOLDER_KEY = Symbol.for("ade.liveTurnProjects");

function holder(): Holder {
  const scope = globalThis as { [HOLDER_KEY]?: Holder };
  let value = scope[HOLDER_KEY];
  if (!value) {
    value = { filePath: null, turns: new Map(), writing: false, dirty: false };
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
  state.filePath = null;
  state.turns.clear();
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A file left behind only opens those projects early at the next start.
  }
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
 * The project roots that brains on this endpoint had a turn running in when
 * they stopped unplanned. Each file is claimed by a rename and deleted as it
 * is read; a file of a live pid (another brain on the endpoint) is left alone.
 * A dead brain's half-written `.tmp` goes too.
 */
export function takeLiveTurnProjectsFromStoppedBrains(args: { runtimeDir: string; socketPath: string }): string[] {
  const dir = recordDir(args.runtimeDir);
  const prefix = `${brainRunEndpointKey(args.socketPath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tmp = name.endsWith(".json.tmp");
    if (!tmp && !name.endsWith(".json")) continue;
    const pid = Number(name.slice(prefix.length, tmp ? -".json.tmp".length : -".json".length));
    if (!Number.isInteger(pid) || pid === process.pid || pidRuns(pid)) continue;
    if (tmp) {
      removeQuietly(path.join(dir, name));
      continue;
    }
    const claimed = path.join(dir, `${name}.claimed-${process.pid}`);
    try {
      fs.renameSync(path.join(dir, name), claimed);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(claimed, "utf8")) as Partial<RecordFile>;
      if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
        for (const root of parsed.projects.slice(0, MAX_PROJECTS)) {
          if (typeof root === "string" && root.trim()) roots.add(path.resolve(root));
        }
      }
    } catch {
      // Unreadable: nothing to open.
    } finally {
      removeQuietly(claimed);
    }
  }
  return [...roots];
}
