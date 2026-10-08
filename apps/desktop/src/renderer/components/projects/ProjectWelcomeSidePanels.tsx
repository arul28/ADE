import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, type Icon } from "@phosphor-icons/react";
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
import {
  acknowledgeActivityItem,
  useActivityStore,
} from "../../state/activityStore";
import { activitySections } from "../activity/activityPriority";
import { activityBoardColumn } from "../../../shared/attention/activityBoardColumn";
import {
  ACTIVITY_COLUMN_PRESENTATION,
  activityItemFailed,
} from "../activity/activityPresentation";
import { ActivityColumnMark } from "../activity/ActivityColumnMark";
import { deriveLaneMachineOptions } from "../lanes/laneMachines";
import {
  buildAccountRows,
  poolAccounts,
  quotaPopoverProviders,
} from "../usage/usageLimitModel";
import { useUsageSnapshot } from "../usage/useUsageSnapshot";
import { windowLabel } from "../usage/usageWindowFormat";
import type { WebMachineEntry } from "../../webclient/workspace/webWorkspaceModel";
import { welcomeRelativeTime } from "./ProjectWelcomeWebRows";
import "../activity/Activity.css";
import { humanizeProvider } from "../usage/usageProviderNames";

// ---------------------------------------------------------------------------
// The welcome page's data: chats that are still running, usage limits and
// machines. Each reads state the renderer already holds — the account Activity
// stream AppShell keeps in sync, the usage snapshot subscription, and the
// remote-runtime connection snapshot — and adds no polling. The home screen's
// cards and tiles (ProjectWelcomeHome.tsx) render them.
// ---------------------------------------------------------------------------

/** The one card header: icon · label · count ………… action. */
export function WelcomeCardHead({
  icon: IconGlyph,
  title,
  count,
  action,
  children,
}: {
  icon: Icon;
  title: string;
  count?: number | null;
  action?: { label: string; onClick: () => void } | null;
  children?: ReactNode;
}) {
  return (
    <div className="kit-card-head">
      <IconGlyph size={14} weight="regular" aria-hidden />
      <span className="ade-welcome-head-title">{title}</span>
      {count != null ? <span className="kit-card-head-count">{count}</span> : null}
      {children}
      {action ? (
        <button type="button" className="kit-card-head-action" onClick={action.onClick}>
          {action.label}
          <ArrowRight size={11} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ── still running ──────────────────────────────────────────────────

const RUNNING_GROUPS = new Set(["needs_you", "working"]);

function navigationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "ADE couldn’t open the exact machine and project for this chat.";
}

/** Agent chats that are working or waiting on you, on every machine. */
export function useRunningChats(): AttentionItem[] {
  const itemsById = useActivityStore((state) => state.itemsById);
  return useMemo(
    () => activitySections(itemsById)
      .filter((section) => RUNNING_GROUPS.has(section.id))
      .flatMap((section) => section.items),
    [itemsById],
  );
}

/** Opens an Activity item the way the Activity pane does; resolves to an error message or null. */
export async function openAttentionItem(item: AttentionItem): Promise<string | null> {
  try {
    const bridge = window.ade?.attention;
    if (bridge?.openItem) await bridge.openItem(item);
    else openAdeDeeplink(attentionDestinationDeepLink(item.destination, item));
  } catch (openError) {
    return navigationErrorMessage(openError);
  }
  await acknowledgeActivityItem(item.id, "seen").catch(() => {});
  return null;
}

export function RunningList({ items }: { items: AttentionItem[] }) {
  const availability = useActivityStore((state) => state.availability);
  const [error, setError] = useState<string | null>(null);

  const openItem = useCallback(async (item: AttentionItem) => {
    setError(null);
    setError(await openAttentionItem(item));
  }, []);

  if (items.length === 0) {
    return (
      <div className="ade-welcome-empty">
        {availability?.state === "signed_out"
          ? "Nothing running on this machine. Sign in to include your other machines."
          : "Nothing running right now."}
      </div>
    );
  }

  return (
    <div role="list">
      {items.map((item) => {
        const column = activityBoardColumn(item) ?? "working";
        const failed = activityItemFailed(item);
        const label = failed ? "Failed" : ACTIVITY_COLUMN_PRESENTATION[column].label;
        const tone = failed ? "red" : ACTIVITY_COLUMN_PRESENTATION[column].tone;
        const since = welcomeRelativeTime(item.statusSince ?? item.updatedAt);
        return (
          <button
            key={item.id}
            type="button"
            role="listitem"
            className="kit-row ade-welcome-item"
            onClick={() => void openItem(item)}
            title={`${item.title} — ${item.project.name} · ${item.machine.name}`}
          >
            <span className={`ade-welcome-item-glyph activity-tone-${tone}`} aria-label={label}>
              <ActivityColumnMark column={column} failed={failed} size={12} />
            </span>
            <span className="ade-welcome-item-text">
              <span className="ade-welcome-item-title">{item.title}</span>
              <span className="ade-welcome-item-sub">
                {item.project.name} · {item.machine.name}
              </span>
            </span>
            <span className={`ade-welcome-item-state activity-tone-${tone}`}>
              {column === "needs_you" ? label : since ?? label}
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


export type UsageLine = {
  key: string;
  /** The account's short name, or null when the provider has one account. */
  label: string | null;
  providerLabel: string;
  /** The tightest main window (5h / weekly / monthly): least headroom wins. */
  percentLeft: number;
  resetsInMs: number;
  title: string;
};

export type UsageGroup = {
  provider: UsageProvider;
  lines: UsageLine[];
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
 * The name that tells two logins on one provider apart: the account's own
 * label when it has a real one ("Work"), else the email's local part.
 * "Default" is what most hosts send, so it never counts as a name.
 */
function accountShortLabel(account: { label?: string; email?: string } | null): string | null {
  const label = account?.label?.trim();
  if (label && label.toLowerCase() !== "default") return label;
  const local = account?.email?.split("@")[0]?.trim();
  return local || label || null;
}

/**
 * One group per provider, one line per account: its longest main window
 * (monthly, else weekly, else 5h) — the quota that says how much room is left
 * overall. The full band — every window, pace, resets — is the top-bar popover
 * "Details" opens. Same subscription, provider filter and account pooling as
 * that band.
 */
export function useUsageGroups(): { groups: UsageGroup[]; bridgeMissing: boolean; loaded: boolean } {
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

  const groups = useMemo(() => {
    if (!snapshot) return [];
    const providers = quotaPopoverProviders({
      connections,
      windows: snapshot.windows,
      statuses: snapshot.providerStatus,
    });
    const accounts = poolAccounts(snapshot.accounts);
    const result: UsageGroup[] = [];
    for (const provider of providers) {
      const windows = snapshot.windows.filter((window) => window.provider === provider);
      const rows = buildAccountRows(provider, windows, accounts, nowMs);
      const lines: UsageLine[] = [];
      for (const row of rows) {
        // The main windows (5h, weekly, monthly) when there are any; the side
        // limits only stand in when a provider reports nothing else. Of those,
        // the one with the least headroom is what the summary shows.
        const main = row.cells.filter((cell) => windowRank(cell.segment.window) >= 10);
        const candidates = main.length > 0 ? main : row.cells;
        const shown = candidates.reduce<(typeof row.cells)[number] | null>(
          (best, cell) => (!best || cell.segment.percentLeft < best.segment.percentLeft ? cell : best),
          null,
        );
        // A login with no reading yet (never polled, host unreachable) says
        // nothing useful in a summary.
        if (!shown) continue;
        const label = accountShortLabel(row.account);
        const who = row.account?.email?.trim() || label;
        const detail = row.cells
          .map((cell) => `${windowLabel(cell.segment.window)} ${Math.round(cell.segment.percentLeft)}% left`)
          .join(" · ");
        lines.push({
          key: row.key,
          label,
          providerLabel: humanizeProvider(provider),
          percentLeft: shown.segment.percentLeft,
          resetsInMs: shown.segment.resetsInMs,
          title: `${humanizeProvider(provider)}${who ? ` · ${who}` : ""} — ${detail}`,
        });
      }
      if (lines.length === 0) continue;
      // One login names nothing; the provider row says it all.
      if (lines.length === 1) lines[0] = { ...lines[0]!, label: null };
      result.push({ provider, lines });
    }
    return result;
  }, [connections, nowMs, snapshot]);

  return { groups, bridgeMissing, loaded: snapshot != null };
}

export function openUsageDetails(): void {
  if (requestUsagePopover()) return;
  navigateToAppTarget({ kind: "settings", tab: "stats", anchor: "ade-usage" });
}

// ── machines ───────────────────────────────────────────────────────

export type MachineRow = {
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

export function desktopMachineRows(snapshot: RemoteRuntimeConnectionSnapshot | null): MachineRow[] {
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

export function webMachineRows(machines: readonly WebMachineEntry[]): MachineRow[] {
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

export function openMachines(webMode: boolean): void {
  if (webMode) {
    window.dispatchEvent(new CustomEvent("ade-web:open-connections", { detail: { tab: "machines" } }));
    return;
  }
  openConnectionsPanel("machines");
}
