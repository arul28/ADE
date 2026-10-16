/**
 * The words and layout of computer-use action rows, built from the summaries
 * `computerUseActionSummary.ts` reads out of a shell command.
 *
 * Shared by the desktop/web transcript; the iOS app ports it to Swift in
 * `apps/ios/ADE/Views/Work/WorkComputerUsePresentation.swift`. Keep them in step:
 * the same action must read the same on the phone and on the desktop.
 */

import {
  launchesAppControl,
  type ComputerUseActionPlace,
  type ComputerUseActionSummary,
} from "./computerUseActionSummary";

export type ComputerUseSurfaceGlyph = "screen" | "app" | "globe" | "user" | "apple" | "proof";

/**
 * One action as one line, naming what it acted on: "Clicked “Save” in
 * TextEdit", "Pressed ⌘Space on Mac Desktop". Each part carries what a
 * renderer needs to draw its icon.
 */
export type ComputerUseActionParts = {
  /** "Clicked", "Clicking", "Couldn't click". */
  lead: string;
  target: string | null;
  targetQuoted: boolean;
  place: ComputerUseActionPlace | null;
  /** The surface, only when nothing else says where: "on Mac Desktop", "using your Chrome". */
  surface: { preposition: "on" | "using"; label: string; glyph: ComputerUseSurfaceGlyph; warning: boolean } | null;
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
  // A look at a whole screen or simulator names it: "Looked at Mac Desktop".
  const looksAtSurface = lookedAt && !summary.target
    && (summary.surface === "lane_screen" || summary.surface === "apple_device");
  const lead = summary.target
    ? verbPhrase
    : lookedAt
      ? `${verbPhrase} ${
        looksAtSurface ? computerUseSurfaceLabel(summary).label : summary.domain === "browser" ? "the page" : "the screen"
      }`
      : launchesAppControl(summary.verb, summary.domain)
        // "Launched the app": App Control could not tell which.
        ? `${verbPhrase} the app`
        : verbPhrase.replace(/\s+(?:of|at|for|to|in)$/, "");
  // "Connected to your Chrome on studio-mac": the browser is already the object.
  if (summary.verb === "attach") {
    return {
      lead,
      target: summary.target,
      targetQuoted: summary.targetQuoted,
      place: summary.hostLabel ? { preposition: "on", label: summary.hostLabel, kind: "other" } : null,
      surface: null,
      suffix: null,
    };
  }
  return {
    lead,
    target: summary.target,
    targetQuoted: summary.targetQuoted,
    place: summary.place,
    surface: looksAtSurface ? null : computerUseWhere(summary),
    suffix: summary.proof?.postedToPr != null
      ? `· posted to PR #${summary.proof.postedToPr}`
      : summary.proof?.prNumber != null ? `· on PR #${summary.proof.prNumber}` : null,
  };
}

/** The sentence as plain text, for titles, labels, and accessibility. */
export function computerUseActionText(summary: ComputerUseActionSummary): string {
  const parts = computerUseActionParts(summary);
  const target = parts.target ? (parts.targetQuoted ? `“${parts.target}”` : parts.target) : null;
  const place = parts.place ? `${parts.place.preposition} ${parts.place.label}` : null;
  const surface = parts.surface ? `${parts.surface.preposition} ${parts.surface.label}` : null;
  const text = [parts.lead, target, place, surface, parts.suffix].filter(Boolean).join(" ");
  return summary.outcome === "running" ? `${text}…` : text;
}

/**
 * Where the action happened, when the line does not already say it. An app the
 * action touched is the place to name ("in TextEdit"), so a surface shows only
 * when no app is known: App Control always drives one app and never names
 * itself; a screen or simulator names itself for a screen-level action ("on
 * iPhone 17"); a page names its site; proof is ADE's own and needs no name.
 * The user's own browser always shows, in amber, because the agent acted
 * outside its lane.
 */
function computerUseWhere(summary: ComputerUseActionSummary): ComputerUseActionParts["surface"] {
  const surface = computerUseSurfaceLabel(summary);
  const namesApp = Boolean(summary.appName) && (summary.place?.kind === "app" || summary.target === summary.appName);
  switch (summary.surface) {
    case "app_control":
    case "proof":
      return null;
    case "lane_screen":
    case "apple_device":
      return namesApp ? null : { preposition: "on", ...surface };
    case "ade_browser":
      return summary.place ? null : { preposition: "using", ...surface };
    case "user_browser":
      return { preposition: "using", ...surface };
  }
}

/** Which surface an action used, in whose hands. */
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

/**
 * The proof a row shows as a small picture under its line: the record a
 * capture or attach filed, once it is known to be filed.
 */
export function computerUseShownProofIds(summary: ComputerUseActionSummary): readonly string[] {
  if (!summary.proof || summary.verb === "proof publish") return [];
  if (summary.outcome === "failed" || summary.outcome === "running") return [];
  return summary.proof.artifactIds;
}

/** The one-line note under a full row, when there is something to say. */
export function computerUseOutcomeNote(summary: ComputerUseActionSummary): { text: string; tone: "danger" | "warning" } | null {
  if (summary.outcome === "failed") {
    return summary.reason ? { text: summary.reason, tone: "danger" } : null;
  }
  if (summary.outcome === "unconfirmed") {
    // A proof says why ADE could not confirm it; an input, that nothing changed.
    return { text: (summary.proof && summary.reason) || "Sent, but no change seen yet", tone: "warning" };
  }
  return null;
}

/** One drawn line: an action, and how many identical actions in a row it stands for. */
export type ComputerUseRunLine<T> = { action: T; summary: ComputerUseActionSummary; count: number };

/** An App Control action that named no app, told the app the run is driving. */
function withCarriedApp(summary: ComputerUseActionSummary, appName: string): ComputerUseActionSummary {
  // "Looked at ADE", "Launched ADE": the app is the object.
  const namesApp = summary.verb === "observe" || summary.verb === "snapshot" || launchesAppControl(summary.verb, summary.domain);
  if (namesApp && !summary.target) {
    return { ...summary, appName, target: appName, targetQuoted: false, place: null };
  }
  const place = summary.place ?? (summary.target === appName ? null : { preposition: "in", label: appName, kind: "app" as const });
  return { ...summary, appName, place };
}

/**
 * Two actions merge into one "×N" line when this matches: the same words, the
 * same ending, and the same proof records (two captures with one caption are
 * two pictures, never one line).
 */
function runLineKey(summary: ComputerUseActionSummary): string {
  return [summary.outcome, computerUseActionText(summary), ...(summary.proof?.artifactIds ?? [])].join("\u0000");
}

/** A `proof publish` that posted to a PR, and the records it posted. */
function publishedProof(summary: ComputerUseActionSummary): { prNumber: number; ids: string[] } | null {
  if (summary.verb !== "proof publish" || summary.outcome === "failed" || summary.outcome === "running") return null;
  const prNumber = summary.proof?.prNumber;
  const ids = summary.proof?.artifactIds ?? [];
  return prNumber != null && ids.length ? { prNumber, ids } : null;
}

/**
 * Lay out one run of actions as plain lines, the latest drawn in full.
 *
 * - Apple actions that named no device borrow the last device named earlier in
 *   the run (the device is usually printed once, by `apple start`).
 * - App Control actions that named no app borrow the last app named earlier:
 *   one App Control session drives one app, but only some commands print its
 *   window title.
 * - Consecutive actions that read the same, ended the same and filed the same
 *   proof merge into one line with a count ("Looked at ADE ×3").
 * - Posting proof to a PR adds to the line that filed it ("Filed proof “Login”
 *   · posted to PR #12") instead of a line of its own, when every record it
 *   posted was filed earlier in the run.
 */
export function layoutComputerUseRun<T>(
  actions: ReadonlyArray<{ action: T; summary: ComputerUseActionSummary }>,
): { earlier: Array<ComputerUseRunLine<T>>; latest: ComputerUseRunLine<T> | null } {
  if (actions.length === 0) return { earlier: [], latest: null };
  let lastDevice: ComputerUseActionSummary["device"] = null;
  let lastApp: string | null = null;
  const lines: Array<ComputerUseRunLine<T> & { key: string }> = [];
  for (const entry of actions) {
    let { summary } = entry;
    if (summary.surface === "apple_device") {
      if (summary.device?.name) lastDevice = summary.device;
      else if (lastDevice) summary = { ...summary, device: { name: lastDevice.name, os: summary.device?.os ?? lastDevice.os } };
    }
    if (summary.surface === "app_control") {
      if (summary.appName) lastApp = summary.appName;
      else if (lastApp) summary = withCarriedApp(summary, lastApp);
    }
    const published = publishedProof(summary);
    if (published) {
      const filed = published.ids.map((id) => lines.findIndex((line) => line.summary.proof?.artifactIds.includes(id) && line.summary.verb !== "proof publish"));
      if (filed.every((index) => index >= 0)) {
        for (const index of new Set(filed)) {
          const line = lines[index]!;
          const posted = { ...line.summary, proof: { ...line.summary.proof!, postedToPr: published.prNumber } };
          lines[index] = { ...line, summary: posted, key: runLineKey(posted) };
        }
        continue;
      }
    }
    const key = runLineKey(summary);
    const last = lines[lines.length - 1];
    if (last && last.key === key) {
      // Keeps the first action, so the line's identity holds while it grows.
      lines[lines.length - 1] = { ...last, summary, count: last.count + 1 };
    } else {
      lines.push({ action: entry.action, summary, count: 1, key });
    }
  }
  const drawn = lines.map(({ key: _key, ...line }) => line);
  return { earlier: drawn.slice(0, -1), latest: drawn[drawn.length - 1]! };
}
