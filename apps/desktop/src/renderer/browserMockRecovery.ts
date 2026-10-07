import {
  RECOVERY_COPY,
  REPAIR_STEPS,
  type AdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RecoveryState,
} from "../shared/types/recovery";
import type { MachineResetPlan } from "../shared/types/machineReset";
import type { AppInfo, AutoUpdateSnapshot, LocalRuntimeStatus, UpdateTransactionResult } from "../shared/types";
import { LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE } from "../shared/runtimeErrors";

/**
 * Browser-preview stand-ins for the recovery screen, the brain-down banner and
 * the hard reset, so every repair surface can be looked at without a broken
 * machine or a real reset.
 *
 *   http://localhost:5173/#/work?adeRecovery=background_blocked
 *   …?adeRecovery=brain_not_running&adeRecoveryRepair=fail
 *   …?adeBrainDown=service             the update's service step failed
 *   …?adeBrainDown=background_blocked  …and macOS "Allow in the Background" is off
 *   …?adeBrainDown=updating            an update is still replacing the service
 *   …?adeBrainDown=service&adeRecoveryRepair=fail&adePlatform=win32
 *
 * `adeRecovery` is any recovery state (the full-screen recovery flow).
 * `adeBrainDown` is `service`, `restart`, `health`, `background_blocked` or
 * `updating` (the app banner). `adeRecoveryRepair=fail` makes Fix it fail in
 * both. Read from the URL only — never stored — so a reload without them is a
 * normal preview again.
 */

function urlParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  const hash = window.location.hash;
  const at = hash.indexOf("?");
  const hashSearch = new URLSearchParams(at >= 0 ? hash.slice(at + 1) : "");
  return search.get(name) ?? hashSearch.get(name);
}

const STATE_CODE: Partial<Record<RecoveryState, AdeRecoveryErrorCode>> = {
  disk_full: "disk_full",
  insufficient_headroom: "insufficient_headroom",
  db_repair_needed: "db_integrity",
  storage_unreadable: "storage_read_failed",
  brain_not_installed: "brain_not_installed",
  brain_crash_looping: "brain_crash_looping",
  brain_not_running: "brain_not_running",
  background_blocked: "background_item_blocked",
  socket_stale_no_owner: "socket_stale_no_owner",
  socket_owned_by_other: "socket_owned_by_other",
};

function readScenario(): { state: RecoveryState; code: AdeRecoveryErrorCode } | null {
  const raw = urlParam("adeRecovery");
  if (!raw || !(raw in RECOVERY_COPY)) return null;
  const state = raw as RecoveryState;
  return { state, code: STATE_CODE[state] ?? "unknown" };
}

// Read once at load: the app rewrites the URL on its first route change, and
// the query is gone by the time the screen is raised.
const SCENARIO = readScenario();
const REPAIR_FAILS = urlParam("adeRecoveryRepair") === "fail";
const IS_WINDOWS = urlParam("adePlatform") === "win32";

/** What the installer said, in its own (raw) words: these belong in the fold. */
const INSTALL_FAILURE = IS_WINDOWS
  ? {
      failureStep: "replacement_pid",
      message: "ADE service handover failed because the scheduled task did not report a replacement pid (old none, new none).",
    }
  : {
      failureStep: "replacement_pid",
      message: "ADE service handover failed because launchd did not report a distinct replacement pid (old none, new none).",
    };

/** A plausible diagnosis fold for each state, raw codes included. */
function mockTechnicalDetail(state: RecoveryState): string {
  const lines = [
    "freeBytes=48318382080",
    "dbSize=73400320",
    `socketPath=${IS_WINDOWS ? "\\\\.\\pipe\\ade-runtime" : "/Users/you/.ade/runtime/ade.sock"}`,
    `socketReachable=${state === "socket_owned_by_other" || state === "brain_starting"}`,
    "endpointHealthy=false",
  ];
  if (state === "brain_not_running" || state === "brain_crash_looping" || state === "unknown_failure") {
    lines.push(
      "serviceInstall=failed",
      "serviceHealth=installed",
      `serviceInstallFailureStep=${INSTALL_FAILURE.failureStep}`,
      `serviceInstallMessage=${INSTALL_FAILURE.message}`,
    );
  } else if (state === "background_blocked") {
    lines.push(
      "serviceInstall=failed",
      "serviceHealth=installed",
      "backgroundItem=requires_approval",
      "serviceInstallFailureStep=background_item_blocked",
    );
  } else if (state === "brain_starting") {
    lines.push("serviceInstall=installed (starting)", "serviceHealth=running");
  }
  lines.push("database=ok");
  return lines.join("\n");
}

export function browserMockRecoveryScenario(): { state: RecoveryState; code: AdeRecoveryErrorCode } | null {
  return SCENARIO;
}

const MOCK_PLAN: MachineResetPlan = {
  generatedAt: new Date().toISOString(),
  platform: "darwin",
  projects: [
    {
      rootPath: "/Users/you/code/web-app",
      displayName: "web-app",
      exists: true,
      lanes: [
        { name: "checkout-fix-1a2b3c4d", path: "/Users/you/code/web-app/.ade/worktrees/checkout-fix-1a2b3c4d", branch: "ade/checkout-fix", uncommittedFiles: 4, unpushedCommits: 0 },
        { name: "docs-5e6f7a8b", path: "/Users/you/code/web-app/.ade/worktrees/docs-5e6f7a8b", branch: "ade/docs", uncommittedFiles: 0, unpushedCommits: 0 },
      ],
    },
    {
      rootPath: "/Users/you/code/api",
      displayName: "api",
      exists: true,
      lanes: [
        { name: "rate-limits-9c0d1e2f", path: "/Users/you/code/api/.ade/worktrees/rate-limits-9c0d1e2f", branch: "ade/rate-limits", uncommittedFiles: 0, unpushedCommits: 2 },
      ],
    },
  ],
  items: [
    { kind: "process", label: "Running ADE process", target: "4121 /Applications/ADE.app/Contents/MacOS/ADE" },
    { kind: "background_service", label: "Background service", target: "~/Library/LaunchAgents/com.ade.runtime.plist" },
    { kind: "background_service", label: "Background service", target: "~/Library/LaunchAgents/com.ade.watchdog.plist" },
    { kind: "directory", label: "ADE's data folder", target: "~/.ade" },
    { kind: "directory", label: "ADE folder", target: "~/Library/Application Support/ade-desktop" },
    { kind: "directory", label: "ADE folder", target: "~/Library/Caches/ade-desktop-updater" },
    { kind: "directory", label: "Project data", target: "/Users/you/code/web-app/.ade" },
    { kind: "directory", label: "Project data", target: "/Users/you/code/api/.ade" },
    { kind: "keychain", label: "Keychain items", target: "com.ade.desktop.api-keys.v1" },
    { kind: "config_entry", label: "PATH line ADE added", target: "~/.zshrc" },
    { kind: "directory", label: "Temporary files", target: "$TMPDIR/ade-* (41)" },
  ],
  lanesWithWork: 2,
  notes: [],
};

/** `recovery` and `machineReset` for the preview's `window.ade`. */
export function createBrowserMockRecoveryBridges(): Record<string, unknown> {
  const scenario = browserMockRecoveryScenario();
  const repairFails = REPAIR_FAILS;
  let current: RecoveryState = scenario?.state ?? "healthy";
  let settingsOpenedAt: number | null = null;

  const diagnose = async (): Promise<ProjectRecoveryDiagnosis> => {
    // The person "turns ADE on" a few seconds after opening System Settings.
    if (current === "background_blocked" && settingsOpenedAt && Date.now() - settingsOpenedAt > 4_000) {
      current = "healthy";
    }
    const copy = RECOVERY_COPY[current];
    return {
      state: current,
      code: STATE_CODE[current] ?? "unknown",
      headline: copy.headline,
      body: copy.body,
      canAutoRepair: copy.canAutoRepair,
      technicalDetail: mockTechnicalDetail(current),
    };
  };

  const repair = async (): Promise<ProjectRepairReport> => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const failAt = repairFails ? REPAIR_STEPS.findIndex((step) => step.id === "restart_service") : -1;
    const steps = REPAIR_STEPS.map((step, index) => ({
      id: step.id,
      label: step.label,
      status: failAt < 0 || index < failAt ? "ok" as const : index === failAt ? "failed" as const : "skipped" as const,
      ...(index === failAt ? { detail: INSTALL_FAILURE.message } : {}),
    }));
    if (failAt >= 0) {
      return {
        ok: false,
        steps,
        dbHealthy: true,
        chatsTotal: null,
        chatsNeedingAttention: null,
        filesRemoved: 0,
        failureCode: "brain_crash_looping",
        nextAction: "Restart ADE next. It starts the background service fresh.",
      };
    }
    current = "healthy";
    return { ok: true, steps, dbHealthy: true, chatsTotal: 6, chatsNeedingAttention: 1, filesRemoved: 0 };
  };

  // Report issue on the recovery surfaces. Only while a scenario is up: the
  // preview has no other diagnostics bridge, so this one carries the whole
  // group (the app shell and the crash boundary read the rest of it).
  const diagnostics = scenario || BRAIN_DOWN
    ? {
        diagnostics: {
          autoReport: async () => undefined,
          getSharing: async () => ({ enabled: true, sendsInWindow: 0, limit: 3 }),
          setSharing: async (enabled: boolean) => ({ enabled, sendsInWindow: 0, limit: 3 }),
          revealReport: async () => undefined,
          onAutoSent: () => () => {},
          ackAutoSent: async () => undefined,
          openIssue: async () => ({ report: "mock report", filePath: "", issueUrl: "", installId: "mock", copied: true, opened: true }),
          sendManual: async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
            return { ok: true as const, reference: "ADE-7Q4K-2M", reportPath: "", report: "mock report" };
          },
        },
      }
    : {};

  return {
    ...diagnostics,
    recovery: {
      diagnose,
      repair,
      openBackgroundSettings: async () => {
        settingsOpenedAt = Date.now();
        brainDownSettingsOpenedAt = Date.now();
        return { opened: true };
      },
      onRepairStep: () => () => {},
    },
    machineReset: {
      plan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return MOCK_PLAN;
      },
      start: async () => ({ started: true }),
      chooseRescueDir: async () => "/Users/you/Rescued lanes",
    },
  };
}

/** Puts the recovery screen up for the scenario in the URL, once the store exists. */
export function showBrowserMockRecoveryScreen(
  setError: (error: { message: string; code: string; rootPath: string }) => void,
  rootPath: string,
): void {
  const scenario = browserMockRecoveryScenario();
  if (!scenario || scenario.state === "healthy") return;
  setError({ message: RECOVERY_COPY[scenario.state].headline, code: scenario.code, rootPath });
}

type BrainDownScenario = "service" | "restart" | "health" | "background_blocked" | "updating";
const BRAIN_DOWN_SCENARIOS: readonly BrainDownScenario[] = ["service", "restart", "health", "background_blocked", "updating"];

function readBrainDownScenario(): BrainDownScenario | null {
  const raw = urlParam("adeBrainDown");
  return raw && (BRAIN_DOWN_SCENARIOS as readonly string[]).includes(raw) ? raw as BrainDownScenario : null;
}

const BRAIN_DOWN = readBrainDownScenario();
let brainDownSettingsOpenedAt: number | null = null;
let brainDownRecovered = false;

/** The update copy main sends (`UPDATE_TRANSACTION_FAILURE_COPY`). */
const BRAIN_DOWN_FAILURE_MESSAGE: Record<"service" | "restart" | "health", string> = {
  service: "ADE's background service didn't start after the update",
  restart: "ADE's background service didn't restart after the update",
  health: "ADE's background service isn't responding after the update",
};

function brainDownTransaction(scenario: BrainDownScenario): UpdateTransactionResult | null {
  if (scenario === "updating") return null;
  const failed = scenario === "background_blocked" ? "service" : scenario;
  const order = ["swap", "service", "restart", "health"] as const;
  const failedAt = order.indexOf(failed);
  return {
    ok: false,
    version: "1.2.94",
    steps: order.map((id, index) => ({
      id,
      status: index < failedAt ? "ok" as const : index === failedAt ? "failed" as const : "skipped" as const,
      detail: index === 0
        ? "Running 1.2.94."
        : index === failedAt
          ? (scenario === "background_blocked" ? "ADE is switched off under Allow in the Background." : INSTALL_FAILURE.message)
          : index > failedAt ? "Skipped after an earlier step failed." : "",
    })),
    failureMessage: BRAIN_DOWN_FAILURE_MESSAGE[failed],
  };
}

function brainDownRuntimeStatus(scenario: BrainDownScenario, base: LocalRuntimeStatus): LocalRuntimeStatus {
  if (brainDownRecovered) return { ...base, connectionState: "connected", pid: 4242, runtimeMode: "primary" };
  // The person "turns ADE on" a few seconds after opening System Settings.
  const blocked = scenario === "background_blocked"
    && !(brainDownSettingsOpenedAt && Date.now() - brainDownSettingsOpenedAt > 4_000);
  return {
    ...base,
    connectionState: "idle",
    pid: null,
    runtimeMode: "primary",
    serviceInstall: {
      state: "failed",
      attempted: true,
      path: IS_WINDOWS ? null : "/Users/you/Library/LaunchAgents/com.ade.runtime.plist",
      message: blocked ? "macOS did not start the ADE background service: Allow in the Background is off." : INSTALL_FAILURE.message,
      exitCode: 1,
      updatedAt: new Date().toISOString(),
      failureStep: blocked ? "background_item_blocked" : INSTALL_FAILURE.failureStep,
    },
    serviceHealth: {
      state: "installed",
      installed: true,
      running: false,
      path: null,
      message: null,
      checkedAt: new Date().toISOString(),
      backgroundItem: IS_WINDOWS ? null : blocked ? "requires_approval" : "enabled",
    },
  };
}

export function browserMockBrainDownScenario(): BrainDownScenario | null {
  return BRAIN_DOWN;
}

/**
 * Patches the preview's `window.ade` for `?adeBrainDown=…`: a half-applied
 * update in the update snapshot, a down service in the runtime status, and a
 * Fix it (`app.restartBackgroundService`) that works or, with
 * `adeRecoveryRepair=fail`, fails like the installer did.
 */
export function applyBrowserMockBrainDown(ade: {
  updateGetState: () => Promise<AutoUpdateSnapshot>;
  app: { getInfo: () => Promise<AppInfo>; restartBackgroundService?: () => Promise<void> };
}): void {
  const scenario = BRAIN_DOWN;
  if (!scenario) return;
  const baseGetState = ade.updateGetState;
  ade.updateGetState = async () => ({ ...(await baseGetState()), updateTransaction: brainDownTransaction(scenario) });
  const app = ade.app;
  const baseGetInfo = app.getInfo;
  app.getInfo = async () => {
    const info = await baseGetInfo();
    return info.localRuntime ? { ...info, localRuntime: brainDownRuntimeStatus(scenario, info.localRuntime) } : info;
  };
  app.restartBackgroundService = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    if (REPAIR_FAILS) throw new Error(INSTALL_FAILURE.message);
    brainDownRecovered = true;
  };
}

/** Puts the "an update owns the service" project error up for `adeBrainDown=updating`. */
export function showBrowserMockBrainDownPending(
  setError: (error: { message: string; retryRootPath: string }) => void,
  rootPath: string,
): void {
  if (BRAIN_DOWN !== "updating") return;
  setError({ message: LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE, retryRootPath: rootPath });
}
