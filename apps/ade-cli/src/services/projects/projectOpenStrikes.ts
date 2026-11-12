import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { codedError } from "../../../../desktop/src/shared/codedError";
import { markExpected } from "../../../../desktop/src/shared/expectedError";
import type { BrainLoopWatchdogBreadcrumb } from "../runtime/brainLoopWatchdog";

/**
 * Projects whose open froze the brain until the freeze guard killed it.
 *
 * A project on a drive too slow for its database freezes the brain's event
 * loop while it opens; the guard kills the brain, the supervisor restarts it,
 * a client asks for the same project, and it freezes again, forever, with
 * every other project on the machine down with it. Each kill that happened
 * while a project was opening is a strike against that project, kept in the
 * brain's runtime folder (this machine's own disk, never the project's
 * folder, which is the slow drive). Two strikes inside the window and the
 * project is refused at once instead of opened.
 */

export const PROJECT_OPEN_STRIKES_FILE = "project-open-strikes.json";
/** Strikes older than this do not count, so a refusal lifts on its own. */
export const PROJECT_OPEN_STRIKE_WINDOW_MS = 15 * 60_000;
/** Strikes inside the window that refuse the project. */
export const PROJECT_OPEN_STRIKE_LIMIT = 2;
export const PROJECT_FOLDER_TOO_SLOW_CODE = "project_folder_too_slow";

type StrikesFile = {
  version: 1;
  /** Epoch ms of each freeze kill counted against the project, oldest first. */
  projects: Record<string, number[]>;
};

export type ProjectOpenBlock = {
  strikes: number;
  /** Epoch ms when the refusal lifts on its own. */
  blockedUntilMs: number;
};

function readStrikesFile(filePath: string): Map<string, number[]> {
  const strikes = new Map<string, number[]>();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StrikesFile> | null;
    const projects = parsed && typeof parsed === "object" ? parsed.projects : null;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return strikes;
    for (const [projectId, times] of Object.entries(projects)) {
      if (!Array.isArray(times)) continue;
      const valid = times.filter((at): at is number => typeof at === "number" && Number.isFinite(at));
      if (valid.length > 0) strikes.set(projectId, valid.sort((a, b) => a - b));
    }
  } catch {
    // Missing, torn or not JSON: no strikes. A concurrent writer's rename
    // lands whole, so a torn read only ever costs one strike, never a block.
  }
  return strikes;
}

export class ProjectOpenStrikes {
  readonly filePath: string;
  private readonly strikes: Map<string, number[]>;
  private readonly now: () => number;
  private readonly onWriteFailed?: (error: unknown) => void;

  /** Reads the file once; every later check is in memory. */
  constructor(args: {
    runtimeDir: string;
    now?: () => number;
    onWriteFailed?: (error: unknown) => void;
  }) {
    this.filePath = path.join(args.runtimeDir, PROJECT_OPEN_STRIKES_FILE);
    this.now = args.now ?? Date.now;
    this.onWriteFailed = args.onWriteFailed;
    this.strikes = readStrikesFile(this.filePath);
  }

  private inWindow(projectId: string): number[] {
    const since = this.now() - PROJECT_OPEN_STRIKE_WINDOW_MS;
    return (this.strikes.get(projectId) ?? []).filter((at) => at > since);
  }

  /**
   * Count a freeze kill against every project that was opening when it hit.
   * Only the freeze guard writes a breadcrumb, so a stop, an update or an
   * out-of-memory kill never reaches here. Returns the projects struck.
   */
  recordFreezeKill(breadcrumb: Pick<BrainLoopWatchdogBreadcrumb, "ts" | "openingProjects">): string[] {
    const opening = [...new Set((breadcrumb.openingProjects ?? []).map((open) => open.projectId))];
    if (opening.length === 0) return [];
    const parsedAt = Date.parse(breadcrumb.ts);
    // A clock that jumped, or a garbled stamp, counts the kill as now.
    const at = Number.isFinite(parsedAt) && parsedAt <= this.now() ? parsedAt : this.now();
    for (const projectId of opening) {
      const times = this.inWindow(projectId);
      // The same breadcrumb recovered twice (two brains sharing a home) is one kill.
      if (!times.includes(at)) times.push(at);
      this.strikes.set(projectId, times.sort((a, b) => a - b));
    }
    this.persist();
    return opening;
  }

  /** The refusal holding this project, or null. The open path's only check. */
  blocked(projectId: string): ProjectOpenBlock | null {
    const times = this.strikes.get(projectId);
    if (!times || times.length < PROJECT_OPEN_STRIKE_LIMIT) return null;
    const recent = this.inWindow(projectId);
    if (recent.length < PROJECT_OPEN_STRIKE_LIMIT) return null;
    // It lifts when all but LIMIT - 1 of the strikes have aged out.
    const deciding = recent[recent.length - PROJECT_OPEN_STRIKE_LIMIT]!;
    return { strikes: recent.length, blockedUntilMs: deciding + PROJECT_OPEN_STRIKE_WINDOW_MS };
  }

  /** Projects refused right now. */
  blockedProjectIds(): string[] {
    return [...this.strikes.keys()].filter((projectId) => this.blocked(projectId) !== null);
  }

  /** Strikes inside the window, for a report. */
  strikeCount(projectId: string): number {
    return this.inWindow(projectId).length;
  }

  /**
   * Forget a project's strikes: it opened, or a person asked to try again.
   * Returns whether there was anything to forget. The write happens off the
   * caller's turn and never throws.
   */
  clear(projectId: string): boolean {
    if (!this.strikes.delete(projectId)) return false;
    setImmediate(() => this.persist());
    return true;
  }

  private persist(): void {
    const projects: Record<string, number[]> = {};
    for (const projectId of [...this.strikes.keys()]) {
      const times = this.inWindow(projectId);
      if (times.length > 0) projects[projectId] = times;
      else this.strikes.delete(projectId);
    }
    const file: StrikesFile = { version: 1, projects };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.filePath, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    } catch (error) {
      try {
        this.onWriteFailed?.(error);
      } catch {
        // Reporting a failed write must not become a failure of its own.
      }
    }
  }
}

/**
 * What a person is told when a project is refused. Plain words; the code
 * travels with it so the desktop can offer Try again.
 */
export function projectFolderTooSlowError(args: {
  displayName: string;
  networkDrive: boolean;
}): Error & { code: string } {
  const drive = args.networkDrive ? "a network drive" : "a drive";
  const minutes = Math.round(PROJECT_OPEN_STRIKE_WINDOW_MS / 60_000);
  return markExpected(
    codedError(
      `ADE can't open ${args.displayName} right now. Its folder is on ${drive} that is too slow for ADE: `
        + "ADE stopped responding twice while opening it. Your other projects are not affected. "
        + `Clone or move the project to this computer's own disk, or try again in ${minutes} minutes.`,
      PROJECT_FOLDER_TOO_SLOW_CODE,
    ),
    "environment",
  );
}
