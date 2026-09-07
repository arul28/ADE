import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppControlSession,
  BuiltInBrowserStatus,
  IosSimulatorSession,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
} from "../../../shared/types";
import type { WorkSidebarTab } from "../../state/appStore";
import { boundMachineLanePrs, lanePrsForMachine, useLanePrsByLaneId } from "./useLanePrs";
import {
  EMPTY_WORK_TOOL_ERRORS,
  pruneWorkToolBrowserErrors,
  reduceWorkToolBrowserErrors,
  workToolBrowserErrorCount,
  type WorkToolErrorsByTab,
} from "./workToolErrors";
import { workToolAvailability, type WorkToolContext } from "./workTools";

/**
 * What a tool has to say about itself on the picker card and in the activity
 * dots — one short line, plus whether something is actually running.
 *
 * `line: null` means "nothing measured": the card falls back to the tool's
 * blurb instead of inventing a status. Every field here comes from a read the
 * pane already makes (an event subscription, a one-shot `getStatus`, the lane
 * store); nothing here starts a poller.
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

/** How long the picker is allowed to show skeleton lines before committing. */
const STATUS_SETTLE_MS = 300;

function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function shortHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.host) return null;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

export function browserStatusLine(
  status: BuiltInBrowserStatus | null,
  laneId: string | null,
  errorCount = 0,
): WorkToolStatus {
  if (!status || status.tabs.length === 0) return { line: "No tabs", live: false, errorCount: 0, errored: false };
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
    : shortHost(activeTab?.url ?? status.url)
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
  return { line: `${label}${suffix}`, live: true, errorCount, errored: false, attention: handedOff };
}

export function gitStatusLine(lane: LaneSummary | null): WorkToolStatus {
  if (!lane?.status) return IDLE;
  const { ahead, behind, dirty, rebaseInProgress } = lane.status;
  if (rebaseInProgress) return { line: "Rebasing", live: true, errorCount: 0, errored: false };
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  // "dirty" rather than "uncommitted changes": this is a status slot, not a
  // sentence, and at two columns the sentence became "3 ahead · uncommitt…".
  parts.push(dirty ? "dirty" : "clean");
  return { line: parts.join(" · "), live: dirty || ahead > 0, errorCount: 0, errored: false };
}

export function prStatusLine(prs: readonly PrSummary[] | undefined): WorkToolStatus {
  const pr = prs?.[0];
  if (!pr) return { line: "No PR", live: false, errorCount: 0, errored: false };
  const checks = pr.checksStatus;
  const detail = checks === "pending"
    ? "checks"
    : checks === "failing"
      ? "failing"
      : checks === "passing"
        ? "passing"
        : pr.state;
  return {
    line: `#${pr.githubPrNumber} · ${detail}`,
    live: checks === "pending",
    errorCount: 0,
    errored: checks === "failing",
  };
}

export function iosStatusLine(session: IosSimulatorSession | null): WorkToolStatus {
  if (!session) return { line: "Not booted", live: false, errorCount: 0, errored: false };
  // The dot already says "booted"; the words are for the device name, which is
  // the part that is long ("iPhone 17 Pro Max") and the part you asked for.
  const device = session.deviceName?.trim() || "Simulator";
  return { line: device, live: true, errorCount: 0, errored: false };
}

export function appControlStatusLine(session: AppControlSession | null): WorkToolStatus {
  if (!session) return { line: "No app", live: false, errorCount: 0, errored: false };
  const label = session.label?.trim() || "App";
  return {
    line: label,
    live: session.status !== "stopped" && session.status !== "exited",
    errorCount: 0,
    // App Control has no pushed console/network tally today, so its red dot is
    // driven by the one error state its session reports.
    errored: session.status === "failed",
  };
}

export function terminalStatusLine(
  titles: readonly string[] | null,
): WorkToolStatus {
  if (titles == null) return IDLE;
  if (titles.length === 0) return { line: "No shells", live: false, errorCount: 0, errored: false };
  // Shell titles are unbounded ("npm run dev -w apps/desktop"), and appending
  // even one of them turned this into "Shells attache…" at 526px. The count is
  // the whole status; the tab strip below names them.
  return { line: pluralize(titles.length, "shell", "shells"), live: true, errorCount: 0, errored: false };
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
  /** Capability gate — an unavailable tool is never read from. */
  context: WorkToolContext;
  laneId: string | null;
  lane: LaneSummary | null;
  runtimePin: OpenProjectBinding | null;
  /** Chat/CLI session that owns the attached terminals, if any. */
  terminalOwnerSessionId: string | null;
  /** Project root the browser view is collection-scoped to. */
  browserViewRoot: string | null;
  /** Machine the pane is pinned to, or null for this tab's own machine. */
  pinnedMachineId: string | null;
  /** True when the pinned machine is not answering; skip every pinned read. */
  offline: boolean;
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
  const {
    enabled,
    context,
    laneId,
    lane,
    runtimePin,
    terminalOwnerSessionId,
    browserViewRoot,
    pinnedMachineId,
    offline,
  } = args;

  const [browserStatus, setBrowserStatus] = useState<BuiltInBrowserStatus | null>(null);
  const [browserErrors, setBrowserErrors] = useState<WorkToolErrorsByTab>(EMPTY_WORK_TOOL_ERRORS);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [terminalTitles, setTerminalTitles] = useState<string[] | null>(null);
  const [settled, setSettled] = useState(false);

  // A tool that cannot run here is never asked how it is doing: a remote
  // project has no local browser view to describe, and the web client's native
  // namespaces are stubs that would answer "unsupported" forever.
  const canReadBrowser = workToolAvailability("browser", context).available;
  const canReadIos = workToolAvailability("ios", context).available;
  const canReadAppControl = workToolAvailability("app-control", context).available;

  const runtimePinKey = runtimePin?.key ?? null;
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  // One grace window, not one per read: the picker commits its lines after
  // 300ms whatever the slowest namespace is doing, so a wedged machine can
  // never leave a grid of shimmering placeholders.
  useEffect(() => {
    if (!enabled) return undefined;
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), STATUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, laneId, runtimePinKey, terminalOwnerSessionId]);

  useEffect(() => {
    if (!enabled || offline || !canReadBrowser) {
      setBrowserStatus(null);
      setBrowserErrors(EMPTY_WORK_TOOL_ERRORS);
      return undefined;
    }
    const browser = window.ade?.builtInBrowser;
    if (!browser?.getStatus || !browser.onEvent) return undefined;
    let cancelled = false;
    const scope = browserViewRoot ? { projectRoot: browserViewRoot } : {};
    void browser.getStatus(scope, runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setBrowserStatus(status ?? null);
      })
      .catch(() => {
        if (!cancelled) setBrowserStatus(null);
      });
    const unsubscribe = browser.onEvent((event) => {
      // The error tally is pushed by the service on change and zeroed on a
      // main-frame navigation, so the badge clears itself without a poll.
      if (event.type === "diagnostics") {
        setBrowserErrors((current) => reduceWorkToolBrowserErrors(current, event));
        return;
      }
      const next = (event as { status?: BuiltInBrowserStatus }).status;
      if (next) {
        setBrowserStatus(next);
        // A closed tab must not keep a dot red for a page nobody can reach.
        setBrowserErrors((current) => pruneWorkToolBrowserErrors(current, next));
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [browserViewRoot, canReadBrowser, enabled, offline, runtimePinKey]);

  useEffect(() => {
    if (!enabled || offline || !canReadIos) {
      setIosSession(null);
      return undefined;
    }
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    void iosSimulator.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setIosSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setIosSession(null);
      });
    const unsubscribe = iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setIosSession(event.session ?? null);
      } else if (event.type === "session-released") {
        setIosSession(null);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canReadIos, enabled, offline, runtimePinKey]);

  useEffect(() => {
    if (!enabled || offline || !canReadAppControl) {
      setAppControlSession(null);
      return undefined;
    }
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    void appControl.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setAppControlSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setAppControlSession(null);
      });
    const unsubscribe = appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlSession(event.session ?? null);
      } else if (event.type === "session-stopped") {
        setAppControlSession(null);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canReadAppControl, enabled, offline, runtimePinKey]);

  // Attached shells have no dedicated status event, so the list is re-read
  // whenever one could have changed: a session is created/deleted, or a PTY
  // exits. Still not a poll — every re-read is caused by something that
  // happened. Before this the header could say "No shells" for the lifetime of
  // the pane while a shell you had just started scrolled past underneath it.
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
  }, [enabled, offline, runtimePinKey, terminalEpoch, terminalOwnerSessionId]);

  const prsByLaneId = useLanePrsByLaneId();

  const statuses = useMemo<WorkToolStatusMap>(() => ({
    terminal: terminalStatusLine(terminalTitles),
    browser: offline
      ? IDLE
      : browserStatusLine(browserStatus, laneId, workToolBrowserErrorCount(browserErrors, browserStatus)),
    git: gitStatusLine(lane),
    // No changed-file count is cheap here: `LaneSummary.status` carries a dirty
    // BOOLEAN, not a tally, and a real count means a git read the pane would
    // then have to keep fresh. So the card states what it does rather than
    // padding the slot with the marketing blurb.
    files: { line: "Lane worktree", live: false, errorCount: 0, errored: false },
    ios: offline ? IDLE : iosStatusLine(iosSession),
    "app-control": offline ? IDLE : appControlStatusLine(appControlSession),
    // Machine-scoped, like every other PR render path: lane ids are not unique
    // across machines, so a pinned pane must read the pinned machine's answer.
    pr: laneId
      ? prStatusLine(
          pinnedMachineId
            ? lanePrsForMachine(prsByLaneId, pinnedMachineId, laneId)
            : boundMachineLanePrs(prsByLaneId, laneId),
        )
      : IDLE,
  }), [
    appControlSession,
    browserErrors,
    browserStatus,
    iosSession,
    lane,
    laneId,
    offline,
    pinnedMachineId,
    prsByLaneId,
    terminalTitles,
  ]);

  return {
    statuses,
    loading: enabled && !settled,
    iosSession,
    appControlSession,
  };
}
