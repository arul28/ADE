import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  AppControlSession,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  IosSimulatorSession,
  LaneSummary,
  OpenProjectBinding,
} from "../../../shared/types";
import type { WorkSidebarTab } from "../../state/appStore";
import { browserHostLabel } from "../../lib/browserUrl";
import {
  EMPTY_WORK_TOOL_ERRORS,
  pruneWorkToolBrowserErrors,
  reduceWorkToolBrowserErrors,
  workToolBrowserErrorCount,
  workToolErrorSuffix,
  type WorkToolErrorsByTab,
} from "./workToolErrors";
import { asBuiltInBrowserStatus, isAppControlSessionAttached } from "./useNativeToolSessions";
import {
  getWorkTerminalShellCount,
  subscribeWorkTerminalShells,
} from "./workTerminalShells";
import { useNativeToolFeedHandlers, useNativeToolFeeds } from "./NativeToolFeedsContext";
import type { WorkToolAvailability, WorkToolDefinition } from "./workTools";

/**
 * What a tool has to say about itself on the picker card and in the activity
 * dots — one short line, plus whether something is actually running.
 *
 * `line: null` means "nothing measured": the card says nothing rather than
 * inventing a status or padding the slot with prose. Every field here comes
 * from a read the pane already makes (an event subscription, a one-shot
 * `getStatus`, the lane store); nothing here starts a poller.
 */
export type WorkToolStatus = {
  line: string | null;
  /** Something of this tool's is live right now — a shell, a held tab, a booted sim. */
  live: boolean;
  /**
   * Countable errors this tool is currently showing — console errors and failed
   * requests for the browser's active tab. Turns the activity dot red and adds
   * "· 3 errors" to the picker card. Optional because most tools count nothing;
   * absent and zero mean the same thing, which is not the same as `errored`.
   */
  errorCount?: number;
  /**
   * The tool is in an error STATE with no countable tally — a crashed App
   * Control session, say. Same red dot, no "N errors" suffix, because inventing
   * a count for "it died" would be a lie.
   */
  errored?: boolean;
  /**
   * The tool is waiting on the PERSON, not on itself — a login handoff where
   * the agent has stepped back from the tab. Distinct from `live` (something is
   * running) and from `errored` (something broke): this is the only state whose
   * dot is asking for a hand.
   */
  attention?: boolean;
};

export type WorkToolStatusMap = Partial<Record<WorkSidebarTab, WorkToolStatus>>;

const IDLE: WorkToolStatus = { line: null, live: false, errorCount: 0, errored: false };

/**
 * A status line, on top of `IDLE`'s defaults.
 *
 * Every builder below used to restate `errorCount: 0, errored: false` by hand,
 * so a new optional field meant thirteen edits. Spreading the idle shape states
 * the defaults once and leaves each builder saying only what is different.
 */
function statusLine(line: string | null, live: boolean, extra?: Partial<WorkToolStatus>): WorkToolStatus {
  return { ...IDLE, line, live, ...extra };
}

/** True when a tool's dot should read as a problem rather than as activity. */
export function workToolHasError(status: WorkToolStatus | undefined): boolean {
  return Boolean(status && (status.errored === true || (status.errorCount ?? 0) > 0));
}

/**
 * What an activity dot MEANS, in one word.
 *
 * The dots used to be coloured by which tool they belonged to, which made every
 * dot the same news: "this tool exists". State is the only thing worth a colour
 * here — the tool's own hue still identifies it, but only once the dot has
 * something to say. Shared by the header and the picker so one colour can never
 * mean two things in the same pane.
 */
export type WorkToolDotState = "idle" | "live" | "attention" | "error";

export function workToolDotState(status: WorkToolStatus | undefined): WorkToolDotState {
  if (workToolHasError(status)) return "error";
  if (status?.attention === true) return "attention";
  if (status?.live === true) return "live";
  return "idle";
}

/** Red for broken, amber for "needs you", the tool's own hue for live, muted for idle. */
export const WORK_TOOL_DOT_ERROR_COLOR = "#f87171";
export const WORK_TOOL_DOT_ATTENTION_COLOR = "#fbbf24";

export function workToolDotColor(state: WorkToolDotState, toolColor: string): string {
  switch (state) {
    case "error":
      return WORK_TOOL_DOT_ERROR_COLOR;
    case "attention":
      return WORK_TOOL_DOT_ATTENTION_COLOR;
    case "live":
      return toolColor;
    case "idle":
      return "color-mix(in srgb, var(--color-muted-fg) 45%, transparent)";
  }
}

/**
 * The one line a tool gets, wherever it is shown.
 *
 * The picker card and the header's activity dots both answer "what is this tool
 * doing", and they used to answer it with two different spellings — one that
 * appended the error suffix, one that gated it and then regexed the separator
 * back off. This is the single rule, in priority order: an unavailable tool
 * says why; an available one says its measured status plus any error tally; and
 * a tool that has measured nothing falls back to the catalogue's `hint`.
 *
 * The hint is LAST for a reason — a measured status is always the better answer
 * and a slot carrying both is the over-explained card the picker replaced — but
 * it is resolved HERE rather than at the picker, because the two disagreed
 * otherwise: the card printed "Run a shell here" while the truncation tooltip,
 * whose whole job is to be the rest of the sentence, said only "Terminal".
 *
 * `line` is `null`, never `""`, when there is nothing at all to say, so a
 * caller cannot mistake "no status" for a rendered empty string.
 */
export function workToolSummary(
  definition: WorkToolDefinition,
  status: WorkToolStatus | undefined,
  availability: WorkToolAvailability,
): { line: string | null; tooltipLabel: string } {
  const line = availability.available
    ? (status?.line
      ? `${status.line}${workToolErrorSuffix(status.errorCount ?? 0)}`
      : definition.hint ?? null)
    : availability.reason;
  return { line, tooltipLabel: line ? `${definition.label} — ${line}` : definition.label };
}

/**
 * How this pane shortens a host: keep `www.`, append a non-root path, and fall
 * back to the raw string for anything `new URL` refuses.
 */
const HOST_LABEL_OPTIONS = { stripWww: false, includePath: true, fallbackToRaw: true } as const;

/** How long the picker is allowed to show skeleton lines before committing. */
const STATUS_SETTLE_MS = 300;

function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function browserStatusLine(
  rawStatus: BuiltInBrowserStatus | null,
  laneId: string | null,
  errorCount = 0,
): WorkToolStatus {
  // Exported and called with whatever a feed handed the caller, including the
  // web client's shape-breaking "unsupported" stub — so the array is checked
  // here too rather than trusted from the type.
  const status = asBuiltInBrowserStatus(rawStatus);
  if (!status || status.tabs.length === 0) return statusLine("No tabs", false);
  const activeTab = status.tabs.find((tab) => tab.id === status.activeTabId) ?? status.tabs[0];
  const held = status.tabs.some((tab) => tab.ownerLaneId != null)
    || status.ownerLaneId != null;
  const heldHere = laneId != null
    && (status.ownerLaneId === laneId || status.tabs.some((tab) => tab.ownerLaneId === laneId));
  // With more than one tab the COUNT is the fact ("3 tabs"); the URL of
  // whichever one happens to be active is already in the header above, and a
  // path long enough to be interesting is exactly the thing that truncated the
  // ownership word off the end of this line.
  const label = status.tabs.length > 1
    ? pluralize(status.tabs.length, "tab", "tabs")
    // The pane's one host-shortening rule, shared with the tab pill and the
    // picker card so a tab cannot read `example.com` in one and
    // `www.example.com/x` in the other.
    : browserHostLabel(activeTab?.url ?? status.url, HOST_LABEL_OPTIONS)
      ?? activeTab?.title
      ?? pluralize(status.tabs.length, "tab", "tabs");
  // A login handoff outranks every ownership suffix: while it is open the agent
  // explicitly does NOT hold the tab, and telling the person otherwise is the
  // one thing that would stop them from signing in.
  const handedOff = status.tabs.some((tab) => tab.handoff != null);
  const suffix = handedOff
    ? " · you"
    : heldHere
    ? " · agent"
    : held
      ? " · other lane"
      : "";
  return statusLine(`${label}${suffix}`, true, { errorCount, attention: handedOff });
}

export function gitStatusLine(lane: LaneSummary | null): WorkToolStatus {
  if (!lane?.status) return IDLE;
  const { ahead, behind, dirty, rebaseInProgress } = lane.status;
  if (rebaseInProgress) return statusLine("Rebasing", true);
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  // "dirty" rather than "uncommitted changes": this is a status slot, not a
  // sentence, and at two columns the sentence became "3 ahead · uncommitt…".
  parts.push(dirty ? "dirty" : "clean");
  // Every other tool's line opens with a capital ("No tabs", "Not booted", "No
  // app"), and git was the one that opened lowercase — a column of cards where
  // five lines start capitalised and one does not reads as a typo. Only the
  // first character: a line that already starts with a count ("3 ahead ·
  // clean") is untouched, and the word mid-line stays lowercase.
  return statusLine(capitalizeFirst(parts.join(" · ")), dirty || ahead > 0);
}

function capitalizeFirst(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function iosStatusLine(session: IosSimulatorSession | null): WorkToolStatus {
  if (!session) return statusLine("Not booted", false);
  // The dot already says "booted"; the words are for the device name, which is
  // the part that is long ("iPhone 17 Pro Max") and the part you asked for.
  const device = session.deviceName?.trim() || "Simulator";
  return statusLine(device, true);
}

/**
 * App Control's dot, in three states rather than one.
 *
 * The dot used to be green for any session that had not been stopped, which
 * included a launch terminal whose app has not attached yet and one whose app
 * has since quit — so the header showed a live green dot beside a context line
 * that read "No app". Green now means an app is actually on the other end
 * ({@link isAppControlSessionAttached}); a session that exists but is not
 * driving anything is amber, because it is a thing in flight rather than a
 * thing running; `failed` stays red; and no session at all — or a stopped or
 * exited one — has nothing to say and gets no dot.
 */
export function appControlStatusLine(session: AppControlSession | null): WorkToolStatus {
  if (!session) return statusLine("No app", false);
  const label = session.label?.trim() || "App";
  const attached = isAppControlSessionAttached(session);
  // Terminal states are the tool's idle: the session is a record of something
  // that finished, not something to point at.
  const settled = session.status === "stopped" || session.status === "exited";
  return statusLine(label, attached, {
    // App Control has no pushed console/network tally today, so its red dot is
    // driven by the one error state its session reports.
    errored: session.status === "failed",
    attention: !attached && !settled && session.status !== "failed",
  });
}

/**
 * The shell count, from whichever source can actually see the shells.
 *
 * `panelCount` is what the terminal panel is rendering right now, split pane
 * included; it is authoritative whenever the panel is mounted, because it is
 * literally the list on screen. `titles` is the pane's own `terminal.list`
 * read, used only when no panel is mounted — the header still has to describe
 * a tool you are not looking at. `null` from both means nothing measured.
 */
export function terminalStatusLine(
  titles: readonly string[] | null,
  panelCount: number | null = null,
): WorkToolStatus {
  const count = panelCount ?? titles?.length ?? null;
  if (count == null) return IDLE;
  if (count === 0) return statusLine("No shells", false);
  // Shell titles are unbounded ("npm run dev -w apps/desktop"), and appending
  // even one of them turned this into "Shells attache…" at 526px. The count is
  // the whole status; the tab strip below names them.
  return statusLine(pluralize(count, "shell", "shells"), true);
}

/**
 * Files measures nothing of its own, so it reports the one fact the lane store
 * already carries: whether the worktree is dirty. `LaneSummary.status` holds a
 * BOOLEAN, not a tally, so this says "Changes" rather than inventing "14
 * changed" — a real count is a git read the pane would then have to keep fresh.
 * With no lane status at all the slot names the surface instead of guessing.
 */
export function filesStatusLine(lane: LaneSummary | null): WorkToolStatus {
  if (!lane?.status) return statusLine("Worktree", false);
  return statusLine(lane.status.dirty ? "Changes" : "Clean", false);
}

/**
 * Live status for every tool in the pane.
 *
 * Subscriptions run for as long as the pane is mounted and reachable, not only
 * while a given tool is on screen: the picker cards and the header's activity
 * dots both need to know what the tools you are NOT looking at are doing. They
 * are event subscriptions plus one `getStatus` each — the same reads the pane
 * already made per tab, just not torn down on every switch.
 */
export function useWorkToolStatuses(args: {
  enabled: boolean;
  laneId: string | null;
  lane: LaneSummary | null;
  runtimePin: OpenProjectBinding | null;
  /** Chat/CLI session that owns the attached terminals, if any. */
  terminalOwnerSessionId: string | null;
  /**
   * The tool on screen, or null for the picker page.
   *
   * Only ever a re-read TRIGGER, never part of an answer: arriving at the
   * picker is the one moment every card is about to be read at once, so the
   * shell list is refreshed then rather than shown at whatever age it happened
   * to be.
   */
  activeTool?: WorkSidebarTab | null;
}): {
  statuses: WorkToolStatusMap;
  loading: boolean;
  /**
   * The raw sessions behind the iOS / App Control lines. The pane needs the
   * owning lane id (not just the prose) to decide whether the tool it is about
   * to render belongs to a different lane and needs its attribution banner.
   */
  iosSession: IosSimulatorSession | null;
  appControlSession: AppControlSession | null;
} {
  const { enabled, laneId, lane, runtimePin, terminalOwnerSessionId, activeTool = null } = args;

  const [browserErrors, setBrowserErrors] = useState<WorkToolErrorsByTab>(EMPTY_WORK_TOOL_ERRORS);
  const [terminalTitles, setTerminalTitles] = useState<string[] | null>(null);
  const [settled, setSettled] = useState(false);

  const runtimePinKey = runtimePin?.key ?? null;
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  // The error tally is pushed by the service on change and zeroed on a
  // main-frame navigation, so the badge clears itself without a poll.
  const onBrowserEvent = useCallback((event: BuiltInBrowserEventPayload) => {
    if (event.type === "diagnostics") {
      setBrowserErrors((current) => reduceWorkToolBrowserErrors(current, event));
      return;
    }
    const next = asBuiltInBrowserStatus((event as { status?: unknown }).status);
    // A closed tab must not keep a dot red for a page nobody can reach.
    if (next) setBrowserErrors((current) => pruneWorkToolBrowserErrors(current, next));
  }, []);

  // The page's one subscription set, shared with the live corner card: the
  // capability gate, the "unsupported stub" boundary check, the offline guard
  // and the feed teardown all live in `NativeToolFeedsProvider`. This hook adds
  // one handler to its fan-out; it opens nothing of its own.
  const {
    browserStatus,
    iosSession,
    appControlSession,
    canBrowser,
    offline,
  } = useNativeToolFeeds();
  useNativeToolFeedHandlers(useMemo(() => ({ onBrowserEvent }), [onBrowserEvent]));

  useEffect(() => {
    if (!enabled || offline || !canBrowser) setBrowserErrors(EMPTY_WORK_TOOL_ERRORS);
  }, [canBrowser, enabled, offline]);

  // One grace window, not one per read: the picker commits its lines after
  // 300ms whatever the slowest namespace is doing, so a wedged machine can
  // never leave a grid of shimmering placeholders.
  useEffect(() => {
    if (!enabled) return undefined;
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), STATUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, laneId, runtimePinKey, terminalOwnerSessionId]);

  // Attached shells have no dedicated status event, so the list is re-read
  // whenever one could have changed: a session is created/deleted, or a PTY
  // exits. Still not a poll — every re-read is caused by something that
  // happened. Before this the header could say "No shells" for the lifetime of
  // the pane while a shell you had just started scrolled past underneath it.
  // The count the terminal PANEL is showing, when one is mounted. Subscribed
  // rather than polled: the panel publishes on every tab change, so opening a
  // shell or splitting one moves this line in the same commit that draws it.
  const panelShellCount = useSyncExternalStore(
    subscribeWorkTerminalShells,
    () => getWorkTerminalShellCount(terminalOwnerSessionId),
    () => null,
  );

  const [terminalEpoch, setTerminalEpoch] = useState(0);
  useEffect(() => {
    if (!enabled || offline || !terminalOwnerSessionId) return undefined;
    const bump = () => setTerminalEpoch((epoch) => epoch + 1);
    const disposers: Array<(() => void) | undefined> = [
      window.ade?.sessions?.onChanged?.(bump),
      window.ade?.pty?.onExit?.(bump, runtimePinRef.current),
    ];
    return () => {
      for (const dispose of disposers) dispose?.();
    };
  }, [enabled, offline, runtimePinKey, terminalOwnerSessionId]);

  useEffect(() => {
    if (!enabled || offline || !terminalOwnerSessionId) {
      setTerminalTitles(null);
      return undefined;
    }
    const terminal = window.ade?.terminal;
    if (!terminal?.list) return undefined;
    let cancelled = false;
    void terminal.list({ chatSessionId: terminalOwnerSessionId, limit: 20 }, runtimePinRef.current)
      .then((sessions) => {
        if (cancelled) return;
        setTerminalTitles(
          sessions
            .filter((session) => session.status === "running" || session.active)
            .map((session) => session.title),
        );
      })
      .catch(() => {
        if (!cancelled) setTerminalTitles(null);
      });
    return () => {
      cancelled = true;
    };
    // `panelShellCount` and `activeTool` are TRIGGERS, not inputs: the panel's
    // own count wins while a panel is mounted, but the moment it unmounts the
    // count goes back to null and this read becomes the only answer there is —
    // and it was last taken before the shell existed, which is how the header
    // and the picker card kept saying "No shells" over a shell you had started.
    // Switching tools re-reads for the same reason: the picker shows every
    // card at once, so that is the moment the list has to be current.
  }, [activeTool, enabled, offline, panelShellCount, runtimePinKey, terminalEpoch, terminalOwnerSessionId]);

  const statuses = useMemo<WorkToolStatusMap>(() => ({
    terminal: terminalStatusLine(terminalTitles, panelShellCount),
    browser: offline
      ? IDLE
      : browserStatusLine(browserStatus, laneId, workToolBrowserErrorCount(browserErrors, browserStatus)),
    git: gitStatusLine(lane),
    files: filesStatusLine(lane),
    ios: offline ? IDLE : iosStatusLine(iosSession),
    "app-control": offline ? IDLE : appControlStatusLine(appControlSession),
  }), [
    appControlSession,
    browserErrors,
    browserStatus,
    iosSession,
    lane,
    laneId,
    offline,
    panelShellCount,
    terminalTitles,
  ]);

  return {
    statuses,
    loading: enabled && !settled,
    iosSession,
    appControlSession,
  };
}
