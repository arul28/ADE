import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import {
  attentionDestinationDeepLink,
  type AiProviderConnections,
  type AttentionItem,
  type RemoteRuntimeConnectionSnapshot,
  type RemoteRuntimeConnectionState,
  type UsageProvider,
  type UsageWindowType,
} from "../../../shared/types";
import { formatBytes } from "../../lib/format";
import { navigateToAppTarget, openAdeDeeplink } from "../../lib/openExternal";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { requestUsagePopover } from "../../lib/usagePopover";
import { useAppStore } from "../../state/appStore";
import {
  acknowledgeActivityItem,
  useActivityStore,
} from "../../state/activityStore";
import { activitySections } from "../activity/activityPriority";
import {
  ACTIVITY_STATE_GLYPHS,
  activityStateGroup,
} from "../activity/activityPresentation";
import { ActivityStateGlyphMark } from "../activity/ActivityStateGlyphMark";
import { deriveLaneMachineOptions } from "../lanes/laneMachines";
import { providerColor } from "../usage/providerColors";
import { ProviderMark } from "../usage/UsageAccountRow";
import { usagePressureColor } from "../usage/usageDesign";
import {
  buildAccountRows,
  poolAccounts,
  quotaPopoverProviders,
} from "../usage/usageLimitModel";
import { useUsageSnapshot } from "../usage/useUsageSnapshot";
import { shortWindowLabel, windowLabel } from "../usage/usageWindowFormat";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { welcomeRelativeTime } from "./ProjectWelcomeWebRows";
import "../activity/Activity.css";

// ---------------------------------------------------------------------------
// The welcome page's side column: chats that are still running, usage limits,
// and machines. Each section reads state the renderer already holds — the
// account Activity stream AppShell keeps in sync, the usage snapshot
// subscription, and the remote-runtime connection snapshot — and adds no
// polling. Sections are compact on purpose; each links to its full surface.
// ---------------------------------------------------------------------------

type SideSectionId = "running" | "usage" | "machines";

function SectionHead({
  title,
  count,
  action,
}: {
  title: string;
  count?: number | null;
  action?: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className="ade-welcome-section-head">
      <span className="ade-welcome-section-title">{title}</span>
      {count != null ? <span className="ade-welcome-section-count">{count}</span> : null}
      {action ? (
        <button type="button" className="ade-welcome-link" onClick={action.onClick}>
          {action.label}
          <ArrowRight size={11} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

// ── still running ──────────────────────────────────────────────────

const RUNNING_GROUPS = new Set(["needs-you", "planning", "working"]);

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this chat.";
}

/** Agent chats that are working or waiting on you, on every machine. */
function useRunningChats(): AttentionItem[] {
  const itemsById = useActivityStore((state) => state.itemsById);
  return useMemo(
    () => activitySections(itemsById)
      .filter((section) => RUNNING_GROUPS.has(section.id))
      .flatMap((section) => section.items),
    [itemsById],
  );
}

function RunningList({ items }: { items: AttentionItem[] }) {
  const availability = useActivityStore((state) => state.availability);
  const [error, setError] = useState<string | null>(null);

  // Same path the Activity pane uses to open an item.
  const openItem = useCallback(async (item: AttentionItem) => {
    setError(null);
    try {
      const bridge = window.ade?.attention;
      if (bridge?.openItem) await bridge.openItem(item);
      else openAdeDeeplink(attentionDestinationDeepLink(item.destination, item));
    } catch (openError) {
      setError(navigationErrorMessage(openError));
      return;
    }
    await acknowledgeActivityItem(item.id, "seen").catch(() => {});
  }, []);

  if (items.length === 0) {
    return (
      <div className="ade-welcome-empty">
        {availability?.state === "signed_out"
          ? "No chats running on this machine. Sign in to include your other machines."
          : "No chats running. Chats that are working or waiting on you show up here, from every machine."}
      </div>
    );
  }

  return (
    <div role="list">
      {items.map((item) => {
        const group = activityStateGroup(item);
        const glyph = ACTIVITY_STATE_GLYPHS[group];
        const since = welcomeRelativeTime(item.statusSince ?? item.updatedAt);
        return (
          <button
            key={item.id}
            type="button"
            role="listitem"
            className="ade-welcome-item"
            onClick={() => void openItem(item)}
            title={`${item.title} — ${item.project.name} · ${item.machine.name}`}
          >
            <span className={`ade-welcome-item-glyph activity-tone-${glyph.tone}`} aria-label={glyph.label}>
              <ActivityStateGlyphMark group={group} size={12} />
            </span>
            <span className="ade-welcome-item-text">
              <span className="ade-welcome-item-title">{item.title}</span>
              <span className="ade-welcome-item-sub">
                {item.project.name} · {item.machine.name}
              </span>
            </span>
            <span className={`ade-welcome-item-state activity-tone-${glyph.tone}`}>
              {group === "needs-you" ? glyph.label : since ?? glyph.label}
            </span>
          </button>
        );
      })}
      {error ? (
        <div className="ade-welcome-empty" role="alert" style={{ color: "var(--color-error)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── usage ──────────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  grok: "Grok",
  opencode: "OpenCode",
  kimi: "Kimi",
};

type UsageLine = {
  key: string;
  provider: UsageProvider;
  name: string;
  percentLeft: number;
  windowShort: string;
  title: string;
};

/**
 * Which window a summary line shows: the longest main quota. The side limits
 * (Claude's OAuth-apps and cowork windows) only stand in when a provider has
 * nothing else; among equals, the longer declared duration wins.
 */
const WINDOW_RANK: Record<UsageWindowType, number> = {
  monthly: 30,
  weekly: 20,
  five_hour: 10,
  weekly_oauth_apps: 1,
  weekly_cowork: 1,
};

function windowRank(window: { windowType: UsageWindowType; windowDurationMs?: number }): number {
  const durationDays = (window.windowDurationMs ?? 0) / 86_400_000;
  return (WINDOW_RANK[window.windowType] ?? 0) + Math.min(durationDays, 31) / 100;
}

/**
 * One line per account: its longest main window (monthly, else weekly, else
 * 5h), as a small bar — the quota that says how much room is left overall. The full
 * band — every window, pace, resets — is the top-bar popover "Details" opens.
 * Same subscription, provider filter and account pooling as that band.
 */
function useUsageLines(): { lines: UsageLine[]; bridgeMissing: boolean; loaded: boolean } {
  const usage = useUsageSnapshot({ readSnapshot: true, noteDemand: true });
  const { snapshot, bridgeMissing, bindingRevision } = usage;
  const [connections, setConnections] = useState<AiProviderConnections | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    if (!window.ade?.ai?.getStatus) return undefined;
    void bindingRevision;
    window.ade.ai
      .getStatus()
      .then((status) => {
        if (!cancelled) setConnections(status.providerConnections ?? null);
      })
      .catch(() => {
        if (!cancelled) setConnections(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bindingRevision]);

  const lines = useMemo(() => {
    if (!snapshot) return [];
    const providers = quotaPopoverProviders({
      connections,
      windows: snapshot.windows,
      statuses: snapshot.providerStatus,
    });
    const accounts = poolAccounts(snapshot.accounts);
    const result: UsageLine[] = [];
    for (const provider of providers) {
      const windows = snapshot.windows.filter((window) => window.provider === provider);
      const rows = buildAccountRows(provider, windows, accounts, nowMs);
      for (const row of rows) {
        const shown = row.cells.reduce<(typeof row.cells)[number] | null>(
          (best, cell) => (!best || windowRank(cell.segment.window) > windowRank(best.segment.window) ? cell : best),
          null,
        );
        // A provider with no reading yet (a login that has never polled, a
        // host that could not be reached) says nothing useful in a summary.
        if (!shown) continue;
        // The provider names the line; a second login on the same provider
        // is told apart by its email (account labels are often "Default").
        const accountName = row.account?.email?.trim() || row.account?.label?.trim() || null;
        const name = rows.length > 1 && accountName
          ? `${PROVIDER_LABEL[provider]} · ${accountName}`
          : PROVIDER_LABEL[provider];
        const detail = row.cells
          .map((cell) => `${windowLabel(cell.segment.window)} ${Math.round(cell.segment.percentLeft)}% left`)
          .join(" · ");
        result.push({
          key: row.key,
          provider,
          name,
          percentLeft: shown.segment.percentLeft,
          windowShort: shortWindowLabel(shown.segment.window),
          title: `${name}${accountName && rows.length === 1 ? ` (${accountName})` : ""} — ${detail}`,
        });
      }
    }
    return result;
  }, [connections, nowMs, snapshot]);

  return { lines, bridgeMissing, loaded: snapshot != null };
}

function openUsageDetails(): void {
  if (requestUsagePopover()) return;
  navigateToAppTarget({ kind: "settings", tab: "stats", anchor: "ade-usage" });
}

function UsageList({ lines, bridgeMissing, loaded }: ReturnType<typeof useUsageLines>) {
  const theme = useAppStore((state) => state.theme);
  if (bridgeMissing) {
    return <div className="ade-welcome-empty">Usage isn’t available in this view.</div>;
  }
  if (lines.length === 0) {
    return (
      <div className="ade-welcome-empty">
        {loaded
          ? "No limits reported yet. Signed-in Claude Code or Codex CLI accounts show up here."
          : "Reading usage…"}
      </div>
    );
  }
  return (
    <div role="list">
      {lines.map((line) => {
        const left = line.percentLeft;
        const color = usagePressureColor(100 - left, providerColor(line.provider, theme));
        return (
          <button
            key={line.key}
            type="button"
            role="listitem"
            className="ade-welcome-item"
            title={line.title}
            onClick={openUsageDetails}
          >
            <ProviderMark provider={line.provider} size={14} />
            <span className="ade-welcome-usage-name">{line.name}</span>
            <span className="ade-welcome-meter" aria-hidden>
              <span style={{ width: `${left}%`, background: color }} />
            </span>
            <span className="ade-welcome-usage-value">
              <strong>{Math.round(left)}%</strong> {line.windowShort}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── machines ───────────────────────────────────────────────────────

type MachineRow = {
  key: string;
  name: string;
  dot: "online" | "busy" | "available" | "offline";
  detail: string;
};

function connectionDetail(
  state: RemoteRuntimeConnectionState,
  projectCount: number,
  freeBytes: number | null,
): { dot: MachineRow["dot"]; detail: string } {
  switch (state) {
    case "connected": {
      const parts = [
        projectCount > 0 ? `${projectCount} project${projectCount === 1 ? "" : "s"}` : "Online",
        typeof freeBytes === "number" ? `${formatBytes(freeBytes)} free` : null,
      ].filter(Boolean);
      return { dot: "online", detail: parts.join(" · ") };
    }
    case "connecting":
      return { dot: "busy", detail: "Connecting…" };
    case "parked":
      return { dot: "offline", detail: "Paused" };
    default:
      return { dot: "offline", detail: "Offline" };
  }
}

const MACHINE_STATE_ORDER: Record<MachineRow["dot"], number> = {
  online: 0,
  busy: 1,
  available: 2,
  offline: 3,
};

function sortMachines(rows: MachineRow[]): MachineRow[] {
  return rows.sort((a, b) => MACHINE_STATE_ORDER[a.dot] - MACHINE_STATE_ORDER[b.dot]
    || a.name.localeCompare(b.name));
}

function desktopMachineRows(snapshot: RemoteRuntimeConnectionSnapshot | null): MachineRow[] {
  const connections = snapshot?.connections ?? [];
  if (connections.length === 0) return [];
  // Free disk only when the connection snapshot already carries it.
  const freeById = new Map(
    deriveLaneMachineOptions({ connections, boundTargetId: null })
      .map((option) => [option.id, option.freeBytes]),
  );
  const remotes = connections.map((connection): MachineRow => {
    const { dot, detail } = connectionDetail(
      connection.state,
      connection.projects?.length ?? 0,
      freeById.get(connection.target.id) ?? null,
    );
    return {
      key: connection.target.id,
      name: connection.target.name?.trim() || connection.target.hostname,
      dot,
      detail,
    };
  });
  return [
    { key: "this-machine", name: "This machine", dot: "online", detail: "Running ADE" },
    ...sortMachines(remotes),
  ];
}

function webMachineRows(machines: readonly WebMachineEntry[]): MachineRow[] {
  return sortMachines(machines
    .filter((machine) => !machine.rememberedOnly)
    .map((machine): MachineRow => {
      const dot: MachineRow["dot"] = machine.status === "live"
        ? "online"
        : machine.status === "connecting"
          ? "busy"
          : machine.status === "available"
            ? "available"
            : "offline";
      const projectCount = machine.projects.length;
      return {
        key: machine.key,
        name: machine.name,
        dot,
        detail: projectCount > 0
          ? `${machine.statusLabel} · ${projectCount} project${projectCount === 1 ? "" : "s"}`
          : machine.statusLabel,
      };
    }));
}

function openMachines(webMode: boolean): void {
  if (webMode) {
    window.dispatchEvent(new CustomEvent("ade-web:open-connections", { detail: { tab: "machines" } }));
    return;
  }
  openConnectionsPanel("machines");
}

function MachineList({ rows, webMode }: { rows: MachineRow[]; webMode: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="ade-welcome-empty">
        Only this machine. Connect another computer to open its projects and run chats on it from here.
        <br />
        <button type="button" className="ade-welcome-link" onClick={() => openMachines(webMode)}>
          Connect a machine
          <ArrowRight size={11} weight="bold" />
        </button>
      </div>
    );
  }
  return (
    <div role="list">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          role="listitem"
          className="ade-welcome-item"
          onClick={() => openMachines(webMode)}
          title={`${row.name} — ${row.detail}`}
        >
          <span aria-hidden className="ade-welcome-dot" data-state={row.dot} />
          <span className="ade-welcome-item-text">
            <span className="ade-welcome-item-title">{row.name}</span>
            <span className="ade-welcome-item-sub">{row.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ── the column ─────────────────────────────────────────────────────

/**
 * Wide windows: one quiet plane with the sections stacked, running chats first
 * whenever there are any. Narrow windows: one tabbed strip, so the side info
 * never pushes the page into scrolling.
 */
export function WelcomeSideColumn({
  webMode,
  remoteSnapshot,
  webMachines,
  narrow,
}: {
  webMode: boolean;
  remoteSnapshot: RemoteRuntimeConnectionSnapshot | null;
  webMachines: readonly WebMachineEntry[];
  narrow: boolean;
}) {
  const navigate = useNavigate();
  const running = useRunningChats();
  const usage = useUsageLines();
  const machines = useMemo(
    () => (webMode ? webMachineRows(webMachines) : desktopMachineRows(remoteSnapshot)),
    [remoteSnapshot, webMachines, webMode],
  );

  const sections: Record<SideSectionId, {
    title: string;
    count: number | null;
    action: { label: string; onClick: () => void } | null;
    body: ReactNode;
  }> = {
    running: {
      title: "Still running",
      count: running.length > 0 ? running.length : null,
      action: running.length > 0 ? { label: "Activity", onClick: () => navigate("/activity") } : null,
      body: <RunningList items={running} />,
    },
    usage: {
      title: "Usage limits",
      count: null,
      action: usage.bridgeMissing ? null : { label: "Details", onClick: openUsageDetails },
      body: <UsageList {...usage} />,
    },
    machines: {
      title: "Machines",
      count: machines.length > 0 ? machines.length : null,
      action: machines.length > 0 ? { label: "Manage", onClick: () => openMachines(webMode) } : null,
      body: <MachineList rows={machines} webMode={webMode} />,
    },
  };

  const order: SideSectionId[] = ["running", "usage", "machines"];

  const [tab, setTab] = useState<SideSectionId>(running.length > 0 ? "running" : "usage");
  // Chats starting while the strip shows something else take the first tab.
  const hasRunning = running.length > 0;
  useEffect(() => {
    if (hasRunning) setTab("running");
  }, [hasRunning]);

  if (narrow) {
    const current = sections[tab];
    return (
      <aside className="ade-welcome-plane ade-welcome-side" data-quiet="true" aria-label="Status">
        <div className="ade-welcome-tabs" role="tablist" aria-label="Status">
          {order.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`ade-welcome-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="ade-welcome-tabpanel"
              className="ade-welcome-tab"
              onClick={() => setTab(id)}
            >
              {sections[id].title}
              {sections[id].count != null ? (
                <span className="ade-welcome-section-count">{sections[id].count}</span>
              ) : null}
            </button>
          ))}
          {current.action ? (
            <button type="button" className="ade-welcome-link" onClick={current.action.onClick}>
              {current.action.label}
              <ArrowRight size={11} weight="bold" />
            </button>
          ) : null}
        </div>
        <div
          id="ade-welcome-tabpanel"
          role="tabpanel"
          aria-labelledby={`ade-welcome-tab-${tab}`}
          className="ade-welcome-tabpanel"
        >
          {current.body}
        </div>
      </aside>
    );
  }

  const renderSection = (id: SideSectionId, className = "ade-welcome-side-section") => (
    <section key={id} className={className} aria-label={sections[id].title}>
      <SectionHead
        title={sections[id].title}
        count={sections[id].count}
        action={sections[id].action}
      />
      <div className="ade-welcome-side-body">{sections[id].body}</div>
    </section>
  );

  // Live agent status leads; the two quieter summaries share the row below
  // it, side by side, so neither is pushed out of view.
  return (
    <aside className="ade-welcome-plane ade-welcome-side" data-quiet="true" aria-label="Status">
      {renderSection("running", "ade-welcome-side-section ade-welcome-side-running")}
      <div className="ade-welcome-side-split">
        {renderSection("usage", "ade-welcome-side-cell")}
        {renderSection("machines", "ade-welcome-side-cell")}
      </div>
    </aside>
  );
}
