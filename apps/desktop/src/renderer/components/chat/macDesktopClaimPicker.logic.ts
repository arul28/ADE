/**
 * What the claim picker shows, as data.
 *
 * The picker is the answer to "put something on this lane's screen", and every
 * judgement it makes is about one window row at a time: where that window is
 * sitting right now, whether this lane is allowed to take it, and whether the
 * lane already holds a lease on it. Those three questions are here rather than
 * in JSX so a row can be asserted without a driver, a display, or a Mac.
 *
 * Deliberately NOT here: app icons. The service returns a `bundleId` and
 * nothing else, and inventing an icon channel for a picker that opens for two
 * seconds is a worse trade than a neutral glyph, so rows carry the bundle id
 * and the renderer draws the app's initials.
 */

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";

export type MacDesktopClaimLocation =
  /** On the user's own desk. The normal, claimable case. */
  | { kind: "main"; label: string }
  /** Already on this lane's screen. */
  | { kind: "this-lane"; label: string }
  /** Parked on another lane's screen. */
  | { kind: "other-lane"; label: string };

export type MacDesktopClaimRow = {
  window: MacDesktopWindow;
  /** The window's own name, or the app name when it has no title. */
  title: string;
  appName: string;
  bundleId: string | null;
  location: MacDesktopClaimLocation;
  /** True when this lane holds the window (ADE lease chip). */
  hasLease: boolean;
  minimized: boolean;
  disabled: boolean;
  /** Why the row cannot be clicked, for the tooltip. `null` when enabled. */
  disabledReason: string | null;
};

export type MacDesktopClaimGroup = {
  /** Group key: the bundle id when there is one, else the app name. */
  key: string;
  appName: string;
  bundleId: string | null;
  rows: MacDesktopClaimRow[];
};

/**
 * Whether this lane holds a window, which is what the "ADE lease" chip means.
 *
 * `adopted` is excluded on purpose: the driver marks a window adopted when it
 * found it already sitting on the lane's display without ADE having put it
 * there, which is an observation, not a lease.
 */
export function macDesktopHasLease(
  window: MacDesktopWindow,
  laneId: string,
): boolean {
  if (window.laneId !== laneId) return false;
  return window.origin === "ade_launched" || window.origin === "claimed";
}

export function macDesktopClaimTitle(window: MacDesktopWindow): string {
  const title = window.title?.trim();
  return title && title.length ? title : window.appName;
}

/**
 * Where a window is sitting, in the user's vocabulary.
 *
 * A window carries its lane id after it has been released, so the display it is
 * actually on is what decides — `laneId` alone would report a released window
 * as parked somewhere it is not.
 */
export function macDesktopClaimLocation(
  window: MacDesktopWindow,
  args: { laneId: string; displayId: number | null | undefined; laneNames?: Readonly<Record<string, string>> },
): MacDesktopClaimLocation {
  if (window.onDisplayId == null) return { kind: "main", label: "Main display" };
  if (args.displayId != null && window.onDisplayId === args.displayId) {
    return { kind: "this-lane", label: "This lane's screen" };
  }
  // A display id alone does not mean "a lane's screen": the driver answers with
  // the CoreGraphics id of whatever display contains the window, so the user's
  // own monitor comes back as a number too. Only a lane holder makes a window
  // ADE's, and reading the id as ownership labelled every ordinary window on
  // the Mac "ADE · another lane".
  const holder = window.laneId;
  if (!holder || holder === args.laneId) return { kind: "main", label: "Main display" };
  const name = args.laneNames?.[holder] ?? holder.slice(0, 8);
  return { kind: "other-lane", label: `ADE · ${name}` };
}

/**
 * Whether this lane may take the window.
 *
 * One rule, and it is the app's, not ours: an app that refuses to run twice can
 * only be held by one lane at a time, so a single-instance window owned by
 * somebody else is locked rather than claimable. Everything else — parked on
 * another lane's screen, minimized — is a move this lane is allowed to make.
 */
export function macDesktopClaimDisabled(
  window: MacDesktopWindow,
  args: { laneId: string; displayId: number | null | undefined; laneNames?: Readonly<Record<string, string>> },
): { disabled: boolean; reason: string | null } {
  if (window.laneId && window.laneId !== args.laneId && window.singleInstance) {
    const name = args.laneNames?.[window.laneId] ?? window.laneId.slice(0, 8);
    return { disabled: true, reason: `held by ${name}` };
  }
  const location = macDesktopClaimLocation(window, args);
  if (location.kind === "this-lane") {
    return { disabled: true, reason: "already on this screen" };
  }
  return { disabled: false, reason: null };
}

export function macDesktopClaimRow(
  window: MacDesktopWindow,
  args: { laneId: string; displayId: number | null | undefined; laneNames?: Readonly<Record<string, string>> },
): MacDesktopClaimRow {
  const { disabled, reason } = macDesktopClaimDisabled(window, args);
  return {
    window,
    title: macDesktopClaimTitle(window),
    appName: window.appName,
    bundleId: window.bundleId,
    location: macDesktopClaimLocation(window, args),
    hasLease: macDesktopHasLease(window, args.laneId),
    minimized: window.minimized,
    disabled,
    disabledReason: reason,
  };
}

/** Case-insensitive match over the three things a person would type. */
export function macDesktopClaimMatches(row: MacDesktopClaimRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.appName, row.title, row.bundleId ?? ""]
    .some((value) => value.toLowerCase().includes(needle));
}

/**
 * Every claimable window, grouped by app.
 *
 * Groups are ordered by app name and rows inside a group by title, so the list
 * does not reshuffle under the cursor when a refresh returns the same windows
 * in whatever order the window server felt like. Locked rows stay in the list:
 * "Xcode is held by another lane" is the answer the user came for, and hiding
 * it would read as "Xcode is not open".
 */
export function macDesktopClaimGroups(
  windows: readonly MacDesktopWindow[],
  args: {
    laneId: string;
    displayId: number | null | undefined;
    laneNames?: Readonly<Record<string, string>>;
    query?: string;
  },
): MacDesktopClaimGroup[] {
  const groups = new Map<string, MacDesktopClaimGroup>();
  for (const window of windows) {
    const row = macDesktopClaimRow(window, args);
    if (row.location.kind === "this-lane") continue;
    if (!macDesktopClaimMatches(row, args.query ?? "")) continue;
    const key = window.bundleId ?? window.appName;
    const group = groups.get(key)
      ?? { key, appName: window.appName, bundleId: window.bundleId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.rows.sort((a, b) => a.title.localeCompare(b.title) || a.window.id - b.window.id);
  }
  ordered.sort((a, b) => a.appName.localeCompare(b.appName));
  return ordered;
}

/** The rows in the order the arrow keys walk them. */
export function macDesktopClaimFlatRows(
  groups: readonly MacDesktopClaimGroup[],
): MacDesktopClaimRow[] {
  return groups.flatMap((group) => group.rows);
}

/**
 * The next row an arrow key should land on.
 *
 * Skips disabled rows so Down never parks the cursor on something Enter cannot
 * act on, and returns -1 when every row is locked rather than looping forever.
 */
export function macDesktopClaimNextIndex(
  rows: readonly MacDesktopClaimRow[],
  current: number,
  step: 1 | -1,
): number {
  if (!rows.length) return -1;
  for (let moved = 1; moved <= rows.length; moved += 1) {
    const index = (current + step * moved + rows.length * (moved + 1)) % rows.length;
    if (!rows[index]?.disabled) return index;
  }
  return -1;
}

/** Two letters for the neutral app glyph, from the app name. */
export function macDesktopAppInitials(appName: string): string {
  const words = appName.trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}
