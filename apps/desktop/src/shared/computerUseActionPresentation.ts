/**
 * The words and layout of computer-use action rows, built from the summaries
 * `computerUseActionSummary.ts` reads out of a shell command.
 *
 * Shared by the desktop/web transcript; the iOS app ports it to Swift in
 * `apps/ios/ADE/Views/Work/WorkComputerUsePresentation.swift`. Keep them in step:
 * the same action must read the same on the phone and on the desktop.
 */

import type {
  ComputerUseActionPlace,
  ComputerUseActionSummary,
} from "./computerUseActionSummary";

export type ComputerUseSurfaceGlyph = "screen" | "app" | "globe" | "user" | "apple" | "proof";

/**
 * One action as one line: "Clicked “Save” in TextEdit using Mac Desktop".
 * Each part carries what a renderer needs to draw its icon.
 */
export type ComputerUseActionParts = {
  /** "Clicked", "Clicking", "Couldn't click". */
  lead: string;
  target: string | null;
  targetQuoted: boolean;
  place: ComputerUseActionPlace | null;
  using: { label: string; glyph: ComputerUseSurfaceGlyph; warning: boolean } | null;
  /** "· on PR #12". */
  suffix: string | null;
};

export function computerUseActionParts(summary: ComputerUseActionSummary): ComputerUseActionParts {
  const verbPhrase = summary.outcome === "running"
    ? summary.progressive
    : summary.outcome === "failed"
      ? `Couldn't ${summary.infinitive}`
      : summary.past;
  // With no target, a look names what it looked at ("Looked at the screen");
  // any other verb drops its dangling preposition ("Took a screenshot").
  const lookedAt = summary.verb === "observe" || summary.verb === "snapshot";
  const lead = summary.target
    ? verbPhrase
    : lookedAt
      ? `${verbPhrase} ${summary.domain === "browser" ? "the page" : "the screen"}`
      : verbPhrase.replace(/\s+(?:of|at|for|to|in)$/, "");
  // "Connected to your Chrome on studio-mac": the browser is already the object.
  if (summary.verb === "attach") {
    return {
      lead,
      target: summary.target,
      targetQuoted: summary.targetQuoted,
      place: summary.hostLabel ? { preposition: "on", label: summary.hostLabel, kind: "other" } : null,
      using: null,
      suffix: null,
    };
  }
  return {
    lead,
    target: summary.target,
    targetQuoted: summary.targetQuoted,
    place: summary.place,
    using: computerUseSurfaceLabel(summary),
    suffix: summary.proof?.prNumber != null ? `· on PR #${summary.proof.prNumber}` : null,
  };
}

/** The sentence as plain text, for titles, labels, and accessibility. */
export function computerUseActionText(summary: ComputerUseActionSummary): string {
  const parts = computerUseActionParts(summary);
  const target = parts.target ? (parts.targetQuoted ? `“${parts.target}”` : parts.target) : null;
  const place = parts.place ? `${parts.place.preposition} ${parts.place.label}` : null;
  const using = parts.using ? `using ${parts.using.label}` : null;
  const text = [parts.lead, target, place, using, parts.suffix].filter(Boolean).join(" ");
  return summary.outcome === "running" ? `${text}…` : text;
}

/** The "using …" part of a row: which surface, in whose hands. */
export function computerUseSurfaceLabel(summary: ComputerUseActionSummary): {
  label: string;
  glyph: ComputerUseSurfaceGlyph;
  /** The user's own browser: amber, because the agent acted outside its lane. */
  warning: boolean;
} {
  switch (summary.surface) {
    case "lane_screen":
      return {
        label: summary.screenProduct === "windows"
          ? "Windows Desktop"
          : summary.screenProduct === "mac" ? "Mac Desktop" : "the lane screen",
        glyph: "screen",
        warning: false,
      };
    case "app_control":
      return { label: "App Control", glyph: "app", warning: false };
    case "ade_browser":
      return { label: "ADE browser", glyph: "globe", warning: false };
    case "user_browser": {
      const browser = `your ${summary.browserName ?? "browser"}`;
      return {
        label: summary.hostLabel ? `${browser} on ${summary.hostLabel}` : browser,
        glyph: "user",
        warning: true,
      };
    }
    case "apple_device":
      return { label: summary.device?.name || "the simulator", glyph: "apple", warning: false };
    case "proof":
      return { label: "ADE proof", glyph: "proof", warning: false };
  }
}

/** The one-line note under a full row, when there is something to say. */
export function computerUseOutcomeNote(summary: ComputerUseActionSummary): { text: string; tone: "danger" | "warning" } | null {
  if (summary.outcome === "failed") {
    return summary.reason ? { text: summary.reason, tone: "danger" } : null;
  }
  if (summary.outcome === "unconfirmed") {
    return { text: "Sent, but no change seen yet", tone: "warning" };
  }
  return null;
}

export type ComputerUseRunItem<T> =
  | { kind: "action"; action: T; summary: ComputerUseActionSummary }
  | { kind: "app_fold"; appName: string; actions: Array<{ action: T; summary: ComputerUseActionSummary }> };

/**
 * Lay out one run of actions: every earlier action as a compact line, with
 * consecutive confirmed actions in the same app, through the same surface,
 * folded into one "Notes · 4 actions" line, and the latest action drawn in
 * full. The fold names one surface, so a run that changed machine, browser,
 * screen product or device mid-way does not fold across the change. A failed or
 * unconfirmed action never folds: it is the line a reader must see.
 *
 * Apple actions that named no device borrow the last device named earlier in
 * the run (the device is usually printed once, by `apple start`).
 */
export function layoutComputerUseRun<T>(
  actions: ReadonlyArray<{ action: T; summary: ComputerUseActionSummary }>,
): { earlier: Array<ComputerUseRunItem<T>>; latest: { action: T; summary: ComputerUseActionSummary } | null } {
  if (actions.length === 0) return { earlier: [], latest: null };
  let lastDevice: ComputerUseActionSummary["device"] = null;
  const withDevices = actions.map((entry) => {
    const { summary } = entry;
    if (summary.surface !== "apple_device") return entry;
    if (summary.device?.name) {
      lastDevice = summary.device;
      return entry;
    }
    if (!lastDevice) return entry;
    return { ...entry, summary: { ...summary, device: { name: lastDevice.name, os: summary.device?.os ?? lastDevice.os } } };
  });
  const latest = withDevices[withDevices.length - 1]!;
  const earlier: Array<ComputerUseRunItem<T>> = [];
  const foldable = (summary: ComputerUseActionSummary) =>
    Boolean(summary.appName) && summary.outcome !== "failed" && summary.outcome !== "unconfirmed";
  // The surface label carries the screen product, the user browser and its
  // machine, and the Apple device: two actions fold only when every part matches.
  const foldKey = (summary: ComputerUseActionSummary) =>
    `${summary.appName!.toLowerCase()}\u0000${summary.surface}\u0000${computerUseSurfaceLabel(summary).label}`;
  let index = 0;
  const compact = withDevices.slice(0, -1);
  while (index < compact.length) {
    const first = compact[index]!;
    if (!foldable(first.summary)) {
      earlier.push({ kind: "action", ...first });
      index += 1;
      continue;
    }
    const key = foldKey(first.summary);
    let end = index + 1;
    while (end < compact.length && foldable(compact[end]!.summary) && foldKey(compact[end]!.summary) === key) end += 1;
    if (end - index >= 2) {
      earlier.push({ kind: "app_fold", appName: first.summary.appName!, actions: compact.slice(index, end) });
    } else {
      earlier.push({ kind: "action", ...first });
    }
    index = end;
  }
  return { earlier, latest };
}
