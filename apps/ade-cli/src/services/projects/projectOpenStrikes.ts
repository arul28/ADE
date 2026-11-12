import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { codedError, PROJECT_FOLDER_TOO_SLOW_CODE } from "../../../../desktop/src/shared/codedError";
import { markExpected } from "../../../../desktop/src/shared/expectedError";
import type { BrainLoopWatchdogBreadcrumb } from "../runtime/brainLoopWatchdog";
import { projectFilesystemKind, type ProjectFilesystemKind } from "./projectFilesystemKind";

/**
 * Projects whose open froze the brain until the freeze guard killed it.
 *
 * Each such kill is a strike against the project that was opening, kept in
 * the brain's runtime folder (this machine's own disk, never the project's
 * folder). Enough strikes and the project is refused at once instead of
 * opened, for a refusal window that doubles each time the project is refused
 * again, until it opens or a person asks to try again.
 */

/** On-disk name, in the brain's runtime folder. Documented in the storage feature doc. */
export const PROJECT_OPEN_STRIKES_FILE = "project-open-strikes.json";
/** Strikes inside this window count toward a refusal. */
const STRIKE_WINDOW_MS = 15 * 60_000;
/** Strikes inside the window that refuse the project. */
const STRIKE_LIMIT = 2;
/** The first refusal's length; each later one doubles it, up to the cap. */
const FIRST_REFUSAL_MS = 15 * 60_000;
const MAX_REFUSAL_MS = 24 * 60 * 60_000;
/** A stamp this far past now is a clock that moved back, not a real kill. */
const FUTURE_SLACK_MS = 60_000;
/**
 * Steps of an open that do synchronous database work on the main thread.
 * When several projects were opening at a kill, only these can have frozen it.
 */
const SYNC_DATABASE_PHASES: ReadonlySet<string> = new Set(["db_open", "services"]);

type ProjectEntry = {
  /** Epoch ms of each freeze kill not yet consumed by a refusal, oldest first. */
  strikes: number[];
  /** 0 for the first refusal, +1 for each refusal since; absent before any. */
  level?: number;
  /** Epoch ms when the current refusal lifts. */
  blockedUntil?: number;
};

type StrikesFile = { version: 2; projects: Record<string, ProjectEntry> };

type StrikesLogger = {
  warn: (event: string, meta?: Record<string, unknown>) => void;
  info?: (event: string, meta?: Record<string, unknown>) => void;
};

export type ProjectOpenBlock = {
  /** Epoch ms when the refusal lifts on its own. */
  blockedUntilMs: number;
  /** 0 for the first refusal (15 minutes), each later one twice as long. */
  level: number;
};

export type StruckProject = {
  projectId: string;
  phase: string;
  strikes: number;
  blocked: ProjectOpenBlock | null;
};

type RefusalRecord = { displayName: string; rootPath: string };

function refusalLengthMs(level: number): number {
  return Math.min(MAX_REFUSAL_MS, FIRST_REFUSAL_MS * 2 ** Math.max(0, level));
}

function finiteNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((at): at is number => typeof at === "number" && Number.isFinite(at)).sort((a, b) => a - b)
    : [];
}

function readEntry(value: unknown): ProjectEntry | null {
  // Version 1 kept only the strike list.
  if (Array.isArray(value)) return { strikes: finiteNumbers(value) };
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const entry: ProjectEntry = { strikes: finiteNumbers(record.strikes) };
  if (typeof record.level === "number" && Number.isInteger(record.level) && record.level >= 0) {
    entry.level = record.level;
  }
  if (typeof record.blockedUntil === "number" && Number.isFinite(record.blockedUntil)) {
    entry.blockedUntil = record.blockedUntil;
  }
  return entry;
}

/** "15 minutes", "1 hour", "24 hours": the wait, rounded up. */
function describeRefusalWait(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * What a person is told when a project is refused: its name and the real
 * wait. The code travels with it so the desktop can offer Try again.
 */
function projectFolderTooSlowError(args: {
  displayName: string;
  networkDrive: boolean;
  waitMs: number;
}): Error & { code: string } {
  const drive = args.networkDrive ? "a network drive" : "a drive";
  return markExpected(
    codedError(
      `ADE can't open ${args.displayName} right now. Its folder is on ${drive} that is too slow for ADE: `
        + "ADE stopped responding more than once while opening it. Your other projects are not affected. "
        + `Clone or move the project to this computer's own disk, or try again in ${describeRefusalWait(args.waitMs)}.`,
      PROJECT_FOLDER_TOO_SLOW_CODE,
    ),
    "environment",
  );
}

export class ProjectOpenStrikes {
  private readonly filePath: string;
  private readonly entries: Map<string, ProjectEntry>;
  private readonly logger: StrikesLogger | null;
  /** File-system kinds looked up for a refusal's wording, settled or not. */
  private readonly filesystemKinds = new Map<string, ProjectFilesystemKind | "pending">();
  /** `projectId` + refusal end already logged, so a room of pollers logs one line. */
  private readonly loggedRefusals = new Set<string>();

  /** Reads the file once; every later check is in memory. */
  constructor(args: { runtimeDir: string; logger?: StrikesLogger | null }) {
    this.filePath = path.join(args.runtimeDir, PROJECT_OPEN_STRIKES_FILE);
    this.logger = args.logger ?? null;
    const { entries, clamped } = this.read();
    this.entries = entries;
    if (clamped) this.persist();
  }

  private read(): { entries: Map<string, ProjectEntry>; clamped: boolean } {
    const entries = new Map<string, ProjectEntry>();
    let clamped = false;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.reportReadFailure(error);
      return { entries, clamped };
    }
    try {
      const parsed = JSON.parse(text) as { projects?: unknown } | null;
      const projects = parsed && typeof parsed === "object" ? parsed.projects : null;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
        this.reportReadFailure(new Error("strikes file has no projects map"));
        return { entries, clamped };
      }
      const now = Date.now();
      for (const [projectId, value] of Object.entries(projects)) {
        const entry = readEntry(value);
        if (!entry) continue;
        // A refusal stamped by a clock that later moved back lasts no longer
        // than its own length from now.
        const longest = now + refusalLengthMs(entry.level ?? 0);
        if (entry.blockedUntil !== undefined && entry.blockedUntil > longest) {
          entry.blockedUntil = longest;
          clamped = true;
        }
        entries.set(projectId, entry);
      }
    } catch (error) {
      // A torn or garbled file reads as no strikes: a refusal can be lost,
      // never invented.
      this.reportReadFailure(error);
    }
    return { entries, clamped };
  }

  private reportReadFailure(error: unknown): void {
    try {
      this.logger?.warn("project.open_strikes_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Reporting must not become a failure of its own.
    }
  }

  /** Strikes inside the window, dropping any stamped in the future. */
  private recentStrikes(entry: ProjectEntry | undefined, now: number): number[] {
    if (!entry) return [];
    return entry.strikes.filter((at) => at > now - STRIKE_WINDOW_MS && at <= now + FUTURE_SLACK_MS);
  }

  /**
   * Count a freeze kill against the project that froze it. Only the freeze
   * guard writes a breadcrumb, so a stop, an update or an out-of-memory kill
   * never reaches here. An open whose step has not moved for far longer than
   * the freeze was waiting, not freezing. With several projects opening, only
   * those doing synchronous database work are struck.
   */
  recordFreezeKill(
    breadcrumb: Pick<BrainLoopWatchdogBreadcrumb, "ts" | "openingProjects" | "blockedMs" | "thresholdMs">,
  ): StruckProject[] {
    const now = Date.now();
    const staleAfterMs = breadcrumb.blockedMs + 2 * (breadcrumb.thresholdMs ?? breadcrumb.blockedMs);
    // A breadcrumb from before steps were timed cannot tell a stuck step, so
    // its entries are all kept.
    let opening = (breadcrumb.openingProjects ?? [])
      .filter((open) => open.phaseElapsedMs === undefined || open.phaseElapsedMs <= staleAfterMs);
    if (opening.length > 1) opening = opening.filter((open) => SYNC_DATABASE_PHASES.has(open.phase));
    if (opening.length === 0) return [];
    const parsedAt = Date.parse(breadcrumb.ts);
    // A clock that jumped, or a garbled stamp, counts the kill as now.
    const at = Number.isFinite(parsedAt) && parsedAt <= now ? parsedAt : now;
    const struck: StruckProject[] = [];
    const seen = new Set<string>();
    for (const open of opening) {
      if (seen.has(open.projectId)) continue;
      seen.add(open.projectId);
      const entry = this.entries.get(open.projectId) ?? { strikes: [] };
      const strikes = this.recentStrikes(entry, now);
      // The same breadcrumb recovered twice (two brains sharing a home) is one kill.
      if (!strikes.includes(at)) strikes.push(at);
      entry.strikes = strikes.sort((a, b) => a - b);
      const strikeCount = entry.strikes.length;
      if (!this.blocked(open.projectId) && strikeCount >= STRIKE_LIMIT) {
        // Refused again after an earlier refusal lifted: twice as long.
        entry.level = entry.level === undefined ? 0 : entry.level + 1;
        entry.blockedUntil = at + refusalLengthMs(entry.level);
        entry.strikes = [];
      }
      this.entries.set(open.projectId, entry);
      struck.push({
        projectId: open.projectId,
        phase: open.phase,
        strikes: strikeCount,
        blocked: this.blocked(open.projectId),
      });
    }
    this.persist();
    return struck;
  }

  /** The refusal holding this project, or null. The open path's only check. */
  blocked(projectId: string): ProjectOpenBlock | null {
    const entry = this.entries.get(projectId);
    if (entry?.blockedUntil === undefined) return null;
    const now = Date.now();
    return entry.blockedUntil > now ? { blockedUntilMs: entry.blockedUntil, level: entry.level ?? 0 } : null;
  }

  /**
   * Whether this project's next open runs alone: it has a recent strike, or
   * is refused (which only a retry, then an open, gets past).
   */
  opensAlone(projectId: string): boolean {
    const entry = this.entries.get(projectId);
    return Boolean(entry && (this.recentStrikes(entry, Date.now()).length > 0 || this.blocked(projectId)));
  }

  /**
   * The error a refused project's open throws, or null when it may open.
   * `lookup` is only called for a refused project. Logs `project.open_blocked`
   * once per refusal, with the id only; the name is for the person reading
   * the error.
   */
  refusal(projectId: string, lookup: () => RefusalRecord | null): Error | null {
    const block = this.blocked(projectId);
    if (!block) return null;
    const record = lookup();
    if (record) this.lookupFilesystemKind(projectId, record.rootPath);
    const kind = this.filesystemKinds.get(projectId);
    const filesystem = kind && kind !== "pending" ? kind : null;
    const logKey = `${projectId}\u0000${block.blockedUntilMs}`;
    if (!this.loggedRefusals.has(logKey)) {
      this.loggedRefusals.add(logKey);
      try {
        this.logger?.warn("project.open_blocked", {
          projectId,
          code: PROJECT_FOLDER_TOO_SLOW_CODE,
          level: block.level,
          blockedUntil: new Date(block.blockedUntilMs).toISOString(),
          filesystemKind: filesystem?.kind ?? "unknown",
          filesystemType: filesystem?.fsType ?? null,
        });
      } catch {
        // Logging must never change the answer.
      }
    }
    return projectFolderTooSlowError({
      displayName: record?.displayName?.trim() || "this project",
      networkDrive: filesystem?.kind === "network",
      waitMs: block.blockedUntilMs - Date.now(),
    });
  }

  /**
   * Start the file-system lookups for projects refused now, so the first
   * refusal can already say "network drive". Asynchronous; never awaited.
   */
  prewarm(lookup: (projectId: string) => RefusalRecord | null): void {
    for (const projectId of this.entries.keys()) {
      if (!this.blocked(projectId)) continue;
      const record = lookup(projectId);
      if (record) this.lookupFilesystemKind(projectId, record.rootPath);
    }
  }

  private lookupFilesystemKind(projectId: string, rootPath: string): void {
    if (this.filesystemKinds.has(projectId)) return;
    this.filesystemKinds.set(projectId, "pending");
    void projectFilesystemKind(rootPath).then((kind) => {
      this.filesystemKinds.set(projectId, kind);
    });
  }

  /**
   * Forget everything about a project: it opened (`opened`), or a person
   * asked to try again (`retry`). The next refusal starts at 15 minutes.
   * Returns whether it was refused. Writes only when there was something to
   * forget, so a healthy open writes nothing.
   */
  clear(projectId: string, reason: "opened" | "retry"): { wasBlocked: boolean; cleared: boolean } {
    const wasBlocked = this.blocked(projectId) !== null;
    if (!this.entries.delete(projectId)) return { wasBlocked, cleared: false };
    this.persist();
    try {
      this.logger?.info?.(reason === "retry" ? "project.open_retry" : "project.open_strikes_cleared", {
        projectId,
        wasBlocked,
      });
    } catch {
      // As above.
    }
    return { wasBlocked, cleared: true };
  }

  private persist(): void {
    const now = Date.now();
    const projects: Record<string, ProjectEntry> = {};
    for (const [projectId, entry] of [...this.entries]) {
      const strikes = this.recentStrikes(entry, now);
      // A project refused before keeps its level until it opens or is retried,
      // so the next refusal is longer. A refusal that lifted more than a day
      // ago with no strike since is forgotten: the project has not frozen ADE
      // for that long, so its next refusal starts at 15 minutes again.
      const longAgo = entry.blockedUntil !== undefined && entry.blockedUntil < now - MAX_REFUSAL_MS;
      if (strikes.length === 0 && (entry.level === undefined || longAgo)) {
        this.entries.delete(projectId);
        continue;
      }
      projects[projectId] = {
        strikes,
        ...(entry.level !== undefined ? { level: entry.level } : {}),
        ...(entry.blockedUntil !== undefined ? { blockedUntil: entry.blockedUntil } : {}),
      };
    }
    const file: StrikesFile = { version: 2, projects };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.filePath, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    } catch (error) {
      try {
        this.logger?.warn("project.open_strikes_write_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // As above.
      }
    }
  }
}
