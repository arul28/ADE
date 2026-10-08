import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  ClockCounterClockwise,
  Desktop,
  GitMerge,
  HandPalm,
  RocketLaunch,
  X,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { AutoUpdateSnapshot, NormalizedLinearIssue } from "../../../../shared/types";
import { useActivityStore } from "../../../state/activityStore";
import { openExternalUrl } from "../../../lib/openExternal";
import { openIssueRef } from "../../../lib/issueNavigation";
import { linearIssueRef } from "../../../../shared/issueRefs";
import { LinearMark } from "../../lanes/linearBrand";
import { WelcomeCardHead, openAttentionItem, openMachines, type MachineRow } from "../../projects/ProjectWelcomeSidePanels";
import { useWidgetVisible } from "../HomeWidgetGrid";
import { useHomeData } from "../homeData";
import { useHomeLayoutStore } from "../homeLayout";
import {
  awaySummary,
  feedFromAttention,
  feedFromLinear,
  feedFromMachines,
  feedFromProjectPrs,
  feedFromUpdate,
  filterToPinned,
  groupFeed,
  mergeFeed,
  type HomeFeedEvent,
  type HomeFeedKind,
  type MachinePresenceEntry,
} from "../homeFeed";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { FitList } from "../HomeFitList";
import { Banner } from "../../ui/notice";
import { relativeTimeShort } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * One timeline across projects and machines. Reads what the page already
 * holds (the Activity stream, the open project's PR snapshot, the machine
 * list); adds one auto-update read, and Linear's assigned issues only when
 * Linear is connected and the widget is on screen (cached ten minutes).
 */

const KIND_ICON: Record<HomeFeedKind, { icon: Icon | null; tone: string; label: string }> = {
  pr_merged: { icon: GitMerge, tone: "merged", label: "Merged" },
  chat_done: { icon: CheckCircle, tone: "ok", label: "Finished" },
  chat_failed: { icon: XCircle, tone: "crit", label: "Failed" },
  chat_needs_you: { icon: HandPalm, tone: "warn", label: "Needs you" },
  release: { icon: RocketLaunch, tone: "accent", label: "Release" },
  linear_assigned: { icon: null, tone: "linear", label: "Assigned" },
  machine_online: { icon: Desktop, tone: "ok", label: "Online" },
  machine_offline: { icon: Desktop, tone: "muted", label: "Offline" },
};

// ── Linear: assigned issues, only when connected ─────────────────────

const LINEAR_TTL_MS = 10 * 60_000;
let linearCache: { at: number; issues: NormalizedLinearIssue[] | null } | null = null;
let linearInflight: Promise<NormalizedLinearIssue[] | null> | null = null;

function loadLinearAssigned(): Promise<NormalizedLinearIssue[] | null> {
  if (linearCache && Date.now() - linearCache.at < LINEAR_TTL_MS) return Promise.resolve(linearCache.issues);
  if (linearInflight) return linearInflight;
  const cto = window.ade?.cto;
  if (!cto?.getLinearConnectionStatus || !cto.getLinearQuickView) return Promise.resolve(null);
  linearInflight = (async () => {
    try {
      const status = await cto.getLinearConnectionStatus();
      const issues = status?.connected ? (await cto.getLinearQuickView()).assignedIssues ?? [] : null;
      linearCache = { at: Date.now(), issues };
      return issues;
    } catch {
      // No project for the CTO service, or Linear refused: no Linear rows, retry later.
      linearCache = { at: Date.now(), issues: null };
      return null;
    } finally {
      linearInflight = null;
    }
  })();
  return linearInflight;
}

function useLinearAssigned(active: boolean): NormalizedLinearIssue[] | null {
  const [issues, setIssues] = useState<NormalizedLinearIssue[] | null>(() => linearCache?.issues ?? null);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void loadLinearAssigned().then((next) => {
      if (!cancelled) setIssues(next);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return issues;
}

// ── ADE releases ─────────────────────────────────────────────────────

function useUpdateSnapshot(): AutoUpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<AutoUpdateSnapshot | null>(null);
  useEffect(() => {
    const ade = window.ade;
    if (!ade?.updateGetState) return undefined;
    let cancelled = false;
    void ade.updateGetState().then((next) => {
      if (!cancelled) setSnapshot(next);
    }).catch(() => {});
    const unsubscribe = ade.onUpdateEvent?.((next) => setSnapshot(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return snapshot;
}

// ── Machines: transitions seen while the feed is on the page ─────────

const PRESENCE_KEY = "ade.home.feed.machines.v1";
const PRESENCE_KEEP_MS = 8 * 86_400_000;

type PresenceStore = { last: Record<string, { name: string; online: boolean }>; log: MachinePresenceEntry[] };

function readPresence(): PresenceStore {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PRESENCE_KEY) ?? "null") as PresenceStore | null;
    if (raw && typeof raw === "object" && raw.last && Array.isArray(raw.log)) return raw;
  } catch {
    // Unreadable: start over.
  }
  return { last: {}, log: [] };
}

/**
 * Logs a machine going online or offline the moment the list says so. The
 * first sighting of a machine records its state without an event, so a fresh
 * install does not announce every machine at once. `onlineSince` (the remote
 * connection's own connect time) dates an online event when it is known.
 */
function useMachinePresence(rows: readonly MachineRow[], onlineSince: ReadonlyMap<string, number>): MachinePresenceEntry[] {
  const [log, setLog] = useState<MachinePresenceEntry[]>(() => readPresence().log);
  // Another window logged a transition: show it here too.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PRESENCE_KEY) setLog(readPresence().log);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    const now = Date.now();
    const store = readPresence();
    let changed = false;
    for (const row of rows) {
      if (row.key === "this-machine" || row.dot === "busy") continue;
      const online = row.dot === "online";
      const before = store.last[row.key];
      if (before && before.online !== online) {
        store.log.push({ key: row.key, name: row.name, online, at: (online ? onlineSince.get(row.key) : null) ?? now });
        changed = true;
      }
      if (!before || before.online !== online || before.name !== row.name) {
        store.last[row.key] = { name: row.name, online };
        changed = true;
      }
    }
    if (!changed) return;
    store.log = store.log.filter((entry) => now - entry.at < PRESENCE_KEEP_MS).slice(-40);
    try {
      window.localStorage.setItem(PRESENCE_KEY, JSON.stringify(store));
    } catch {
      // Full or unavailable storage: this session still shows the change.
    }
    setLog(store.log);
  }, [onlineSince, rows]);
  return log;
}

// ── "While you were away" ────────────────────────────────────────────

const SEEN_KEY = "ade.home.feed.seenAt.v1";

function readSeenAt(): number | null {
  const value = Number(window.localStorage.getItem(SEEN_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function writeSeenAt(at: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(at));
  } catch {
    // Not fatal: the next visit just will not know when you left.
  }
}

/**
 * When you were last looking at the feed. Read once on mount (the previous
 * visit), then refreshed while it stays on screen and when it is hidden, so
 * coming back after a long break shows the summary again.
 */
function useAwaySince(visible: boolean): { awaySince: number | null; dismiss: () => void } {
  const [awaySince, setAwaySince] = useState<number | null>(() => readSeenAt());
  const visibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = visibleRef.current;
    visibleRef.current = visible;
    if (visible && !wasVisible) setAwaySince(readSeenAt());
    writeSeenAt(Date.now());
    if (!visible) return undefined;
    const timer = window.setInterval(() => writeSeenAt(Date.now()), 60_000);
    return () => {
      window.clearInterval(timer);
      writeSeenAt(Date.now());
    };
  }, [visible]);
  const dismiss = useCallback(() => setAwaySince(null), []);
  return { awaySince, dismiss };
}

// ── widget ───────────────────────────────────────────────────────────

function timeLabel(at: number, groupId: string, now: number): string {
  if (groupId === "today") return relativeTimeShort(at, now);
  if (groupId === "yesterday") return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(at).toLocaleDateString(undefined, { weekday: "short" });
}

function FeedRow({ event, groupId, now, onOpen }: { event: HomeFeedEvent; groupId: string; now: number; onOpen: (event: HomeFeedEvent) => void }) {
  const meta = KIND_ICON[event.kind];
  const Glyph = meta.icon;
  const openable = event.target.kind !== "none";
  return (
    <button
      type="button"
      role="listitem"
      className="kit-row ade-feed-row"
      data-kind={event.kind}
      disabled={!openable}
      onClick={() => onOpen(event)}
      title={event.detail ? `${event.title} — ${event.detail}` : event.title}
    >
      <span className="ade-feed-icon" data-tone={meta.tone} aria-label={meta.label}>
        {Glyph ? <Glyph size={13} weight="bold" /> : <LinearMark size={12} />}
      </span>
      <span className="ade-feed-text">
        <span className="ade-feed-title">{event.title}</span>
        {event.detail ? <span className="ade-feed-sub">{event.detail}</span> : null}
      </span>
      <span className="kit-num ade-feed-time">{timeLabel(event.at, groupId, now)}</span>
    </button>
  );
}

/** Day headings and rows as one flat list, so the list can show exactly what fits. */
function feedRows(groups: ReturnType<typeof groupFeed>, now: number, onOpen: (event: HomeFeedEvent) => void) {
  return groups.flatMap((group, index) => [
    <div key={`head-${group.id}`} className="kit-eyebrow ade-feed-group-label" data-first={index === 0 || undefined} data-fit-head>
      {group.label}
    </div>,
    ...group.events.map((event) => <FeedRow key={event.id} event={event} groupId={group.id} now={now} onOpen={onOpen} />),
  ]);
}

export default function FeedWidget({ item }: HomeWidgetProps) {
  const { prs, projectName, projectRoot, openPrs, pinnedProjects, machineRows, machineOnlineSince, webMode } = useHomeData();
  const visible = useWidgetVisible();
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  const scope = item.settings?.scope === "pinned" ? "pinned" : "all";
  const itemsById = useActivityStore((state) => state.itemsById);
  const linearIssues = useLinearAssigned(visible);
  const update = useUpdateSnapshot();
  const presence = useMachinePresence(machineRows, machineOnlineSince);
  const { awaySince, dismiss } = useAwaySince(visible);
  const [error, setError] = useState<string | null>(null);
  // The clock the groups and relative times read; ticks once a minute while on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const events = useMemo(() => {
    const merged = mergeFeed(
      feedFromAttention(Object.values(itemsById)),
      feedFromProjectPrs(prs.recent, projectName, projectRoot),
      feedFromUpdate(update),
      feedFromLinear(linearIssues ?? []),
      feedFromMachines(presence),
    );
    return scope === "pinned" ? filterToPinned(merged, pinnedProjects) : merged;
  }, [itemsById, linearIssues, pinnedProjects, presence, projectName, projectRoot, prs.recent, scope, update]);
  const groups = useMemo(() => groupFeed(events, now), [events, now]);
  const away = useMemo(() => awaySummary(events, awaySince, now), [awaySince, events, now]);

  const open = useCallback((event: HomeFeedEvent) => {
    setError(null);
    const target = event.target;
    switch (target.kind) {
      case "attention":
        void openAttentionItem(target.item).then(setError);
        return;
      case "prs":
        openPrs?.();
        return;
      case "url":
        openExternalUrl(target.url);
        return;
      case "linear":
      {
        // The issue viewer lives in a project; with none open, Linear itself.
        const ref = linearIssueRef(target.identifier, target.url);
        if (!(projectRoot && ref && openIssueRef({ ref, source: "chip" })) && target.url) openExternalUrl(target.url);
        return;
      }
      case "machines":
        openMachines(webMode);
        return;
      default:
    }
  }, [openPrs, projectRoot, webMode]);

  const noPinned = scope === "pinned" && pinnedProjects.length === 0;

  return (
    <section className="kit-card ade-home-card ade-feed" aria-label="Feed" data-size={item.size}>
      <WelcomeCardHead icon={ClockCounterClockwise} title="Feed" count={events.length > 0 ? groups.reduce((n, g) => n + g.events.length, 0) : null}>
        <div className="kit-seg ade-feed-scope" role="group" aria-label="Projects in the feed" data-case="sentence">
          {(["all", "pinned"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={scope === option}
              title={option === "pinned" ? "Only projects you pinned on the home page" : "Every project"}
              onClick={() => updateSettings(item.id, { scope: option })}
            >
              {option === "all" ? "All" : "Pinned"}
            </button>
          ))}
        </div>
      </WelcomeCardHead>
      <div className="kit-card-body ade-feed-body" data-flush="true">
        {away ? (
          <div className="ade-feed-away" role="status">
            <div className="ade-feed-away-text">
              <span className="kit-eyebrow">While you were away · {away.gap}</span>
              <span className="ade-feed-away-parts">
                {away.parts.map((part) => <span key={part} className="ade-feed-away-part">{part}</span>)}
              </span>
            </div>
            <button type="button" className="kit-icon-btn" aria-label="Dismiss summary" title="Dismiss" onClick={dismiss}>
              <X size={12} weight="bold" />
            </button>
          </div>
        ) : null}
        {groups.length === 0 ? (
          <div className="ade-home-empty">
            <ClockCounterClockwise size={16} aria-hidden />
            <span>{noPinned ? "Pin a project in Projects to follow it here." : "Nothing happened this week yet."}</span>
          </div>
        ) : (
          <FitList
            ariaLabel="Recent events"
            more={{ dialog: { title: "Feed", render: (close) => feedRows(groups, now, (event) => {
              close();
              open(event);
            }) } }}
          >
            {feedRows(groups, now, open)}
          </FitList>
        )}
        {error ? (
          <Banner
            layout="inline"
            style={{ margin: "4px 10px 10px" }}
            model={{ id: "home-feed-open", tone: "error", title: "Couldn't open that", detail: error, dismiss: { onDismiss: () => setError(null) } }}
          />
        ) : null}
      </div>
    </section>
  );
}
