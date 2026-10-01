import {
  RECOVERY_COPY,
  REPAIR_STEPS,
  type AdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RecoveryState,
} from "../shared/types/recovery";
import type { MachineResetPlan } from "../shared/types/machineReset";

/**
 * Browser-preview stand-ins for the recovery screen and the hard reset, so the
 * whole flow can be looked at without a broken machine or a real reset.
 *
 *   http://localhost:5173/#/work?adeRecovery=background_blocked
 *   …?adeRecovery=brain_not_running&adeRecoveryRepair=fail
 *
 * `adeRecovery` is any recovery state. Read from the URL only — never stored —
 * so a reload without it is a normal preview again.
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
      technicalDetail: `mock diagnosis: ${current}`,
    };
  };

  const repair = async (): Promise<ProjectRepairReport> => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const failAt = repairFails ? REPAIR_STEPS.findIndex((step) => step.id === "restart_service") : -1;
    const steps = REPAIR_STEPS.map((step, index) => ({
      id: step.id,
      label: step.label,
      status: failAt < 0 || index < failAt ? "ok" as const : index === failAt ? "failed" as const : "skipped" as const,
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
        nextAction: "Quit ADE and open it again, then choose Try again.",
      };
    }
    current = "healthy";
    return { ok: true, steps, dbHealthy: true, chatsTotal: 6, chatsNeedingAttention: 1, filesRemoved: 0 };
  };

  return {
    recovery: {
      diagnose,
      repair,
      openBackgroundSettings: async () => {
        settingsOpenedAt = Date.now();
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
