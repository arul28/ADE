/**
 * What the claim picker shows, as data.
 *
 * The picker is the answer to "put something on this lane's screen", and every
 * judgement it makes is about one window row at a time: where that window is
 * sitting right now, whether this lane is allowed to take it, and whether the
 * lane already holds a lease on it. Those three questions are here rather than
 * in JSX so a row can be asserted without a driver, a display, or a Mac.
 *
 * App icons: the driver attaches a 32x32 base64 PNG (`iconPng`) to the FIRST
 * window of each bundle id in a `window.list` reply, so a Mac with forty
 * windows across eight apps pays for eight icons and not forty. Joining that
 * back onto every row of the same app is this file's job
 * (`macDesktopClaimAppIcons`), which is why a row carries a resolved
 * `iconPng` and the table never has to know about the wire's frugality.
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
  /**
   * True when the window has no name of its own, so `title` is only the app
   * name again. The Window cell still prints that name in normal text — the
   * words "Untitled window" say nothing a person can use, and a blank cell
   * reads as a bug.
   */
  untitled: boolean;
  appName: string;
  bundleId: string | null;
  /** The app's icon as a `data:`-ready base64 PNG, joined across the app's rows. */
  iconPng: string | null;
  location: MacDesktopClaimLocation;
  /** True when this lane holds the window (ADE lease chip). */
  hasLease: boolean;
  minimized: boolean;
  disabled: boolean;
  /** Why the row cannot be clicked, for the tooltip. `null` when enabled. */
  disabledReason: string | null;
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

/** A window with no name of its own — including one named after its app. */
export function macDesktopClaimIsUntitled(window: MacDesktopWindow): boolean {
  const title = window.title?.trim() ?? "";
  if (!title.length) return true;
  return title.toLowerCase() === window.appName.trim().toLowerCase();
}

/**
 * Whether the window server gave this entry a name at all.
 *
 * Deliberately NOT `!macDesktopClaimIsUntitled`: that one also calls a window
 * named after its app untitled, which is a LABELLING judgement ("Activity
 * Monitor" under a header that already says Activity Monitor is the app name
 * twice). Using it to decide which of an app's entries are scratch surfaces
 * was the bug — Activity Monitor, Music and Grok Bot name their real window
 * after themselves, so the app read as "has no titled window", its nameless
 * menu-bar strips were kept, and each app appeared twice.
 */
function macDesktopClaimHasName(window: MacDesktopWindow): boolean {
  return Boolean(window.title?.trim().length);
}

/**
 * The apps this picker never offers: ADE itself.
 *
 * Claiming ADE's own window drags the window the user is looking at onto a
 * screen they are not looking at. The dev build runs under Electron's bundle
 * id and the shipped one under ADE's, and both are ADE.
 */
export const MAC_DESKTOP_SELF_BUNDLE_IDS: readonly string[] = [
  "com.ade.desktop",
  "com.github.Electron",
  "com.electron.ade",
];

export function macDesktopClaimIsSelf(window: MacDesktopWindow): boolean {
  const bundleId = window.bundleId?.trim().toLowerCase();
  if (bundleId) {
    return MAC_DESKTOP_SELF_BUNDLE_IDS.some((id) => id.toLowerCase() === bundleId);
  }
  // No bundle id is the Electron dev app's own shape often enough to matter,
  // and "Electron" is not an app anybody parks on purpose.
  const appName = window.appName.trim().toLowerCase();
  return appName === "electron" || appName === "ade";
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
  return { kind: "other-lane", label: `Lane: ${name}` };
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
    return { disabled: true, reason: `Held by ${name}` };
  }
  const location = macDesktopClaimLocation(window, args);
  if (location.kind === "this-lane") {
    return { disabled: true, reason: "already on this screen" };
  }
  return { disabled: false, reason: null };
}

export function macDesktopClaimRow(
  window: MacDesktopWindow,
  args: {
    laneId: string;
    displayId: number | null | undefined;
    laneNames?: Readonly<Record<string, string>>;
    /** Bundle key → base64 PNG, from `macDesktopClaimAppIcons`. */
    icons?: Readonly<Record<string, string>>;
  },
): MacDesktopClaimRow {
  const { disabled, reason } = macDesktopClaimDisabled(window, args);
  return {
    window,
    title: macDesktopClaimTitle(window),
    untitled: macDesktopClaimIsUntitled(window),
    appName: window.appName,
    bundleId: window.bundleId,
    iconPng: args.icons?.[macDesktopClaimAppKey(window)] ?? window.iconPng ?? null,
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
 * The windows worth showing, before any lane judgement is made.
 *
 * The window server's list is not a list of windows a person has: one TextEdit
 * with one document answered with nine identical rows, its own hidden service
 * windows, and a Cursor install contributed thirteen `CursorUIViewService`
 * entries. The driver drops the ones it can see through (dead pids, zero-size
 * surfaces, untitled windows of non-regular apps); these three rules are the
 * half that needs the whole list to decide:
 *
 * * ADE's own windows never appear — claiming them moves the window the user
 *   is looking at onto a screen they are not;
 * * an app's untitled windows are dropped when that app also has a titled
 *   one, because then the untitled ones are its scratch windows; an app whose
 *   windows are *all* untitled still gets its rows, or a running app would
 *   simply be missing;
 * * windows identical in pid, title and frame collapse to one — the same
 *   window seen twice is not two things to choose between.
 */
export function macDesktopClaimVisibleWindows(
  windows: readonly MacDesktopWindow[],
): MacDesktopWindow[] {
  const candidates = windows.filter((window) => !macDesktopClaimIsSelf(window));
  const appsWithTitledWindow = new Set(
    candidates
      .filter((window) => macDesktopClaimHasName(window))
      .map((window) => window.bundleId ?? window.appName),
  );
  const seen = new Set<string>();
  const kept: MacDesktopWindow[] = [];
  for (const window of candidates) {
    const appKey = window.bundleId ?? window.appName;
    if (!macDesktopClaimHasName(window) && appsWithTitledWindow.has(appKey)) continue;
    const { x, y, width, height } = window.frame;
    const identity = [
      window.pid,
      macDesktopClaimTitle(window),
      x,
      y,
      width,
      height,
    ].join("\u0000");
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(window);
  }
  return kept;
}

/** The key an app is counted by: its bundle id, or its name when it has none. */
export function macDesktopClaimAppKey(window: MacDesktopWindow): string {
  return window.bundleId ?? window.appName;
}

/**
 * Bundle key → icon, gathered from whichever window of the app carried one.
 *
 * The driver sends the PNG once per app per reply (see the file header), so
 * every other row of that app arrives with `iconPng` null and would draw a
 * blank square if a row only looked at itself.
 */
export function macDesktopClaimAppIcons(
  windows: readonly MacDesktopWindow[],
): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const window of windows) {
    const icon = window.iconPng?.trim();
    if (!icon) continue;
    const key = macDesktopClaimAppKey(window);
    if (!icons[key]) icons[key] = icon;
  }
  return icons;
}

/**
 * Every claimable window, as one flat table body.
 *
 * Sorted by app and then by window title so the table does not reshuffle under
 * the cursor when a refresh returns the same windows in whatever order the
 * window server felt like. There are no group header rows: the app is a
 * column, which is what makes this a table like the rest of ADE rather than an
 * outline with a lonely count on every second line.
 *
 * Locked rows stay in the list: "Xcode is held by another lane" is the answer
 * the user came for, and hiding it would read as "Xcode is not open".
 */
export function macDesktopClaimRows(
  windows: readonly MacDesktopWindow[],
  args: {
    laneId: string;
    displayId: number | null | undefined;
    laneNames?: Readonly<Record<string, string>>;
    query?: string;
  },
): MacDesktopClaimRow[] {
  const icons = macDesktopClaimAppIcons(windows);
  const rows: MacDesktopClaimRow[] = [];
  for (const window of macDesktopClaimVisibleWindows(windows)) {
    const row = macDesktopClaimRow(window, { ...args, icons });
    if (row.location.kind === "this-lane") continue;
    if (!macDesktopClaimMatches(row, args.query ?? "")) continue;
    rows.push(row);
  }
  rows.sort((a, b) =>
    a.appName.localeCompare(b.appName)
    || a.title.localeCompare(b.title)
    || a.window.id - b.window.id);
  return rows;
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

