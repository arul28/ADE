import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppControlSession,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
} from "../../../shared/types";
import { selectPrsForChatInLane } from "../../lib/prChatScope";
import { selectChatPrs } from "../lanes/lanePageModel";
import type { WorkSidebarTab } from "../../state/appStore";
import { browserHostLabel } from "../../lib/browserUrl";
import { relativeWhen } from "../../lib/format";
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
  macDesktopStatusLineText,
  useMacDesktopToolStatus,
} from "./useMacDesktopToolStatus";
import { attachedShellCount, useAttachedTerminalShells } from "./useAttachedTerminalShells";
import { appleToolCardSubtitle } from "../apple/appleDeviceState";
import {
  useAppleLaneDeviceCard,
  type AppleLaneDeviceCard,
} from "../apple/useAppleLaneDeviceCard";
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

/** The PR card line: how many pull requests the PR tool shows as open. */
function prToolStatusLine(count: number | null): WorkToolStatus {
  if (count == null) return IDLE;
  if (count <= 0) return statusLine("No pull request open", false);
  if (count === 1) return statusLine("Pull request open", false);
  return statusLine(`${count} pull requests open`, false);
}

function isOpenPullRequest(state: PrSummary["state"]): boolean {
  switch (state) {
    case "open":
    case "draft":
      return true;
    case "merged":
    case "closed":
      return false;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/**
 * Open and draft pull requests the PR tool will actually show.
 *
 * The card says "open". A merged or closed row still opens in the tool from
 * the header badge, but it is not an open pull request. The session id is the
 * pane's chat id (null on a CLI row), the same one `ChatPrPane` scopes with.
 */
export function openPullRequestCount(
  prs: readonly PrSummary[],
  lane: Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef"> | null,
  laneId: string,
  sessionId?: string | null,
): number {
  const scoped = selectPrsForChatInLane(prs, laneId, sessionId);
  const visible = lane ? selectChatPrs(lane, scoped, sessionId) : scoped;
  return visible.filter((pr) => isOpenPullRequest(pr.state)).length;
}

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
  const { dirty, rebaseInProgress } = lane.status;
  if (rebaseInProgress) return statusLine("Rebasing", true);
  const ahead = nonNegativeCount(lane.status.ahead);
  const behind = nonNegativeCount(lane.status.behind);
  const lastCommitAt = lane.lastCommitAt ?? lane.status.lastCommitAt ?? null;
  const hasUpstream = typeof lane.status.remoteBehind === "number" && lane.status.remoteBehind >= 0;

  // An empty branch has no useful age or sync state to show. Keep this ahead
  // of the dirty check so a brand-new repository says what happened: nothing
  // has been published yet.
  if (!hasUpstream && !lastCommitAt && ahead === 0 && behind === 0) {
    return statusLine("Unpublished", false);
  }

  if (dirty) {
    const dirtyParts: Array<[number | null | undefined, string]> = [
      [lane.status.unstaged, "unstaged"],
      [lane.status.staged, "staged"],
      [lane.status.untracked, "untracked"],
    ];
    const parts = dirtyParts
      .filter(([count]) => nonNegativeCount(count) > 0)
      .map(([count, label]) => `${formatStatusCount(nonNegativeCount(count))} ${label}`)
      .slice(0, 2);
    // A legacy/remote payload can still carry only the boolean. Preserve an
    // honest dirty state until its next lane refresh supplies the split.
    return statusLine(parts.join(" · ") || "Dirty", true);
  }

  const syncParts: string[] = [];
  if (ahead > 0) syncParts.push(`${formatStatusCount(ahead)} ahead`);
  if (behind > 0) syncParts.push(`${formatStatusCount(behind)} behind`);
  if (syncParts.length > 0) return statusLine(syncParts.join(" · "), ahead > 0);

  const age = relativeCommitAge(lastCommitAt);
  if (age) return statusLine(`${hasUpstream ? "Pushed" : "Committed"} ${age}`, false);
  return statusLine(hasUpstream ? "Pushed" : "Committed", false);
}

function nonNegativeCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatStatusCount(value: number): string {
  return value.toLocaleString("en-US");
}

function relativeCommitAge(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return relativeWhen(iso);
}

/**
 * §9's card subtitle: `No device` | `{name} · Starting` | `{name} · Running` |
 * `{name} · Shut down`.
 *
 * The LANE's device, not the app session: a lane can own a booted simulator
 * with nothing installed on it, and "Not booted" over a running iPhone was the
 * card lying about the one thing it is for. The dot follows the same fact —
 * green only while the device is actually up.
 */
export function iosStatusLine(device: AppleLaneDeviceCard | null): WorkToolStatus {
  if (!device) return statusLine(appleToolCardSubtitle(null), false);
  return statusLine(appleToolCardSubtitle(device), device.state === "running", {
    attention: device.state === "starting",
  });
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
  const label = appControlCardLabel(session);
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
 * The picker card gets one short name, never the launch argv.
 *
 * `app-control launch --command "sh -lc '…'"` stores that whole string as
 * `session.label` when the caller omits `--label`. Dumping it on the card is
 * how a 512px tools page ends up reading `sh -lc 'ADE_PACKAGE_CHANNEL…`.
 */
export function appControlCardLabel(session: Pick<AppControlSession, "label" | "command">): string {
  const raw = session.label?.trim() || session.command?.trim() || "";
  if (!raw) return "App";
  if (!looksLikeLaunchCommand(raw)) return raw;
  const npmScript = raw.match(/\bnpm run(?:\s+--prefix\s+\S+)?\s+(\S+)/)?.[1];
  if (npmScript === "dev" || npmScript === "dev:desktop" || /dev:desktop/.test(raw)) {
    return "Desktop app";
  }
  if (npmScript) return npmScript;
  return "Desktop app";
}

/**
 * A name for the app worth showing as a title, or null when there is none.
 *
 * The page's own title (from CDP) wins. The session label counts only when
 * someone named it: a launch without `--label` stores the raw command
 * ("npm start") there, and a command is never a title.
 */
export function appControlAppName(
  session: Pick<AppControlSession, "label" | "command"> | null | undefined,
  pageTitle?: string | null,
): string | null {
  const title = pageTitle?.trim();
  if (title) return title;
  const label = session?.label?.trim();
  if (!label) return null;
  if (label === session?.command?.trim() || looksLikeLaunchCommand(label)) return null;
  return label;
}

function looksLikeLaunchCommand(text: string): boolean {
  return /(?:^|[\s'"=])(?:sh|bash|zsh|cmd(?:\.exe)?|powershell)\b/i.test(text)
    || /\bADE_[A-Z0-9_]+=/.test(text)
    || /\bnpm(?:\s+run|\s+start|\s+--prefix)\b/.test(text)
    || /\s-{1,2}[\w-]+/.test(text) && text.length > 40;
}

/**
 * The Terminal tool's status line from the shell count. `attachedShellCount`
 * picks the source: the mounted panel, else the `terminal.list` titles, so the
 * header can still describe a tool you are not looking at.
 */
export function terminalStatusLine(
  titles: readonly string[] | null,
  panelCount: number | null = null,
): WorkToolStatus {
  const count = attachedShellCount(titles, panelCount);
  if (count == null) return IDLE;
  if (count === 0) return statusLine("No shells", false);
  // Shell titles are unbounded ("npm run dev -w apps/desktop"), and appending
  // even one of them turned this into "Shells attache…" at 526px. The count is
  // the whole status; the tab strip below names them.
  return statusLine(pluralize(count, "shell", "shells"), true);
}

/** Render the cached tracked-file total and unique changed-entry count. */
export function filesStatusLine(lane: LaneSummary | null): WorkToolStatus {
  if (!lane?.status) return statusLine("Browse", false);
  const trackedFileCount = lane.trackedFileCount ?? lane.status.trackedFileCount;
  if (trackedFileCount == null) return statusLine("Browse", false);
  const fileCount = formatStatusCount(nonNegativeCount(trackedFileCount));

  // `changedFileCount` is the only unique entry count there is: the split
  // counts ENTRIES PER SIDE, so a file with both index and worktree changes is
  // in `staged` AND `unstaged` while two files dirty on one side each are in
  // only one — no sum and no max of the two recovers the number of files. A
  // legacy or remote payload that carries no `changedFileCount` therefore
  // knows only WHETHER the worktree is dirty, and says exactly that rather
  // than inventing a total that is wrong in one direction or the other. Same
  // word `gitStatusLine` falls back to for the same payload.
  const changedFileCount = lane.status.changedFileCount;
  if (changedFileCount == null) {
    return statusLine(lane.status.dirty ? `${fileCount} files · dirty` : `${fileCount} files`, false);
  }

  // An untracked DIRECTORY counts as one entry: `--untracked-files=normal`
  // reports the folder, not its contents, and that is intended — "12 changed"
  // should not become "412" for one new folder.
  const changedCount = nonNegativeCount(changedFileCount);
  return statusLine(
    changedCount > 0 ? `${fileCount} files · ${formatStatusCount(changedCount)} changed` : `${fileCount} files`,
    false,
  );
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
   * Chat id the PR tool pane uses. Null on a CLI row, where the pane is not
   * scoped to a chat. This is not the terminal owner: a pty id would hide the
   * lane's pull requests from the card while the pane still showed them.
   */
  prSessionId?: string | null;
  /**
   * The tool on screen, or null for the picker page.
   *
   * Only ever a re-read TRIGGER, never part of an answer: arriving at the
   * picker is the one moment every card is about to be read at once, so the
   * shell list is refreshed then rather than shown at whatever age it happened
   * to be.
   */
  activeTool?: WorkSidebarTab | null;
  /**
   * Bump to re-read the lane's Apple device now — the card menu's refresh
   * after it boots, releases, or deletes. Forwarded to
   * {@link useAppleLaneDeviceCard}; the desktop also hears `apple.device.state`
   * events, but the hosted web client does not, so this covers that client.
   */
  appleDeviceRefreshKey?: unknown;
}): {
  statuses: WorkToolStatusMap;
  loading: boolean;
  /**
   * The raw session behind the App Control line. The pane needs the owning
   * lane id (not just the prose) to decide whether the tool it is about to
   * render belongs to a different lane and needs its attribution banner.
   */
  appControlSession: AppControlSession | null;
  /**
   * The lane's Apple device, for the card's action menu. Null when the lane
   * owns none (or the read has not landed), which is exactly when the menu has
   * nothing to offer.
   */
  appleDevice: AppleLaneDeviceCard | null;
} {
  const { enabled, laneId, lane, runtimePin, terminalOwnerSessionId, prSessionId = null, activeTool = null, appleDeviceRefreshKey } = args;

  const [browserErrors, setBrowserErrors] = useState<WorkToolErrorsByTab>(EMPTY_WORK_TOOL_ERRORS);
  const [prCount, setPrCount] = useState<number | null>(null);
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
    appControlSession,
    canBrowser,
    context,
    offline,
  } = useNativeToolFeeds();

  // The lane's screen: one `getStatus` per lane plus the service's own events.
  // The capability answer comes from the provider's cached read, so a host that
  // cannot run a display is never asked about one.
  const macDesktop = useMacDesktopToolStatus({
    enabled: enabled && !offline,
    laneId,
    runtimePin,
    supported: context.supportsMacDesktop ?? null,
  });
  useNativeToolFeedHandlers(useMemo(() => ({ onBrowserEvent }), [onBrowserEvent]));

  /*
    The lane's Apple device, for the card's one line. Polled here rather than
    added to the feed provider because it is a lanes-DB read keyed by LANE, and
    the feeds are keyed by machine — different lifetimes, and the card is the
    only reader.
  */
  const appleDevice = useAppleLaneDeviceCard({
    laneId,
    runtimePin,
    enabled: enabled && !offline,
    refreshKey: appleDeviceRefreshKey,
  });

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

  // The shells attached to the owning chat or CLI session. The shared hook
  // re-reads the list on every change that could move it; switching tools is
  // one more trigger, because the picker shows every card at once and that is
  // the moment the list has to be current.
  const { panelCount: panelShellCount, titles: terminalTitles } = useAttachedTerminalShells(
    terminalOwnerSessionId,
    runtimePin,
    { enabled: enabled && !offline, refreshKey: activeTool },
  );

  useEffect(() => {
    if (!enabled || !laneId) {
      setPrCount(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      const prs = window.ade?.prs;
      if (!prs?.listAll && !prs?.getForLane) {
        if (!cancelled) setPrCount(0);
        return;
      }
      const read = prs.listAll
        ? prs.listAll(runtimePinRef.current).then((all: PrSummary[]) => openPullRequestCount(all, lane, laneId, prSessionId))
        : prs.getForLane(laneId, runtimePinRef.current).then((one: PrSummary | null) => (one && isOpenPullRequest(one.state) ? 1 : 0));
      void read.then((count) => {
        if (!cancelled) setPrCount(count);
      }).catch(() => {
        if (!cancelled) setPrCount(null);
      });
    };
    load();
    const dispose = window.ade?.prs?.onEvent?.(() => load());
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled, lane, laneId, prSessionId, runtimePinKey]);

  const { line: macDesktopLine, live: macDesktopLive } = macDesktopStatusLineText(macDesktop);
  const macDesktopStatus = useMemo(
    () => statusLine(macDesktopLine, macDesktopLive),
    [macDesktopLine, macDesktopLive],
  );

  const statuses = useMemo<WorkToolStatusMap>(() => ({
    terminal: terminalStatusLine(terminalTitles, panelShellCount),
    browser: offline
      ? IDLE
      : browserStatusLine(browserStatus, laneId, workToolBrowserErrorCount(browserErrors, browserStatus)),
    git: gitStatusLine(lane),
    files: filesStatusLine(lane),
    ios: offline ? IDLE : iosStatusLine(appleDevice),
    "app-control": offline ? IDLE : appControlStatusLine(appControlSession),
    // No `offline ? IDLE` arm: an unreachable machine leaves the last known
    // answer standing rather than claiming the lane has no screen, and the
    // hook already stops reading.
    "mac-desktop": macDesktopStatus,
    pr: prToolStatusLine(prCount),
  }), [
    appControlSession,
    macDesktopStatus,
    appleDevice,
    browserErrors,
    browserStatus,
    lane,
    laneId,
    offline,
    panelShellCount,
    prCount,
    terminalTitles,
  ]);

  return {
    statuses,
    loading: enabled && !settled,
    appControlSession,
    appleDevice,
  };
}
