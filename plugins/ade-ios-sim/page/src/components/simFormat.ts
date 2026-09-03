/**
 * The pane's labels, moved from the compiled panel rather than rewritten.
 *
 * `deviceLabel`, `targetLabel`, `previewTargetLabel`, `previewStatusLabel`,
 * `previewMatchLabel`, `previewMatchTone` and `buildToolChips` are
 * `ChatIosSimulatorPanel.tsx` and `IosSimToolChips.tsx` verbatim, with two
 * changes and no others: they take the page's own narrowed types, and
 * `formatAge` is inlined here because `iosSimContracts.ts` is a renderer module
 * a guest cannot import.
 */

import type {
  IosScreenElement,
  IosSimulatorDevice,
  IosSimulatorLaunchTarget,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorStatus,
  IosSimulatorToolStatus,
} from "../types";

export function deviceLabel(device: IosSimulatorDevice | null | undefined): string {
  if (!device) return "No simulator";
  return `${device.name} · ${device.runtime}`;
}

export function targetLabel(target: IosSimulatorLaunchTarget | null | undefined): string {
  if (!target) return "No launchable app found";
  return target.detail ? `${target.name} · ${target.detail}` : target.name;
}

export function elementLabel(element: IosScreenElement | null): string {
  if (!element) return "No element";
  return element.label || element.identifier || element.role || element.elementType || element.id;
}

export function previewTargetLabel(target: IosSimulatorPreviewTarget | null | undefined): string {
  if (!target) return "No #Preview selected";
  return `${target.title} · ${target.sourceFile}:${target.sourceLine}`;
}

export function previewStatusLabel(
  capability: IosSimulatorPreviewCapability | null,
  targets: IosSimulatorPreviewTarget[],
): string {
  if (!capability) return "Checking the Xcode preview bridge…";
  if (!capability.supported) {
    return capability.error ?? capability.setupSteps[0] ?? "Preview Lab needs Xcode on this Mac.";
  }
  if (!targets.length) return "No #Preview found in this project.";
  return "Preview ready.";
}

export function previewMatchLabel(match: IosSimulatorPreviewMatch | null): string {
  if (!match) return "no match";
  if (match.status === "matched") return match.confidence;
  return match.status.replace("-", " ");
}

export function previewMatchTone(match: IosSimulatorPreviewMatch | null): string {
  if (match?.status === "matched" && match.confidence === "exact") {
    return "border-emerald-300/24 bg-emerald-400/[0.09] text-emerald-50/85";
  }
  if (match?.status === "matched") {
    return "border-amber-300/24 bg-amber-400/[0.09] text-amber-50/85";
  }
  return "border-white/[0.08] bg-white/[0.04] text-muted-fg/60";
}

/** Relative age, e.g. "12m ago". Null when there is no timestamp to age. */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A chat id, shortened for the ownership card the way the compiled pane did. */
export function shortChatId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export type ToolChipState = "ok" | "warn" | "missing";

export type ToolChip = {
  key: "macos" | "xcode" | "runtime" | "controls";
  label: string;
  state: ToolChipState;
  /** One line. A shell command when there is one, otherwise a short instruction. */
  hint: string | null;
  hintIsCommand: boolean;
};

function firstHint(...tools: Array<IosSimulatorToolStatus | undefined>): string | null {
  for (const tool of tools) {
    if (tool && !tool.available) {
      const hint = tool.installHint?.trim() || tool.detail?.trim();
      if (hint) return hint;
    }
  }
  return null;
}

function looksLikeCommand(hint: string | null): boolean {
  if (!hint) return false;
  return /^(brew|xcode-select|sudo|npm|pip|gh|open|softwareupdate|idb)\b/u.test(hint.trim());
}

/**
 * Collapses the tool matrix into four chips. Required gaps read rose, the
 * control-only gap (idb) reads amber, everything healthy keeps its own accent.
 *
 * `devices` is what makes the Runtime chip mean what it says: `simulator_window`
 * alone is only "Simulator.app exists", so a Mac with Xcode and zero installed
 * iOS runtimes read healthy on all four chips and left Launch enabled with
 * nothing to launch on.
 */
export function buildToolChips(
  status: IosSimulatorStatus | null,
  devices: IosSimulatorDevice[] = [],
): ToolChip[] {
  const byName = new Map((status?.tools ?? []).map((tool) => [tool.name, tool]));
  const xcrun = byName.get("xcrun");
  const xcodebuild = byName.get("xcodebuild");
  const simulatorWindow = byName.get("simulator_window");
  const idb = byName.get("idb");
  const idbCompanion = byName.get("idb_companion");
  const onMac = status ? status.platform === "darwin" : true;

  const xcodeOk = Boolean(xcrun?.available && xcodebuild?.available);
  const hasRuntimeDevice = devices.some((simulator) => simulator.isAvailable);
  const runtimeOk = Boolean(simulatorWindow?.available) && hasRuntimeDevice;
  const controlsOk = Boolean(idb?.available && idbCompanion?.available);
  const xcodeHint = firstHint(xcodebuild, xcrun);
  const runtimeHint = firstHint(simulatorWindow);
  const controlsHint = firstHint(idb, idbCompanion);

  return [
    {
      key: "macos",
      label: "macOS",
      state: onMac ? "ok" : "missing",
      hint: onMac ? null : "Driving a simulator runs on macOS only.",
      hintIsCommand: false,
    },
    {
      key: "xcode",
      label: "Xcode",
      state: xcodeOk ? "ok" : "missing",
      hint: xcodeOk ? null : xcodeHint ?? "xcode-select --install",
      hintIsCommand: xcodeOk ? false : looksLikeCommand(xcodeHint) || !xcodeHint,
    },
    {
      key: "runtime",
      label: "Runtime",
      state: runtimeOk ? "ok" : "missing",
      hint: runtimeOk ? null : runtimeHint ?? "Install an iOS runtime in Xcode Settings > Components.",
      hintIsCommand: runtimeOk ? false : looksLikeCommand(runtimeHint),
    },
    {
      key: "controls",
      label: "Controls",
      // idb is optional for viewing but is exactly what tap/type/drag need.
      state: controlsOk ? "ok" : "warn",
      hint: controlsOk ? null : controlsHint ?? "brew install facebook/fb/idb-companion",
      hintIsCommand: controlsOk ? false : looksLikeCommand(controlsHint) || !controlsHint,
    },
  ];
}

export function chipsHealthy(chips: ToolChip[]): boolean {
  return chips.every((chip) => chip.state === "ok");
}

/** The four blocking chips. `controls` is amber, so it never blocks the pane. */
export function setupBlocked(chips: ToolChip[]): boolean {
  return chips.some((chip) => chip.key !== "controls" && chip.state === "missing");
}
