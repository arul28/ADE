import type { LocalRuntimeStatus, UpdateImpact } from "../../../shared/types";

/**
 * Whether quitting ADE may install the update that is waiting.
 *
 * With automatic install on, a quit installs a downloaded update. An install
 * is never the app alone: it moves the background service to the new build
 * too (the existing `quitAndInstall` path stops the service, and the launch
 * that lands the install restarts it on the new version and checks it). A
 * plain quit leaves the background brain running, with its agents, so an
 * install on quit would stop work the person expected to keep going.
 *
 * So a quit installs only when that costs nothing:
 * - the service brain is running and nothing is running on it (no chat mid
 *   turn, no CLI session, no terminal), or
 * - there is no service brain to stop: ADE is running the brain itself
 *   (`app_fallback`), and the quit stops it either way.
 * Otherwise the update waits, the quit is an ordinary quit, and automatic
 * install picks it up on a later launch under its own rules. "Could not
 * check" is treated as "something is running": never as idle.
 */

export type InstallOnQuitDecision =
  | { action: "install"; version: string }
  | {
      action: "defer";
      version: string;
      reason: "agents_running" | "work_unknown";
    };

export function decideInstallOnQuit(args: {
  version: string;
  runtimeMode: LocalRuntimeStatus["runtimeMode"];
  /** What a restart would stop. Null when it was not read. */
  impact: UpdateImpact | null;
}): InstallOnQuitDecision {
  const { version } = args;
  if (args.runtimeMode === "app_fallback") return { action: "install", version };
  // An isolated brain is this app's own, beside a service brain it does not
  // talk to; the impact read answers for the wrong brain.
  if (args.runtimeMode !== "primary") return { action: "defer", version, reason: "work_unknown" };
  const impact = args.impact;
  if (!impact?.checked) return { action: "defer", version, reason: "work_unknown" };
  const busy = impact.chats.length > 0
    || impact.cliSessions > 0
    || impact.terminals > 0
    || impact.busyWithoutDetail === true;
  return busy ? { action: "defer", version, reason: "agents_running" } : { action: "install", version };
}

/**
 * Thrown by the install preparation when the second look finds work running:
 * the quit stays a plain quit and the update stays downloaded.
 */
export class InstallOnQuitDeferredError extends Error {
  readonly decision: Extract<InstallOnQuitDecision, { action: "defer" }>;

  constructor(decision: Extract<InstallOnQuitDecision, { action: "defer" }>) {
    super(`The update on quit waits: ${decision.reason}.`);
    this.name = "InstallOnQuitDeferredError";
    this.decision = decision;
  }
}

/**
 * How long after the quit asked for the install its relaunch may still land.
 * A Windows install runs for minutes; past this, a launch is the person's.
 */
const RELAUNCH_WINDOW_MS = 10 * 60_000;
/**
 * macOS: Squirrel.Mac relaunches with no argument and no environment of its
 * own, so the clock is the only sign. It relaunches within seconds of the swap.
 */
const MAC_RELAUNCH_WINDOW_MS = 3 * 60_000;

/**
 * Whether this launch is the updater's own relaunch of a quit-install, and not
 * one the person made. Windows: the NSIS installer starts ADE with
 * `--updated`. Linux: the AppImage updater starts it with
 * `APPIMAGE_SILENT_INSTALL=true`. macOS has no marker (see above), only the
 * shorter window.
 */
export function isQuitInstallRelaunch(args: {
  requestedAt: string;
  nowMs: number;
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  const requestedAtMs = Date.parse(args.requestedAt);
  if (!Number.isFinite(requestedAtMs)) return false;
  const ageMs = args.nowMs - requestedAtMs;
  if (args.platform === "darwin") return ageMs >= 0 && ageMs <= MAC_RELAUNCH_WINDOW_MS;
  if (ageMs < 0 || ageMs > RELAUNCH_WINDOW_MS) return false;
  if (args.platform === "win32") return args.argv.slice(1).includes("--updated");
  return args.env.APPIMAGE_SILENT_INSTALL === "true";
}

/** The parts of a BrowserWindow the launch side drives. */
type LaunchWindow = {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  once(event: "show", listener: () => void): unknown;
};

type LaunchTransaction = { ok: boolean; version?: string | null } | null | undefined;

export type InstallOnQuitController = ReturnType<typeof createInstallOnQuitController>;

/**
 * Both halves of an install on quit.
 *
 * The quit half reads whether the waiting update may install (`plan`), checks
 * again when the install takes over the quit (`install`) and once more right
 * before the background service is stopped (`confirmBeforeServiceStop`): a
 * chat can start while the feed is re-checked.
 *
 * The launch half runs on the launch that lands the install. When it is the
 * updater's own relaunch (`isQuitInstallRelaunch`), ADE starts with no window
 * and no Dock icon, lets the post-update transaction move the service to the
 * new build, and closes again. Anything the person does meanwhile (reopening
 * ADE, a deep link, a file) shows the window and the launch stays open. A
 * failed transaction is shown, never closed over.
 */
export function createInstallOnQuitController(deps: {
  logger: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
  updates: {
    installOnQuitVersion(): string | null;
    quitAndInstall(resumeChats: boolean, options: { closeAfterInstall: true }): Promise<boolean>;
  };
  readRuntimeMode: () => LocalRuntimeStatus["runtimeMode"];
  /** What a restart would stop. Never rejects in production; a rejection reads as unknown. */
  collectImpact: (timeoutMs: number) => Promise<UpdateImpact | null>;
  hideWindows: () => void;
  dock: { hide(): void; show(): void } | null;
  nowMs?: () => number;
}) {
  const nowMs = deps.nowMs ?? Date.now;
  let deferredBeforeServiceStop = false;
  let launchHidden = false;
  let launchWindow: LaunchWindow | null = null;

  const readDecision = async (version: string): Promise<InstallOnQuitDecision> => {
    const runtimeMode = deps.readRuntimeMode();
    const impact = runtimeMode === "primary" ? await deps.collectImpact(3_000).catch(() => null) : null;
    return decideInstallOnQuit({ version, runtimeMode, impact });
  };

  const logDeferred = (decision: Extract<InstallOnQuitDecision, { action: "defer" }>, stage: string): void => {
    deps.logger.info("autoUpdate.quit_install_deferred", {
      version: decision.version,
      reason: decision.reason,
      stage,
    });
  };

  const reveal = (reason: string): void => {
    if (!launchHidden) return;
    launchHidden = false;
    deps.logger.info("autoUpdate.quit_install_launch_shown", { reason });
    deps.dock?.show();
    if (launchWindow && !launchWindow.isDestroyed()) {
      launchWindow.show();
      launchWindow.focus();
    }
  };

  /**
   * What a quit would do with a waiting update, or null when none waits or
   * automatic install is off. Never rejects: a failed read is "could not
   * check", which defers.
   */
  const plan = async (): Promise<InstallOnQuitDecision | null> => {
    const version = deps.updates.installOnQuitVersion();
    return version ? readDecision(version) : null;
  };

  return {
    plan,

    /**
     * Installs the waiting update as ADE quits, through the same install as
     * "Restart and install". Read again here: the prompt can sit on screen
     * while an agent starts. True when the install took over the quit; false
     * leaves the caller's plain quit, with the update still downloaded.
     */
    async install(planned: InstallOnQuitDecision | null): Promise<boolean> {
      if (!planned) return false;
      const decision = planned.action === "install" ? await plan() : planned;
      if (!decision) return false;
      if (decision.action !== "install") {
        logDeferred(decision, "quit");
        return false;
      }
      deps.logger.info("autoUpdate.quit_install_start", { version: decision.version });
      // The install takes a few seconds before ADE goes (a feed re-check, the
      // service handoff). The windows go now, as a quit's would.
      deps.hideWindows();
      deferredBeforeServiceStop = false;
      const started = await deps.updates.quitAndInstall(false, { closeAfterInstall: true });
      if (!started && !deferredBeforeServiceStop) {
        deps.logger.warn("autoUpdate.quit_install_not_started", { version: decision.version });
      }
      return started;
    },

    /**
     * The last look, from the install preparation, right before the background
     * service is stopped. Throws `InstallOnQuitDeferredError` when work is
     * running now, which unwinds the install into a plain quit.
     */
    async confirmBeforeServiceStop(version: string): Promise<void> {
      const decision = await readDecision(version);
      if (decision.action === "install") return;
      deferredBeforeServiceStop = true;
      logDeferred(decision, "before_service_stop");
      throw new InstallOnQuitDeferredError(decision);
    },

    /**
     * Decides, early in the launch, whether it runs hidden. Returns true when
     * it does; the caller then creates its first window hidden.
     */
    beginLaunch(args: {
      /** The post-update transaction runs on this launch. */
      refreshingAfterUpdate: boolean;
      /** The quit-install this launch landed, or null. */
      landed: { requestedAt: string } | null;
      platform: NodeJS.Platform;
      argv: readonly string[];
      env: NodeJS.ProcessEnv;
      version: string;
    }): boolean {
      if (!args.refreshingAfterUpdate || !args.landed) return false;
      const relaunch = isQuitInstallRelaunch({
        requestedAt: args.landed.requestedAt,
        nowMs: nowMs(),
        platform: args.platform,
        argv: args.argv,
        env: args.env,
      });
      if (!relaunch) {
        // The person opened ADE (the installer's own relaunch never came, or
        // came too late): the transaction still runs, in the open.
        deps.logger.info("autoUpdate.quit_install_launch_visible", {
          version: args.version,
          requestedAt: args.landed.requestedAt,
        });
        return false;
      }
      launchHidden = true;
      deps.logger.info("autoUpdate.quit_install_launch", { version: args.version });
      deps.dock?.hide();
      return true;
    },

    isLaunchHidden(): boolean {
      return launchHidden;
    },

    /** The person opened ADE, or something showed it: the launch stays open. */
    reveal,

    /**
     * Takes the first window of a launch that started hidden, and closes ADE
     * once the transaction has the service on the new build, unless the launch
     * was shown meanwhile. Revealed while the window was being made, it shows
     * the window now.
     */
    finishLaunch(args: {
      window: LaunchWindow;
      transactionDone: Promise<unknown>;
      readTransaction: () => LaunchTransaction;
      /** A window is on screen: one opened by a deep link or a file, say. */
      anyWindowVisible: () => boolean;
      isShuttingDown: () => boolean;
      requestShutdown: () => void;
    }): void {
      launchWindow = args.window;
      if (!launchHidden) {
        if (!args.window.isDestroyed()) {
          args.window.show();
          args.window.focus();
        }
        return;
      }
      args.window.once("show", () => reveal("window_shown"));
      void args.transactionDone.then(() => {
        if (!launchHidden || args.isShuttingDown() || args.window.isDestroyed()) return;
        if (args.anyWindowVisible()) {
          reveal("window_opened");
          return;
        }
        const transaction = args.readTransaction();
        if (transaction?.ok) {
          deps.logger.info("autoUpdate.quit_install_launch_closing", { version: transaction.version ?? null });
          args.requestShutdown();
          return;
        }
        // A half-applied update is shown, not closed over: the window carries
        // the transaction's failure and the step that failed.
        reveal("transaction_failed");
      });
    },
  };
}
