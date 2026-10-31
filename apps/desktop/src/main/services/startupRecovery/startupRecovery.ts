import { LEGACY_DB_COMPAT_LEVEL } from "../../../shared/releaseCompat";
import {
  toAdeRecoveryErrorCode,
  type AdeLastFailureReport,
  type AdeRecoveryErrorCode,
} from "../../../shared/types/recovery";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import type {
  DatabaseCopyInfo,
  StartupRecoveryAction,
  StartupRecoveryPhase,
  StartupRecoveryWindowState,
} from "../../../shared/types/startupRecovery";
import { parseReleaseManifest } from "../../../shared/updateTrack";
import type { Logger } from "../logging/logger";
import type { LocalDatabase } from "./databaseCopies";
import { chooseGoBackPlan, type GoBackPlan } from "./goBackPlan";

/**
 * The "ADE could not start" window: what makes it appear, and "Go back to the
 * previous version" (docs/plans/beta-track.md).
 *
 * It appears once per launch, for one of these, and only after ADE saw it
 * fail through a signal it already had:
 *
 * - `database`: a project open fails, before any project opened on this
 *   launch, because its database did not open (an integrity or migration
 *   code, or the brain's own `project_db_open` failure record written during
 *   this launch). Only after an update.
 * - `brain`: a project open fails with `brain_crash_looping`, or the
 *   post-update transaction fails at its service, restart or health step and
 *   the brain recorded a startup failure during this launch. Only after an
 *   update.
 * - `window_crashed` / `window_load_failed`: the main window's renderer
 *   crashed until its recovery budget ran out, or never loaded. Any launch:
 *   the window would otherwise stay blank.
 *
 * "After an update" means the update record names the running version, or a
 * database copy names a move into it. Without one, the project recovery
 * screen already offers the right fixes, and nothing here shows. A database
 * the running version already opened cleanly (its compat record says so)
 * failed later, not because of the update, so it does not count either. The
 * same clean open is what starts the one day after which that database's copy
 * is deleted (`clearProvenDatabaseCopies`), so the window never offers a copy
 * that cleanup could take.
 *
 * Problems the person can fix (disk full, an unreadable cloud folder, data
 * that was moved, macOS blocking the service) never show it: going back
 * would not help, and the recovery screen says what to do.
 */

/** Recovery codes that mean the data or the brain broke, not something the person can fix. */
const DATABASE_CODES: ReadonlySet<AdeRecoveryErrorCode> = new Set([
  "db_integrity",
  "migration_incomplete",
  "migration_unknown_state",
]);
const FAILURE_RECORD_CODES: ReadonlySet<AdeRecoveryErrorCode> = new Set([
  ...DATABASE_CODES,
  "brain_crash_looping",
  "unknown",
]);
/** Post-update transaction steps that mean the new brain did not come up. */
const BRAIN_TRANSACTION_STEPS: ReadonlySet<string> = new Set(["service", "restart", "health"]);

export type StartupRecoveryTrigger =
  | { kind: "database"; label: string; projectRoot: string; code: string; detail: string | null }
  | { kind: "brain"; code: string; detail: string | null; failedStep: string | null }
  | { kind: "window_crashed"; detail: string | null }
  | { kind: "window_load_failed"; detail: string | null };

export type StartupRecoveryUpdates = {
  startGoBack(version: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  getSnapshot(): AutoUpdateSnapshot;
  onStateChange(cb: (snapshot: AutoUpdateSnapshot) => void): () => void;
  quitAndInstall(resumeChats: boolean): Promise<boolean>;
};

export type StartupRecoveryWindow = {
  show(state: StartupRecoveryWindowState): void;
  update(state: StartupRecoveryWindowState): void;
};

/** What the restore reports when it stops (`DatabaseRestoreError`). */
type RestoreFailure = { rolledBack: boolean; copyMissing: boolean };

export type StartupRecoveryDeps = {
  logger: Logger;
  runningVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** When this launch began; a failure record older than this is not this launch's. */
  launchStartedAt: number;
  /**
   * Whether this build can install another release: a packaged build with an
   * update feed. A dev build still offers "Go back" and says on click why it
   * cannot; a channel build (Alpha) has no releases to go back to.
   */
  install: "supported" | "dev_build" | "unsupported";
  readUpdateRecord: () => { version: string; fromVersion: string | null } | null;
  readMachineFailure: () => AdeLastFailureReport | null;
  readProjectFailure: (projectRoot: string) => AdeLastFailureReport | null;
  /**
   * The code for a raw SQLite error with none of its own: the desktop's own
   * open of a project database throws SQLite's words, not a recovery code.
   */
  classifyDatabaseError: (error: unknown, projectRoot: string) => string | null;
  /**
   * Whether the running version already opened this database cleanly once
   * (its compat record says so). Then a failure now is not the update's, and
   * going back would throw away what was done since. `null` asks about the
   * machine database.
   */
  openedOnRunningVersion: (projectRoot: string | null) => boolean;
  /** The database of a project, as `listDatabases` names it (same path, same case). */
  findProjectDatabase: (projectRoot: string, databases: readonly LocalDatabase[]) => LocalDatabase | null;
  listDatabases: () => LocalDatabase[];
  listCopies: (database: LocalDatabase) => DatabaseCopyInfo[];
  /** The target's `release-manifest.json`: parsed JSON, null for a 404; throws when GitHub cannot be reached. */
  fetchReleaseManifest: (version: string) => Promise<unknown | null>;
  dbCompatLevelOf: (dbPath: string) => number | "unreadable";
  updates: StartupRecoveryUpdates;
  /** Stops everything that holds a database open: the owned brain child and this app's project contexts. */
  releaseDatabases: () => Promise<void>;
  /** Throws `DatabaseRestoreError` (a `RestoreFailure`) when it stops. */
  restoreCopies: (plan: GoBackPlan) => Array<{ dbPath: string; keptAs: string | null }>;
  /**
   * Saves the version gone back from, so ordinary checks skip it, and turns
   * automatic install off until a newer build lands (older builds read only
   * that switch).
   */
  recordWentBack: (args: { fromVersion: string; toVersion: string }) => void;
  window: StartupRecoveryWindow;
  relaunch: () => Promise<boolean>;
  openLogsFolder: () => Promise<string>;
  logsFolder: string;
  copyText: (text: string) => void;
  now?: () => number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): AdeRecoveryErrorCode | null {
  return toAdeRecoveryErrorCode((error as { code?: unknown } | null)?.code);
}

function restoreFailureOf(error: unknown): RestoreFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<RestoreFailure>;
  return typeof candidate.rolledBack === "boolean"
    ? { rolledBack: candidate.rolledBack, copyMissing: candidate.copyMissing === true }
    : null;
}

/** One plain sentence: what happened. */
export function startupRecoveryLine(trigger: StartupRecoveryTrigger, runningVersion: string): string {
  switch (trigger.kind) {
    case "database":
      return `After updating to ${runningVersion}, ADE couldn't open the data for “${trigger.label}”.`;
    case "brain":
      return `After updating to ${runningVersion}, ADE's background service keeps stopping.`;
    case "window_crashed":
      return "ADE's window keeps crashing, so it can't show your work.";
    case "window_load_failed":
      return "ADE's window didn't load, so it can't show your work.";
  }
}

/** What a restored database is, in the person's words. */
function putsBackText(entry: GoBackPlan["restores"][number]): string {
  if (entry.kind === "machine") return "ADE's own data on this computer";
  if (entry.kind === "personal") return "your chats that aren't in a project";
  return `the project “${entry.label}”`;
}

const AGAIN = "Press Go back to try again.";
const SUPPORT = "Copy the details and send them to ADE support.";

export function createStartupRecovery(deps: StartupRecoveryDeps) {
  const { logger, runningVersion } = deps;
  const now = deps.now ?? Date.now;
  let projectOpened = false;
  let trigger: StartupRecoveryTrigger | null = null;
  let plan: GoBackPlan | null = null;
  let phase: StartupRecoveryPhase = { state: "idle" };
  /** Set once the go-back download started; the install hook acts only for it. */
  let armed: GoBackPlan | null = null;
  let stopWatchingUpdates: (() => void) | null = null;
  let installRequested = false;

  const isFresh = (report: AdeLastFailureReport | null): report is AdeLastFailureReport => {
    if (!report) return false;
    const at = Date.parse(report.at);
    return Number.isFinite(at) && at >= deps.launchStartedAt;
  };

  const readPlan = (): GoBackPlan | null => {
    if (deps.install === "unsupported") return null;
    try {
      const listed = deps.listDatabases();
      const failed = trigger?.kind === "database" ? deps.findProjectDatabase(trigger.projectRoot, listed) : null;
      const databases = listed.map((database) => ({
        kind: database.kind,
        label: database.label,
        dbPath: database.dbPath,
        copies: deps.listCopies(database),
      }));
      return chooseGoBackPlan({
        runningVersion,
        updateRecord: deps.readUpdateRecord(),
        databases,
        failedDbPath: failed?.dbPath ?? null,
      });
    } catch (error) {
      logger.warn("startupRecovery.plan_failed", { error: errorText(error) });
      return null;
    }
  };

  const windowState = (): StartupRecoveryWindowState => ({
    line: trigger ? startupRecoveryLine(trigger, runningVersion) : "",
    runningVersion,
    goBack: plan
      ? {
          version: plan.targetVersion,
          dataFrom: plan.dataFrom,
          putsBack: plan.restores.map(putsBackText),
          projectsLeftAlone: plan.untouched.filter((entry) => entry.kind === "project").length,
        }
      : null,
    phase,
  });

  const currentPhase = (): StartupRecoveryPhase => phase;

  const setPhase = (next: StartupRecoveryPhase): void => {
    phase = next;
    deps.window.update(windowState());
  };

  /** Shows the window for `next`, unless one already showed this launch. */
  const show = (next: StartupRecoveryTrigger, { needsUpdate }: { needsUpdate: boolean }): void => {
    if (trigger) return;
    trigger = next;
    const nextPlan = readPlan();
    if (needsUpdate) {
      const record = deps.readUpdateRecord();
      const afterUpdate = nextPlan != null || (record != null && record.version === runningVersion);
      if (!afterUpdate) {
        trigger = null;
        logger.info("startupRecovery.not_shown", { kind: next.kind, reason: "no_update" });
        return;
      }
    }
    plan = nextPlan;
    logger.info("startupRecovery.shown", {
      kind: next.kind,
      code: "code" in next ? next.code : null,
      runningVersion,
      goBackVersion: plan?.targetVersion ?? null,
      restores: plan?.restores.map((entry) => entry.copy.fileName) ?? [],
    });
    deps.window.show(windowState());
  };

  const failGoBack = (message: string, next: string, meta: Record<string, unknown> = {}): void => {
    logger.warn("startupRecovery.go_back_failed", {
      message,
      toVersion: armed?.targetVersion ?? plan?.targetVersion ?? null,
      ...meta,
    });
    stopWatchingUpdates?.();
    stopWatchingUpdates = null;
    armed = null;
    installRequested = false;
    setPhase({ state: "failed", message, next });
  };

  /**
   * Can the target build open every database it will find? The restored ones
   * are the files it left, so yes. The others (projects it leaves alone, or
   * one first opened on the running version) must be at or below its
   * `dbCompat` (T3 #4374).
   */
  const checkTarget = async (target: GoBackPlan): Promise<{ message: string; next: string } | null> => {
    let raw: unknown | null;
    try {
      raw = await deps.fetchReleaseManifest(target.targetVersion);
    } catch (error) {
      logger.warn("startupRecovery.go_back_manifest_failed", { version: target.targetVersion, error: errorText(error) });
      return {
        message: `ADE couldn't reach GitHub to get ${target.targetVersion}.`,
        next: `Check your internet connection. ${AGAIN}`,
      };
    }
    let targetLevel = LEGACY_DB_COMPAT_LEVEL;
    if (raw !== null) {
      const manifest = parseReleaseManifest(raw);
      if (!manifest || manifest.version !== target.targetVersion || manifest.dbCompat == null) {
        return { message: `ADE couldn't read the details of ${target.targetVersion}, so it didn't go back.`, next: SUPPORT };
      }
      targetLevel = manifest.dbCompat;
    }
    for (const database of target.untouched) {
      const level = deps.dbCompatLevelOf(database.dbPath);
      if (level === "unreadable" || level > targetLevel) {
        logger.warn("startupRecovery.go_back_blocked", { dbPath: database.dbPath, level, targetLevel });
        return {
          message: `${target.targetVersion} can't open “${database.label}” after ${runningVersion} changed it, so ADE didn't go back.`,
          next: `Press Try again. If ADE still can't start, ${SUPPORT.charAt(0).toLowerCase()}${SUPPORT.slice(1)}`,
        };
      }
    }
    return null;
  };

  const startInstall = (version: string): void => {
    if (installRequested) return;
    installRequested = true;
    logger.info("startupRecovery.go_back_download_ready", { toVersion: version });
    setPhase({ state: "installing" });
    void deps.updates.quitAndInstall(false).then(
      (started) => {
        // A restore that stopped the install has already said what happened.
        if (started || currentPhase().state === "failed") return;
        failGoBack(`ADE couldn't install ${version}.`, `${AGAIN} If it fails twice, ${SUPPORT.charAt(0).toLowerCase()}${SUPPORT.slice(1)}`);
      },
      (error) => {
        if (currentPhase().state === "failed") return;
        failGoBack(`ADE couldn't install ${version}.`, AGAIN, { error: errorText(error) });
      },
    );
  };

  const watchUpdates = (version: string): void => {
    stopWatchingUpdates?.();
    stopWatchingUpdates = deps.updates.onStateChange((snapshot) => {
      if (!armed) return;
      const state = currentPhase().state;
      if (snapshot.status === "downloading") {
        if (state !== "checking" && state !== "downloading") return;
        const percent = typeof snapshot.progressPercent === "number" ? Math.round(snapshot.progressPercent) : null;
        const current = currentPhase();
        if (current.state !== "downloading" || current.percent !== percent) setPhase({ state: "downloading", percent });
        return;
      }
      if (snapshot.status === "error" && (state === "checking" || state === "downloading")) {
        failGoBack(`ADE couldn't download ${version}.`, `Check your internet connection. ${AGAIN}`, {
          error: snapshot.error ?? null,
        });
        return;
      }
      if (snapshot.status === "ready" && snapshot.version === version) startInstall(version);
    });
  };

  /** "Go back" pressed: show what will happen. Nothing changes yet. */
  const askGoBack = (): void => {
    const state = currentPhase().state;
    if (state === "checking" || state === "downloading" || state === "installing") return;
    // Read again: a copy can have changed since the window opened.
    plan = readPlan();
    if (!plan) {
      failGoBack(
        "ADE no longer has a copy of your data from before the update, so it can't go back.",
        `Press Try again. If ADE still can't start, ${SUPPORT.charAt(0).toLowerCase()}${SUPPORT.slice(1)}`,
      );
      return;
    }
    setPhase({ state: "confirm" });
  };

  const goBack = async (): Promise<void> => {
    if (currentPhase().state !== "confirm") return;
    const current = readPlan();
    const agreed = plan;
    plan = current;
    // What the person agreed to must be what happens.
    const sameRestores = (left: GoBackPlan | null, right: GoBackPlan | null) =>
      left != null && right != null && left.targetVersion === right.targetVersion
      && left.restores.map((entry) => entry.copy.path).join("\n") === right.restores.map((entry) => entry.copy.path).join("\n");
    if (!current || !sameRestores(agreed, current)) {
      failGoBack("What ADE can put back changed a moment ago.", "Press Go back to see it again.");
      return;
    }
    logger.info("startupRecovery.go_back_started", {
      fromVersion: runningVersion,
      toVersion: current.targetVersion,
      restores: current.restores.map((entry) => entry.copy.path),
      untouched: current.untouched.length,
    });
    if (deps.install === "dev_build") {
      failGoBack("Going back only works in an installed copy of ADE.", "This is a development build.");
      return;
    }
    setPhase({ state: "checking" });
    const blocked = await checkTarget(current);
    if (blocked) {
      failGoBack(blocked.message, blocked.next, { reason: "target_check" });
      return;
    }
    armed = current;
    installRequested = false;
    watchUpdates(current.targetVersion);
    const started = await deps.updates.startGoBack(current.targetVersion);
    if (!started.ok) {
      failGoBack(started.reason, "Wait a moment, then press Go back again.", { reason: "updater_refused" });
      return;
    }
    if (currentPhase().state === "checking") setPhase({ state: "downloading", percent: null });
    // Already downloaded (a second try after a failed install): the listener
    // only hears changes, so start the install here.
    const snapshot = deps.updates.getSnapshot();
    if (snapshot.status === "ready" && snapshot.version === current.targetVersion) startInstall(current.targetVersion);
  };

  const details = (): string => {
    const lines = [
      "ADE could not start",
      trigger ? startupRecoveryLine(trigger, runningVersion) : "",
      "",
      `Version: ${runningVersion}`,
      `Platform: ${deps.platform} ${deps.arch}`,
      `Time: ${new Date(now()).toISOString()}`,
      `What failed: ${trigger?.kind ?? "unknown"}${trigger && "code" in trigger ? ` (${trigger.code})` : ""}`,
    ];
    if (trigger?.kind === "brain" && trigger.failedStep) lines.push(`Update step: ${trigger.failedStep}`);
    if (trigger?.detail) lines.push(`Detail: ${trigger.detail}`);
    const machineFailure = deps.readMachineFailure();
    if (machineFailure) {
      lines.push(
        `Last brain failure: ${machineFailure.code} in ${machineFailure.component}, ${machineFailure.count} time(s), last at ${machineFailure.at}`,
        `  ${machineFailure.message}`,
      );
      if (machineFailure.detail) lines.push(`  ${machineFailure.detail.split("\n").slice(0, 6).join("\n  ")}`);
    }
    const record = deps.readUpdateRecord();
    lines.push(`Updated from: ${record && record.version === runningVersion ? record.fromVersion ?? "unknown" : "no update record"}`);
    if (plan) {
      lines.push(`Go back to: ${plan.targetVersion}`);
      for (const entry of plan.restores) lines.push(`  Puts back: ${entry.copy.path} (${new Date(entry.copy.takenAt).toISOString()})`);
      for (const entry of plan.untouched) lines.push(`  Leaves as is: ${entry.dbPath}`);
    } else {
      lines.push("Go back: no matching database copy");
    }
    const latest = currentPhase();
    if (latest.state === "failed") lines.push(`Last attempt: ${latest.message} ${latest.next}`);
    lines.push(`Logs: ${deps.logsFolder}`);
    return lines.filter((line, index) => line !== "" || index === 2).join("\n");
  };

  return {
    /** A project opened: ADE started, so later failures are that project's own. */
    noteProjectOpened(): void {
      projectOpened = true;
    },

    noteProjectOpenFailure(args: { projectRoot: string; label: string; error: unknown }): void {
      if (projectOpened || trigger) return;
      const code = errorCodeOf(args.error)
        ?? toAdeRecoveryErrorCode(deps.classifyDatabaseError(args.error, args.projectRoot));
      const detail = errorText(args.error);
      if (code === "brain_crash_looping") {
        if (deps.openedOnRunningVersion(null)) return;
        show({ kind: "brain", code, detail, failedStep: null }, { needsUpdate: true });
        return;
      }
      if (deps.openedOnRunningVersion(args.projectRoot)) return;
      if (code && DATABASE_CODES.has(code)) {
        show({ kind: "database", label: args.label, projectRoot: args.projectRoot, code, detail }, { needsUpdate: true });
        return;
      }
      // The brain classified nothing it could name, but it wrote down that
      // the database open failed (`bootstrap.ts`).
      const record = deps.readProjectFailure(args.projectRoot);
      if (isFresh(record) && record.component === "project_db_open" && FAILURE_RECORD_CODES.has(record.code)) {
        show(
          {
            kind: "database",
            label: args.label,
            projectRoot: args.projectRoot,
            code: record.code,
            detail: record.detail ?? record.message,
          },
          { needsUpdate: true },
        );
      }
    },

    noteUpdateTransactionFailed(failedStep: string | null): void {
      if (projectOpened || trigger || !failedStep || !BRAIN_TRANSACTION_STEPS.has(failedStep)) return;
      const record = deps.readMachineFailure();
      if (!isFresh(record)) return;
      if (record.component !== "brain_startup" && record.component !== "project_db_open") return;
      if (!FAILURE_RECORD_CODES.has(record.code)) return;
      show(
        { kind: "brain", code: record.code, detail: record.detail ?? record.message, failedStep },
        { needsUpdate: true },
      );
    },

    noteWindowFailed(kind: "window_crashed" | "window_load_failed", detail: string | null): void {
      show({ kind, detail }, { needsUpdate: false });
    },

    async handleAction(action: StartupRecoveryAction): Promise<void> {
      logger.info("startupRecovery.action", { action, phase: currentPhase().state });
      switch (action) {
        case "try_again": {
          const relaunching = await deps.relaunch();
          logger.info("startupRecovery.try_again", { relaunching });
          return;
        }
        case "go_back":
          askGoBack();
          return;
        case "confirm_go_back":
          await goBack();
          return;
        case "cancel_go_back":
          if (currentPhase().state === "confirm") setPhase({ state: "idle" });
          return;
        case "open_logs": {
          const error = await deps.openLogsFolder();
          if (error) logger.warn("startupRecovery.open_logs_failed", { folder: deps.logsFolder, error });
          return;
        }
        case "copy_details":
          deps.copyText(details());
          return;
      }
    },

    state: windowState,

    /**
     * From `beforeQuitAndInstall`, after the background service was stopped.
     * Acts only for the install a go-back started; any other install passes.
     * Throws to stop the install, which keeps ADE open and puts the service
     * back (`rollbackQuitAndInstall`).
     */
    async beforeInstall(): Promise<void> {
      const target = armed;
      if (!target) return;
      const installing = deps.updates.getSnapshot().version;
      if (installing !== target.targetVersion) return;
      try {
        await deps.releaseDatabases();
        const restored = deps.restoreCopies(target);
        try {
          deps.recordWentBack({ fromVersion: runningVersion, toVersion: target.targetVersion });
        } catch (error) {
          // Only costs the skip: the older build may offer this one again.
          logger.warn("startupRecovery.went_back_record_failed", { error: errorText(error) });
        }
        // The beta gate reads this: a machine left this build because it
        // could not start (RELEASE_HEALTH_EVENTS in logBridge.ts).
        logger.info("startupRecovery.went_back", {
          fromVersion: runningVersion,
          toVersion: target.targetVersion,
          trigger: trigger?.kind ?? null,
          code: trigger && "code" in trigger ? trigger.code : null,
          restored: restored.length,
          kept: restored.filter((entry) => entry.keptAs).length,
          platform: deps.platform,
        });
        logger.flushSync?.();
      } catch (error) {
        const failure = restoreFailureOf(error);
        if (failure?.copyMissing) {
          failGoBack("What ADE can put back changed while it was downloading.", "Press Go back to see it again.", { reason: "copy_missing" });
        } else if (failure && !failure.rolledBack) {
          failGoBack(
            "ADE couldn't finish putting your data back. Nothing was deleted: your data is in copies on this computer.",
            `Don't use ADE yet. ${SUPPORT}`,
            { reason: "restore_partial", error: errorText(error) },
          );
        } else {
          failGoBack(
            `ADE couldn't put your data back, so it stayed on ${runningVersion}. Nothing was changed.`,
            `Close any other copy of ADE, and any terminal running the ade command. ${AGAIN}`,
            { reason: "restore", error: errorText(error) },
          );
        }
        throw error;
      }
    },
  };
}

export type StartupRecovery = ReturnType<typeof createStartupRecovery>;
