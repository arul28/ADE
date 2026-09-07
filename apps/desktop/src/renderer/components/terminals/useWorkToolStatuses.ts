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
};

export type WorkToolStatusMap = Partial<Record<WorkSidebarTab, WorkToolStatus>>;

const IDLE: WorkToolStatus = { line: null, live: false };

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
): WorkToolStatus {
  if (!status || status.tabs.length === 0) return { line: "No tabs", live: false };
  const activeTab = status.tabs.find((tab) => tab.id === status.activeTabId) ?? status.tabs[0];
  const held = status.tabs.some((tab) => tab.ownerLaneId != null)
    || status.ownerLaneId != null;
  const heldHere = laneId != null
    && (status.ownerLaneId === laneId || status.tabs.some((tab) => tab.ownerLaneId === laneId));
  const label = shortHost(activeTab?.url ?? status.url)
    ?? activeTab?.title
    ?? pluralize(status.tabs.length, "tab", "tabs");
  const suffix = heldHere
    ? " · agent holds tab"
    : held
      ? " · held by another lane"
      : status.tabs.length > 1
        ? ` · ${pluralize(status.tabs.length, "tab", "tabs")}`
        : "";
  return { line: `${label}${suffix}`, live: true };
}

export function gitStatusLine(lane: LaneSummary | null): WorkToolStatus {
  if (!lane?.status) return IDLE;
  const { ahead, behind, dirty, rebaseInProgress } = lane.status;
  if (rebaseInProgress) return { line: "Rebase in progress", live: true };
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  parts.push(dirty ? "uncommitted changes" : "clean");
  return { line: parts.join(" · "), live: dirty || ahead > 0 };
}

export function prStatusLine(prs: readonly PrSummary[] | undefined): WorkToolStatus {
  const pr = prs?.[0];
  if (!pr) return { line: "No PR", live: false };
  const checks = pr.checksStatus;
  const detail = checks === "pending"
    ? "checks running"
    : checks === "failing"
      ? "checks failing"
      : checks === "passing"
        ? "checks passing"
        : pr.state;
  return { line: `#${pr.githubPrNumber} · ${detail}`, live: checks === "pending" };
}

export function iosStatusLine(session: IosSimulatorSession | null): WorkToolStatus {
  if (!session) return { line: "Not booted", live: false };
  const device = session.deviceName?.trim() || "Simulator";
  return { line: `${device} booted`, live: true };
}

export function appControlStatusLine(session: AppControlSession | null): WorkToolStatus {
  if (!session) return { line: "No app attached", live: false };
  const label = session.label?.trim() || "App";
  return { line: `${label} attached`, live: session.status !== "stopped" && session.status !== "exited" };
}

export function terminalStatusLine(
  titles: readonly string[] | null,
): WorkToolStatus {
  if (titles == null) return IDLE;
  if (titles.length === 0) return { line: "No shells", live: false };
  const named = titles.filter((title) => title.trim().length > 0).slice(0, 2);
  const suffix = named.length > 0 ? ` · ${named.join(", ")}` : "";
  return { line: `${pluralize(titles.length, "shell", "shells")}${suffix}`, live: true };
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
      const next = (event as { status?: BuiltInBrowserStatus }).status;
      if (next) setBrowserStatus(next);
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

  // Attached shells have no status event, so this is a one-shot read taken when
  // the pane becomes interesting — never a poll. It re-runs when the owning
  // session or machine changes, which is exactly when the answer can differ.
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
  }, [enabled, offline, runtimePinKey, terminalOwnerSessionId]);

  const prsByLaneId = useLanePrsByLaneId();

  const statuses = useMemo<WorkToolStatusMap>(() => ({
    terminal: terminalStatusLine(terminalTitles),
    browser: offline ? IDLE : browserStatusLine(browserStatus, laneId),
    git: gitStatusLine(lane),
    // No cheap changed-file count exists today; the card shows its blurb rather
    // than paying for a git read the pane would then have to keep fresh.
    files: IDLE,
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
