import fs from "node:fs";
import path from "node:path";

import { captureError } from "../../../shared/sentry/capture";
import {
  neutralizeCliSessionsToReopen,
  recordCliSessionsToReopen,
  type CliReopenEntry,
} from "../pty/cliReopenAfterRestart";
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
 * A stop someone asked for (a signal, a shutdown request: a service
 * restart, an update, a logout, a reboot) is planned, and the brain is a
 * kept-alive service, so another start follows. Then the brain keeps the
 * record instead of deleting it (`recordPlannedBrainStop`), synchronously and
 * before any slow teardown: it writes each project's list of the chats and
 * CLIs at work (`cliReopenAfterRestart.ts`), and a final
 * `<endpoint>.<pid>.stopped.json` that names those projects and when it
 * stopped. The next brain opens them by itself, and each project continues
 * exactly those chats and CLIs once. A stop for good (`noteBrainStopIntent`:
 * "Stop and quit ADE", `ade brain stop`) deletes the record as before, and its
 * CLIs are saved to reopen only: nothing tells them to continue.
 *
 * Process-global (`globalThis`) because the chat and terminal services are
 * bundled more than once.
 */
const RECORD_DIR = "live-turns";
const MAX_PROJECTS = 50;
/** A carried list holds what a project's own list holds at most. */
const MAX_CARRIED_ENTRIES = 200;
/**
 * Written by whoever stops the brain on purpose, read by the brain as it
 * stops: `stop-intent.<endpoint>.json`, so a sibling brain on the same home
 * never takes the intent meant for another endpoint.
 */
const STOP_INTENT_PREFIX = "stop-intent.";
/** A stop intent older than this belongs to a stop that never happened. */
const STOP_INTENT_MAX_AGE_MS = 2 * 60_000;

/**
 * `opening`: in a pending file, the project the brain was opening when it
 * wrote it. `stoppedAt`: a `.stopped.json` file of a planned stop. `lists`:
 * per project, the chats and CLIs a planned stop could not save in the
 * project's own folder (read-only, full), carried here instead.
 */
type RecordFile = {
  version: 1;
  pid: number;
  projects: string[];
  opening?: string;
  stoppedAt?: string;
  lists?: Record<string, CliReopenEntry[]>;
};

/** Why the brain is stopped on purpose, said by whoever stops it (`noteBrainStopIntent`). */
export type BrainStopIntent = "stop_for_good" | "accepted_update";

type Holder = {
  filePath: string | null;
  /**
   * Per project, what its terminals would save for the next runtime
   * (`registerPlannedStopCliSource`), so a planned stop writes it first.
   */
  plannedCliSources: Map<string, () => CliReopenEntry[]>;
  /** Projects whose list a planned stop already wrote: their own teardown writes none. */
  plannedRecordedRoots: Set<string>;
  /**
   * Per project, the list a planned stop carried in its record because the
   * project's folder refused it (`RecordFile.lists`). The project's chat
   * service takes it once (`takeCarriedCliSessionsToReopen`).
   */
  carriedLists: Map<string, CliReopenEntry[]>;
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
  pending: {
    filePath: string;
    roots: string[];
    opening: string | null;
    /**
     * The crashed brains' claimed files, kept while the pending file could
     * not be written: until then they are the only record of these projects.
     */
    claimed: string[];
  } | null;
};

const HOLDER_KEY = Symbol.for("ade.liveTurnProjects");

function holder(): Holder {
  const scope = globalThis as { [HOLDER_KEY]?: Holder };
  let value = scope[HOLDER_KEY];
  if (!value) {
    value = {
      filePath: null,
      plannedCliSources: new Map(),
      plannedRecordedRoots: new Set(),
      carriedLists: new Map(),
      turns: new Map(),
      writing: false,
      dirty: false,
      pending: null,
    };
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

function stopIntentPath(runtimeDir: string, socketPath: string): string {
  return path.join(recordDir(runtimeDir), `${STOP_INTENT_PREFIX}${brainRunEndpointKey(socketPath)}.json`);
}

/**
 * Says why the brain on `socketPath` is about to stop, right before the
 * caller stops it. `pid`: the brain's pid, when the caller knows it; then
 * only that brain honors it. The brain reads it once as it stops; an intent
 * older than two minutes is ignored (that stop never came). Never throws:
 * without the file a stop counts as a restart, which keeps the work.
 */
export function noteBrainStopIntent(
  intent: BrainStopIntent,
  args: { runtimeDir: string; socketPath: string; pid?: number | null },
): void {
  try {
    const filePath = stopIntentPath(args.runtimeDir, args.socketPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const pid = typeof args.pid === "number" && Number.isInteger(args.pid) && args.pid > 0 ? args.pid : null;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, intent, at: new Date().toISOString(), ...(pid ? { pid } : {}) }));
    fs.renameSync(tmpPath, filePath);
  } catch {
    // See above.
  }
}

/** The stop the caller announced did not happen (the stop or uninstall failed). */
export function clearBrainStopIntent(args: { runtimeDir: string; socketPath: string }): void {
  removeQuietly(stopIntentPath(args.runtimeDir, args.socketPath));
}

/**
 * Read once and removed: a fresh intent applies to this stop only. One that
 * names another pid is for another brain on this endpoint, and stays.
 */
function takeBrainStopIntent(runtimeDir: string, socketPath: string, nowMs: number): BrainStopIntent | null {
  const filePath = stopIntentPath(runtimeDir, socketPath);
  let parsed: { intent?: unknown; at?: unknown; pid?: unknown } | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { intent?: unknown; at?: unknown; pid?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed?.pid === "number" && parsed.pid !== process.pid) return null;
  removeQuietly(filePath);
  const atMs = typeof parsed?.at === "string" ? Date.parse(parsed.at) : Number.NaN;
  if (!Number.isFinite(atMs) || nowMs - atMs > STOP_INTENT_MAX_AGE_MS || atMs - nowMs > STOP_INTENT_MAX_AGE_MS) return null;
  return parsed?.intent === "stop_for_good" || parsed?.intent === "accepted_update" ? parsed.intent : null;
}

/**
 * A project's terminals hand over what they would save for the next runtime
 * (`ptyService`), so a planned stop can write it before any teardown. The
 * returned function unregisters.
 */
export function registerPlannedStopCliSource(projectRoot: string, source: () => CliReopenEntry[]): () => void {
  const state = holder();
  const root = path.resolve(projectRoot);
  state.plannedCliSources.set(root, source);
  return () => {
    if (state.plannedCliSources.get(root) === source) state.plannedCliSources.delete(root);
  };
}

/** A planned stop already saved this project's open CLIs: its teardown saves nothing more. */
export function plannedStopRecordedFor(projectRoot: string): boolean {
  return holder().plannedRecordedRoots.has(path.resolve(projectRoot));
}

export type PlannedBrainStopSummary = {
  intent: BrainStopIntent | null;
  /** Projects the next brain opens by itself. */
  projects: number;
  chats: number;
  /** CLIs owed a continue (all open tracked CLIs are saved for a reopen). */
  midTurnClis: number;
  failed: number;
};

/**
 * A stop someone asked for: keep what was at work for the next brain. Run it
 * first in the stop, synchronously: the brain may be killed a few seconds
 * later, and the teardown after it ends every turn. It writes each project's
 * list of chats and CLIs at work, then the `.stopped.json` record of the
 * projects to open, and freezes the record so the teardown cannot change it.
 * A project whose folder refuses its list is opened anyway, and its list
 * rides in the record. Null when this brain keeps no record (an app-owned
 * brain, a test) and the stop is not one for good.
 *
 * A stop for good keeps no chat and continues nothing: its CLIs are saved to
 * reopen only (`midTurn: false`), and the lists of projects an earlier stop
 * left and this brain had not opened yet lose their continues too. The
 * intent is taken even when this brain keeps no record.
 *
 * Bounded: at most `MAX_PROJECTS` roots, and the lists' own 200 entries each.
 * No prompt or transcript text: session ids, roots and times only.
 */
export function recordPlannedBrainStop(args: {
  runtimeDir: string;
  socketPath: string;
  nowMs?: number;
}): PlannedBrainStopSummary | null {
  const state = holder();
  const nowMs = args.nowMs ?? Date.now();
  const intent = takeBrainStopIntent(args.runtimeDir, args.socketPath, nowMs);
  if (intent === "stop_for_good") return keepNothingForGood(state);
  const filePath = state.filePath;
  if (!filePath) return null;
  const acceptedUpdate = intent === "accepted_update";
  const summary: PlannedBrainStopSummary = { intent, projects: 0, chats: 0, midTurnClis: 0, failed: 0 };
  const roots = new Set<string>([...state.turns.keys(), ...state.plannedCliSources.keys()]);
  const toOpen = new Set<string>(state.pending?.roots ?? []);
  // The lists this brain still carried for projects it had not opened yet.
  const carried = new Map<string, CliReopenEntry[]>(state.carriedLists);
  for (const root of roots) {
    const keys = state.turns.get(root);
    const chatIds = [...(keys ?? [])].filter((key) => key.startsWith("chat:")).map((key) => key.slice("chat:".length));
    let clis: CliReopenEntry[] = [];
    let clisSaved = true;
    const source = state.plannedCliSources.get(root);
    if (source) {
      try {
        clis = source();
      } catch {
        // The chats are still saved; the project's own teardown adds its
        // CLIs to the same list (`recordCliSessionsToReopen` merges).
        summary.failed += 1;
        clisSaved = false;
      }
    }
    const entries: CliReopenEntry[] = [
      ...clis.map((entry) => (acceptedUpdate ? { ...entry, acceptedUpdate: true as const } : entry)),
      ...chatIds.map((sessionId): CliReopenEntry => ({
        sessionId,
        midTurn: true,
        kind: "chat",
        ...(acceptedUpdate ? { acceptedUpdate: true as const } : {}),
      })),
    ];
    const midTurnClis = clis.filter((entry) => entry.midTurn).length;
    summary.chats += chatIds.length;
    summary.midTurnClis += midTurnClis;
    try {
      recordCliSessionsToReopen(root, entries);
      if (source && clisSaved) state.plannedRecordedRoots.add(root);
    } catch {
      // The project's folder refused it (read-only, full): the record
      // carries the list, and the project opens so it is acted on.
      summary.failed += 1;
      if (entries.length > 0) {
        carried.set(root, [...(carried.get(root) ?? []), ...entries]);
        toOpen.add(root);
      }
      continue;
    }
    const cliTurnRunning = [...(keys ?? [])].some((key) => key.startsWith("cli:"));
    if (chatIds.length > 0 || midTurnClis > 0 || cliTurnRunning) toOpen.add(root);
  }
  const projects = [...toOpen].slice(0, MAX_PROJECTS);
  summary.projects = projects.length;
  const lists = Object.fromEntries([...carried].filter(([root]) => projects.includes(root)));
  const pending = state.pending;
  // Frozen from here: the teardown's turn ends must not touch the files.
  state.filePath = null;
  state.pending = null;
  state.turns.clear();
  state.carriedLists.clear();
  if (projects.length > 0) {
    const stoppedPath = filePath.replace(/\.json$/, ".stopped.json");
    try {
      const file: RecordFile = {
        version: 1,
        pid: process.pid,
        projects,
        stoppedAt: new Date(nowMs).toISOString(),
        ...(Object.keys(lists).length > 0 ? { lists } : {}),
      };
      fs.mkdirSync(path.dirname(stoppedPath), { recursive: true });
      const tmpPath = `${stoppedPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(file));
      fs.renameSync(tmpPath, stoppedPath);
    } catch (error) {
      summary.failed += 1;
      // The live record and any pending file stay: the next brain opens
      // their projects as after a crash, which loses less.
      if (!writeFailureReported) {
        writeFailureReported = true;
        captureError(error, {
          level: "warning",
          tags: { area: "brain_restart" },
          fingerprint: ["brain_restart", "live_turns_write_failed"],
        });
      }
      return summary;
    }
  }
  removeQuietly(filePath);
  if (pending) {
    removeQuietly(pending.filePath);
    for (const claimed of pending.claimed) removeQuietly(claimed);
  }
  return summary;
}

/**
 * A stop for good: no chat is kept, and every open CLI is saved to reopen
 * only, so its teardown saves nothing more. The projects an earlier stop left
 * and this brain had not opened yet keep their CLIs but lose their continues.
 */
function keepNothingForGood(state: Holder): PlannedBrainStopSummary {
  const summary: PlannedBrainStopSummary = { intent: "stop_for_good", projects: 0, chats: 0, midTurnClis: 0, failed: 0 };
  for (const [root, source] of state.plannedCliSources) {
    try {
      recordCliSessionsToReopen(root, source().map((entry) => ({ sessionId: entry.sessionId, midTurn: false })));
      state.plannedRecordedRoots.add(root);
    } catch {
      // The teardown writes the list as before.
      summary.failed += 1;
    }
  }
  for (const root of state.pending?.roots ?? []) {
    if (!neutralizeCliSessionsToReopen(root)) summary.failed += 1;
  }
  state.carriedLists.clear();
  closeLiveTurnProjectsRecord();
  return summary;
}

/**
 * The list a planned stop carried for this project in its record, taken
 * once by the project's chat service at start. Empty for every other project.
 */
export function takeCarriedCliSessionsToReopen(projectRoot: string): CliReopenEntry[] {
  const state = holder();
  const root = path.resolve(projectRoot);
  const entries = state.carriedLists.get(root);
  if (!entries) return [];
  state.carriedLists.delete(root);
  writePending(state);
  return entries;
}

/** An orderly stop: nothing is left for the next brain to open. Synchronous (it runs while stopping). */
export function closeLiveTurnProjectsRecord(): void {
  const state = holder();
  const filePath = state.filePath;
  const pending = state.pending;
  state.filePath = null;
  state.pending = null;
  state.turns.clear();
  state.carriedLists.clear();
  // A file left behind only opens those projects early at the next start.
  if (filePath) removeQuietly(filePath);
  if (pending) {
    removeQuietly(pending.filePath);
    for (const claimed of pending.claimed) removeQuietly(claimed);
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

/** A carried list as the record holds it; anything malformed is left out. */
function parseCarriedList(value: unknown): CliReopenEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CliReopenEntry[] = [];
  for (const item of value.slice(-MAX_CARRIED_ENTRIES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || !record.sessionId.trim() || record.sessionId.length > 256) continue;
    entries.push({
      sessionId: record.sessionId.trim(),
      midTurn: record.midTurn === true,
      ...(record.kind === "chat" ? { kind: "chat" as const } : {}),
      ...(record.acceptedUpdate === true ? { acceptedUpdate: true as const } : {}),
    });
  }
  return entries;
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
 * (projects a brain took after a crash and had not opened yet),
 * `<pid>.stopped.json` (a planned stop's final record), any of them with
 * `.tmp` (half written) or `.claimed-<pid>` (a brain was reading it).
 */
const RECORD_NAME = /^(\d+)(\.pending|\.stopped)?\.json(?:(\.tmp)|\.claimed-(\d+))?$/;

/**
 * Saves the pending file, or removes it when nothing is left. On success the
 * claimed files it replaces go; on a failure they stay as the record.
 */
function writePending(state: Holder): void {
  const pending = state.pending;
  if (!pending) return;
  try {
    if (pending.roots.length === 0) {
      state.pending = null;
      fs.rmSync(pending.filePath, { force: true });
    } else {
      const lists = Object.fromEntries([...state.carriedLists].filter(([root]) => pending.roots.includes(root)));
      const file: RecordFile = {
        version: 1,
        pid: process.pid,
        projects: pending.roots,
        ...(pending.opening ? { opening: pending.opening } : {}),
        ...(Object.keys(lists).length > 0 ? { lists } : {}),
      };
      const tmpPath = `${pending.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(file));
      fs.renameSync(tmpPath, pending.filePath);
    }
    for (const claimed of pending.claimed.splice(0)) removeQuietly(claimed);
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
 * they stopped: unplanned (their live record stayed), or planned (their
 * `.stopped.json`, if it is no older than `maxStoppedAgeMs`). Each file is
 * claimed by a rename, so two brains never take one file; a live record of a
 * live pid (another brain on the endpoint) is left alone, and a dead brain's
 * half-written `.tmp` goes. A `.stopped.json` is final when written, so it is
 * taken even while its brain is still finishing its exit. The roots stay
 * on disk as this brain's pending file until each project opens
 * (`settleLiveTurnProjectAfterCrash`), so a crash during the opens leaves
 * them to the next brain.
 */
export function takeLiveTurnProjectsFromStoppedBrains(args: {
  runtimeDir: string;
  socketPath: string;
  /** A planned stop older than this opens nothing: its work is stale. */
  maxStoppedAgeMs?: number;
  /** Each planned stop's record, read (`stale`: too old, nothing opened). */
  onStoppedRecord?: (record: { projects: number; stale: boolean }) => void;
  nowMs?: number;
}): string[] {
  const state = holder();
  const dir = recordDir(args.runtimeDir);
  const prefix = `${brainRunEndpointKey(args.socketPath)}.`;
  const nowMs = args.nowMs ?? Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const roots = new Set<string>();
  const lists = new Map<string, CliReopenEntry[]>();
  const claimedPaths: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = RECORD_NAME.exec(name.slice(prefix.length));
    if (!match) continue;
    const stopped = match[2] === ".stopped";
    // The process that may still act on the file: its reader, else its
    // writer. A planned stop's record is final, so only a reader counts.
    const actor = match[4] != null ? Number(match[4]) : stopped ? null : Number(match[1]);
    if (actor != null && (actor === process.pid || pidRuns(actor))) continue;
    if (match[3]) {
      // A half-written file: its writer is gone (or, for a planned stop,
      // finished writing another way). Only a dead writer's goes.
      if (!pidRuns(Number(match[1]))) removeQuietly(path.join(dir, name));
      continue;
    }
    const base = match[4] ? name.slice(0, name.lastIndexOf(".claimed-")) : name;
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
        if (stopped) {
          const stoppedMs = typeof parsed.stoppedAt === "string" ? Date.parse(parsed.stoppedAt) : Number.NaN;
          const stale = !Number.isFinite(stoppedMs)
            || (args.maxStoppedAgeMs != null && nowMs - stoppedMs > args.maxStoppedAgeMs);
          args.onStoppedRecord?.({ projects: parsed.projects.length, stale });
          if (stale) continue;
        }
        const skipped = typeof parsed.opening === "string" ? path.resolve(parsed.opening) : null;
        for (const root of parsed.projects.slice(0, MAX_PROJECTS)) {
          if (typeof root !== "string" || !root.trim()) continue;
          const resolved = path.resolve(root);
          if (resolved === skipped) continue;
          roots.add(resolved);
          const carried = parseCarriedList(parsed.lists?.[root]);
          if (carried.length > 0) lists.set(resolved, [...(lists.get(resolved) ?? []), ...carried]);
        }
      }
    } catch {
      // Unreadable: nothing to open.
    }
  }
  const taken = [...roots].slice(0, MAX_PROJECTS);
  if (taken.length === 0) {
    for (const claimed of claimedPaths) removeQuietly(claimed);
    return taken;
  }
  for (const root of taken) {
    const carried = lists.get(root);
    if (carried) state.carriedLists.set(root, carried.slice(-MAX_CARRIED_ENTRIES));
  }
  // The claimed files go only once the pending file is saved: until then
  // they are the record (a later write, or the next brain, takes over).
  state.pending = {
    filePath: path.join(dir, `${prefix}${process.pid}.pending.json`),
    roots: taken,
    opening: null,
    claimed: claimedPaths,
  };
  writePending(state);
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
  // Opened: its chat service took its carried list at start (or it has none).
  state.carriedLists.delete(root);
  if (pending.opening === root) pending.opening = null;
  writePending(state);
}

/** This brain opens none of the taken projects (a restart loop, the setting off). */
export function dropLiveTurnProjectsAfterCrash(): void {
  const state = holder();
  if (!state.pending) return;
  state.pending.roots = [];
  state.carriedLists.clear();
  writePending(state);
}
