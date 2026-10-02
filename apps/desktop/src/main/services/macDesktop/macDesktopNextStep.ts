/**
 * What an agent should try after a Mac Desktop action ADE could not confirm.
 *
 * Input on the lane's display is a ladder: an accessibility action first
 * (silent, scoped to one element), then real pointer and keyboard events
 * (global, behind the user's lease). An `unconfirmed` effect alone left each
 * agent to guess, and most repeated the accessibility action that had just done
 * nothing. This names one next method and why, from what this process already
 * knows: the element, its app, the input mode, and the lease.
 *
 * Pure. The caller passes the lease decision in.
 */

import type { ComputerUseActionEffect, ComputerUseActionNextStep } from "../../../shared/types/agentObservation";
import type {
  MacDesktopElement,
  MacDesktopInputMode,
  MacDesktopObservation,
} from "../../../shared/types/macDesktop";
import type { MacDesktopLeaseDecision } from "./macDesktopLease";

/** Apps whose pages the ADE browser drives better than accessibility can. */
const WEB_BROWSER_BUNDLE_IDS = new Set([
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "company.thebrowser.Browser",
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "org.mozilla.firefox",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
]);

/** Roles that only show content; an accessibility press on them does nothing. */
const PASSIVE_ROLES = new Set(["AXStaticText", "AXImage", "AXGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown"]);

/** Actions whose accessibility form can be swapped for real input. */
const LADDER_ACTIONS = new Set(["click", "type", "press", "scroll"]);

export type MacDesktopNextStepInput = {
  action: string;
  mode: MacDesktopInputMode;
  effect: ComputerUseActionEffect;
  /** The element the target resolved to, in the `before` tree. */
  resolved: MacDesktopElement | null;
  /** The tree the target was resolved against. */
  before: MacDesktopObservation | null;
  /** A click's button, so the advice reproduces a right click as a right click. */
  button?: string | null;
  /** A click's repeat count. */
  count?: number | null;
  /** Whether this caller may post real input right now. */
  lease: MacDesktopLeaseDecision;
};

/** Is the element web content (inside an `AXWebArea`)? Elements are walked by `parentIndex`. */
function isWebContent(element: MacDesktopElement, before: MacDesktopObservation | null): boolean {
  if (element.role === "AXWebArea") return true;
  if (!before) return false;
  const byIndex = new Map(before.elements.map((entry) => [entry.index, entry]));
  const seen = new Set<number>();
  let parent = element.parentIndex;
  while (parent != null && !seen.has(parent)) {
    seen.add(parent);
    const node = byIndex.get(parent);
    if (!node) return false;
    if (node.role === "AXWebArea") return true;
    parent = node.parentIndex;
  }
  return false;
}

function bundleIdOf(element: MacDesktopElement, before: MacDesktopObservation | null): string | null {
  const windows = before?.windows ?? [];
  const window = windows.find((entry) => element.windowId != null && entry.id === element.windowId)
    ?? windows.find((entry) => entry.pid === element.pid);
  return window?.bundleId ?? null;
}

/** A web page inside a real browser: the ADE browser drives it better. */
function browserPageStep(
  element: MacDesktopElement | null,
  before: MacDesktopObservation | null,
): ComputerUseActionNextStep | null {
  if (!element || !isWebContent(element, before)) return null;
  const bundleId = bundleIdOf(element, before);
  if (!bundleId || !WEB_BROWSER_BUNDLE_IDS.has(bundleId)) return null;
  return {
    method: "browser",
    reason: "this is a web page in a browser; the ADE browser acts on the DOM and confirms each step, unless the task needs this browser",
    // No command: ADE does not know the page's URL here, and a placeholder is
    // not a command the agent can run as is.
    command: null,
  };
}

/** Why accessibility input probably did not apply, or null when it probably did. */
function accessibilityMissReason(
  action: string,
  element: MacDesktopElement | null,
  webContent: boolean,
): string | null {
  if (action === "press") return "the key went to the app through accessibility, and some apps read keys only from real key events";
  if (action === "scroll") return "accessibility scrolling did not move this view";
  if (!element) return "the target did not resolve to an element that accessibility can act on";
  if (webContent) return "web content often accepts an accessibility action without applying it";
  if (action === "type") return "the field did not take the typed value through accessibility";
  // A list this driver did not send is unknown, not empty.
  if (Array.isArray(element.actions) && !element.actions.includes("AXPress")) {
    return PASSIVE_ROLES.has(element.role)
      ? `the ${element.role} element only shows content and has no AXPress action`
      : "the element has no AXPress action";
  }
  return null;
}

function realInputStep(
  args: Pick<MacDesktopNextStepInput, "action" | "resolved" | "button" | "count" | "lease">,
  why: string,
): ComputerUseActionNextStep {
  const { lease } = args;
  if (!lease.ok) {
    if (lease.code === "MAC_DESKTOP_INPUT_LEASE_REQUIRED") {
      return {
        method: "lease",
        reason: `${why}; real input fixes this, and it needs the user's approval once per chat — ask for it, then repeat the command with --real`,
        command: `ade mac-desktop lease --reason "${args.action} did not apply through accessibility" --text`,
      };
    }
    const holder = lease.code === "MAC_DESKTOP_USER_HAS_CONTROL" ? "the user is driving this display" : "another chat holds real input";
    return {
      method: "observe",
      reason: `${why}, but ${holder}; wait until real input is free, then repeat the command with --real`,
      command: null,
    };
  }
  return {
    method: "real_input",
    reason: `${why}; this chat holds real input, so repeat the command with --real`,
    command: realClickCommand(args),
  };
}

/**
 * The real-input command for a click, at the element's centre in global screen
 * points. Only built when every part of the click can be reproduced: a triple
 * click has no flag, so it gets no command rather than one that clicks once.
 */
function realClickCommand(
  args: Pick<MacDesktopNextStepInput, "action" | "resolved" | "button" | "count">,
): string | null {
  const { resolved } = args;
  if (args.action !== "click" || !resolved) return null;
  const count = args.count ?? 1;
  if (count > 2) return null;
  const button = args.button === "right" ? " --right" : "";
  const repeat = count === 2 ? " --double" : "";
  return `ade mac-desktop click --x ${Math.round(resolved.center.x)} --y ${Math.round(resolved.center.y)}${button}${repeat} --real --text`;
}

/** The step for an element that is disabled: wait, do not change method. */
function disabledObserveStep(): ComputerUseActionNextStep {
  return {
    method: "observe",
    reason: "the element is disabled; something else must happen first, so do not change input method",
    command: null,
  };
}

/**
 * The one next step for this action, or null when there is no advice: the
 * effect was observed, the action was not compared, or it is not on the ladder.
 */
export function macDesktopNextStep(args: MacDesktopNextStepInput): ComputerUseActionNextStep | null {
  if (args.effect.status !== "unconfirmed") return null;
  if (!LADDER_ACTIONS.has(args.action)) return null;
  const { resolved, before } = args;

  // Strict: an older driver may omit the field, and absent is not disabled.
  if (resolved && resolved.enabled === false) return disabledObserveStep();

  const webContent = resolved ? isWebContent(resolved, before) : false;
  const browserStep = browserPageStep(resolved, before);
  if (browserStep) return browserStep;

  if (args.mode === "real") {
    return {
      method: "observe",
      reason: "real input was delivered and nothing changed; the target may be covered, off screen, or the app busy — check the screenshot or wait for the label you expect before you retry",
      command: null,
    };
  }

  const why = accessibilityMissReason(args.action, resolved, webContent);
  if (!why) {
    const prefix = resolved?.actions?.includes("AXPress") ? "the element accepts AXPress, so the" : "the";
    return {
      method: "observe",
      reason: `${prefix} action probably applied with no visible change, or the app is slow; wait for the label you expect before you retry`,
      command: null,
    };
  }
  return realInputStep(args, why);
}

/**
 * The next step when the driver refused an accessibility action outright.
 *
 * An element with no press action never reaches the effect comparison: the
 * driver throws first. That is the commonest case where real input is the
 * fix, so the refusal carries the same advice an unconfirmed effect would.
 */
export function macDesktopRefusedNextStep(args: {
  action: string;
  mode: MacDesktopInputMode;
  message: string;
  resolved: MacDesktopElement | null;
  /** The tree the target was resolved against. */
  before: MacDesktopObservation | null;
  button?: string | null;
  count?: number | null;
  lease: MacDesktopLeaseDecision;
}): ComputerUseActionNextStep | null {
  if (args.mode !== "accessibility" || args.action !== "click") return null;
  if (!/answered no press action/i.test(args.message)) return null;
  // The driver refuses a disabled element with the same message, but real
  // input cannot enable it; waiting is the only honest advice.
  if (args.resolved && args.resolved.enabled === false) return disabledObserveStep();
  return browserPageStep(args.resolved, args.before) ?? realInputStep(args, "the element has no press action");
}
