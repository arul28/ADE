import type {
  MacosVmGuestReadiness,
  MacosVmGuestReadinessState,
  MacosVmPhase,
  MacosVmPhaseNumber,
  MacosVmRecord,
} from "../../shared/types";
import { MACOS_VM_PHASES } from "../../shared/types";

export const MACOS_VM_RUNTIME_AUTH_STORAGE_KEY = "ade.vm.runtimeAuthConfirmed.v1";

export function readMacosVmRuntimeAuthConfirmed(): boolean {
  try {
    return window.localStorage.getItem(MACOS_VM_RUNTIME_AUTH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMacosVmRuntimeAuthConfirmed(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(MACOS_VM_RUNTIME_AUTH_STORAGE_KEY, "1");
    else window.localStorage.removeItem(MACOS_VM_RUNTIME_AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage failures in browser-test/private contexts.
  }
}

export function fallbackMacosVmGuestReadiness(
  vm: MacosVmRecord | null | undefined,
): MacosVmGuestReadiness {
  if (!vm) {
    return {
      state: "not_created",
      canControlGui: false,
      canRunCode: false,
      sshAvailable: null,
      setupAssistantLikely: false,
      detail: "No Mac VM yet.",
      nextAction: "Set up your Mac VM in the VM tab.",
    };
  }
  if (vm.guestReadiness) return vm.guestReadiness;
  if (vm.runtimeInstall?.state === "installed") {
    return {
      state: "runtime_ready",
      canControlGui: true,
      canRunCode: true,
      sshAvailable: true,
      setupAssistantLikely: false,
      detail: "Agent runtime is installed and the VM is ready.",
      nextAction: "Create a VM lane via + New lane → Mac VM.",
    };
  }
  if (vm.runtimeInstall?.state === "installing") {
    return {
      state: "runtime_installing",
      canControlGui: true,
      canRunCode: false,
      sshAvailable: true,
      setupAssistantLikely: false,
      detail: "Installing the ADE agent runtime inside the VM.",
      nextAction: "Wait for runtime install to finish.",
    };
  }
  if (vm.state === "running") {
    return {
      state: vm.sshCommand ? "code_ready" : "desktop_unverified",
      canControlGui: true,
      canRunCode: Boolean(vm.sshCommand),
      sshAvailable: vm.sshCommand ? true : null,
      setupAssistantLikely: false,
      detail: vm.sshCommand
        ? "Remote Login is enabled. Save credentials and install the agent runtime."
        : "The VM is running. Finish first-boot setup and enable Remote Login.",
      nextAction: vm.sshCommand
        ? "Save credentials, then install the agent runtime."
        : "Follow the first-boot checklist in the VM tab.",
    };
  }
  const provisioning = vm.state === "creating" || vm.state === "installing";
  return {
    state: provisioning ? "provisioning" : vm.state === "failed" ? "blocked" : "not_running",
    canControlGui: false,
    canRunCode: false,
    sshAvailable: null,
    setupAssistantLikely: false,
    detail: vm.lastError ?? `The VM is ${vm.state.replace(/_/g, " ")}.`,
    nextAction: provisioning ? "Wait for provisioning to finish." : "Start the VM to continue.",
  };
}

/**
 * Short label for a guest-readiness state. Uses phase-specific wording rather
 * than the legacy "Guest readiness" framing.
 */
export function macosVmGuestReadinessLabel(state: MacosVmGuestReadinessState): string {
  switch (state) {
    case "runtime_ready":
      return "Ready for VM lanes";
    case "runtime_installing":
      return "Installing agent runtime";
    case "code_ready":
      return "Save credentials";
    case "setup_required":
      return "First-boot setup";
    case "desktop_unverified":
      return "Mac desktop check";
    case "provisioning":
      return "Provisioning";
    case "booting":
      return "Booting";
    case "not_running":
      return "Not running";
    case "not_created":
      return "Not set up";
    case "blocked":
      return "Blocked";
    default:
      return "Unknown";
  }
}

export function macosVmNeedsFirstBootSetup(
  readiness: MacosVmGuestReadiness | null | undefined,
): boolean {
  return readiness?.state === "setup_required" || readiness?.setupAssistantLikely === true;
}

/**
 * Map a guest-readiness state to the active phase number (1..10) in the
 * onboarding stepper. Used as a fallback when `vm.currentPhase` is not set.
 */
export function macosVmPhaseFromReadiness(
  vm: MacosVmRecord | null | undefined,
  readiness: MacosVmGuestReadiness | null | undefined,
): MacosVmPhaseNumber {
  if (!vm) return 1;
  // Validate `vm.currentPhase` before returning it: the record can arrive
  // from older clients or a stale persisted state with a value outside the
  // current MACOS_VM_PHASES range. Returning an unchecked value would let
  // `macosVmPhase()` index past the array and crash a label lookup.
  if (
    typeof vm.currentPhase === "number"
    && Number.isFinite(vm.currentPhase)
    && vm.currentPhase >= 1
    && vm.currentPhase <= MACOS_VM_PHASES.length
  ) {
    return vm.currentPhase as MacosVmPhaseNumber;
  }
  const state = readiness?.state ?? vm.guestReadiness?.state ?? "not_created";
  switch (state) {
    case "not_created":
      return 1;
    case "provisioning":
      // Either downloading or creating/installing — collapse to "download" for
      // the user since the stepper shows the most recent progress anyway.
      return 2;
    case "not_running":
      return 3;
    case "booting":
      return 5;
    case "setup_required":
      return 6;
    case "desktop_unverified":
      return 7;
    case "code_ready":
      return 8;
    case "runtime_installing":
      return 9;
    case "runtime_ready":
      return 10;
    case "blocked":
    case "unknown":
    default:
      return 1;
  }
}

export function macosVmPhase(phaseNumber: MacosVmPhaseNumber): MacosVmPhase {
  // Defensive bounds check: if a caller still slips an out-of-range number
  // through (e.g. legacy persisted state or a future phase added to the
  // type but not the runtime array), fall back to the first phase rather
  // than throwing on `.label` access downstream.
  return MACOS_VM_PHASES[phaseNumber - 1] ?? MACOS_VM_PHASES[0]!;
}

export function macosVmPhaseLabel(phaseNumber: MacosVmPhaseNumber): string {
  return macosVmPhase(phaseNumber).label;
}

/**
 * True when the VM is past phase 10 and ready to host VM-lane work.
 * Used as the gate for unblocking the Work tab and enabling the VM-lane radio.
 */
export function macosVmIsRuntimeReady(
  readiness: MacosVmGuestReadiness | null | undefined,
): boolean {
  return readiness?.state === "runtime_ready";
}
