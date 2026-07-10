import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise as RefreshCw, Gauge, X } from "@phosphor-icons/react";
import type {
  AiProviderConnections,
  UsageProvider,
  UsageSnapshot,
} from "../../../shared/types";
import { hasLocalProviderConnectionSignal } from "../../lib/aiProviderStatus";
import { cn } from "../ui/cn";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const TRACKED_PROVIDERS: UsageProvider[] = ["claude", "codex"];

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

function ProviderLogo({ provider, size = 14 }: { provider: UsageProvider; size?: number }) {
  if (provider === "claude") return <ClaudeLogo size={size} />;
  if (provider === "codex") return <CodexLogo size={size} />;
  return null;
}

function thresholdColor(percent: number): string {
  if (percent >= 100) return "#EF4444";
  if (percent >= 75) return "#F59E0B";
  return "#22C55E";
}

function clampPercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent));
}

function windowPercentFor(
  snapshot: UsageSnapshot | null,
  provider: UsageProvider,
  windowType: "five_hour" | "weekly" | "monthly",
): number | null {
  if (!snapshot) return null;
  const window = snapshot.windows.find((w) => w.provider === provider && w.windowType === windowType);
  if (!window) return null;
  return clampPercent(window.percentUsed);
}

const HEADER_USAGE_PROVIDER_STATUS_REFRESH_MS = 300_000;

type HeaderUsageWindowSummary = {
  fiveHourPercent: number | null;
  planPercent: number | null;
  planLabel: "wk" | "mo";
};

function headerUsageFor(snapshot: UsageSnapshot | null, provider: UsageProvider): HeaderUsageWindowSummary {
  const weeklyPercent = windowPercentFor(snapshot, provider, "weekly");
  const monthlyPercent = windowPercentFor(snapshot, provider, "monthly");
  return {
    fiveHourPercent: windowPercentFor(snapshot, provider, "five_hour"),
    planPercent: weeklyPercent ?? monthlyPercent,
    planLabel: weeklyPercent == null && monthlyPercent != null ? "mo" : "wk",
  };
}

function percentLabel(percent: number | null): string {
  return percent == null ? "…" : `${Math.round(percent)}%`;
}

function percentStyle(percent: number | null): React.CSSProperties {
  return {
    color: percent == null ? "var(--color-muted-fg)" : thresholdColor(percent),
  };
}

function formatUsageTitle(usage: HeaderUsageWindowSummary): string {
  return `${usage.planLabel} ${percentLabel(usage.planPercent)}, 5h ${percentLabel(usage.fiveHourPercent)}`;
}

function snapshotLastPolledMs(snapshot: UsageSnapshot | null): number | null {
  if (!snapshot) return null;
  const timestamp = Date.parse(snapshot.lastPolledAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldApplyCachedSnapshot(
  nextSnapshot: UsageSnapshot | null,
  currentSnapshot: UsageSnapshot | null,
): boolean {
  if (!currentSnapshot) return true;
  if (!nextSnapshot) return false;
  const nextTimestamp = snapshotLastPolledMs(nextSnapshot);
  const currentTimestamp = snapshotLastPolledMs(currentSnapshot);
  return nextTimestamp == null || currentTimestamp == null || nextTimestamp >= currentTimestamp;
}

function formatUpdatedAgo(snapshot: UsageSnapshot | null, nowMs: number): string {
  const t = snapshot ? Date.parse(snapshot.lastPolledAt) : Number.NaN;
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 5) return "updated just now";
  if (sec < 60) return `updated ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `updated ${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `updated ${hr}h ago`;
  return `updated ${Math.round(hr / 24)}d ago`;
}

// A quiet, non-destructive warning: data is being shown, but the last refresh
// failed, needs re-authentication, or has nothing yet.
function usageWarning(snapshot: UsageSnapshot | null): { warn: boolean; detail: string | null } {
  const statuses = snapshot?.providerStatus;
  if (!statuses) return { warn: false, detail: null };
  const issues: string[] = [];
  for (const [provider, status] of Object.entries(statuses)) {
    if (status && status.state !== "ok") {
      issues.push(status.message ?? `${PROVIDER_LABEL[provider as UsageProvider] ?? provider} unavailable`);
    }
  }
  return { warn: issues.length > 0, detail: issues.length > 0 ? issues.join(" · ") : null };
}

function HeaderProviderUsageChip({
  provider,
  usage,
}: {
  provider: UsageProvider;
  usage: HeaderUsageWindowSummary;
}) {
  return (
    <div
      className="flex items-center gap-1"
      title={`${PROVIDER_LABEL[provider]} ${formatUsageTitle(usage)}`}
    >
      <ProviderLogo provider={provider} size={14} />
      <span className="inline-flex items-center gap-0.5 font-mono text-[9px] font-semibold tabular-nums">
        <span className="text-muted-fg">{usage.planLabel}</span>
        <span style={percentStyle(usage.planPercent)}>{percentLabel(usage.planPercent)}</span>
      </span>
    </div>
  );
}

export function HeaderUsageControl({
  variant = "chip",
  onMenuActivate,
  deferInitialRead = false,
}: {
  variant?: "chip" | "menu-row";
  onMenuActivate?: () => void;
  deferInitialRead?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [providerConnections, setProviderConnections] =
    useState<AiProviderConnections | null | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<UsageSnapshot | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick the "updated Xs ago" label only while the popup is open.
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const applySnapshot = useCallback((nextSnapshot: UsageSnapshot | null) => {
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!window.ade?.usage?.refresh) return;
    setRefreshing(true);
    try {
      const next = await window.ade.usage.refresh();
      if (next) applySnapshot(next);
    } catch {
      // swallow
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (!window.ade?.usage) return;
    const usageBridge = window.ade.usage;
    let cancelled = false;
    const readSnapshot = async () => {
      try {
        const nextSnapshot = await usageBridge.getSnapshot();
        return { failed: false, snapshot: nextSnapshot };
      } catch {
        return { failed: true, snapshot: null };
      }
    };
    const unsubscribe = usageBridge.onUpdate?.((nextSnapshot) => {
      if (!cancelled) applySnapshot(nextSnapshot);
    });
    const readCachedSnapshot = () => {
      if (cancelled) return;
      void readSnapshot().then(({ failed, snapshot: nextSnapshot }) => {
        if (cancelled) return;
        const currentSnapshot = snapshotRef.current;
        if (failed && currentSnapshot) return;
        if (!shouldApplyCachedSnapshot(nextSnapshot, currentSnapshot)) return;
        applySnapshot(nextSnapshot);
      });
    };

    if (!deferInitialRead || open) {
      readCachedSnapshot();
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applySnapshot, deferInitialRead, open]);

  // Fetch provider connection status so the header only shows configured
  // Claude/Codex usage meters.
  useEffect(() => {
    if (!window.ade?.ai?.getStatus) return;
    if (deferInitialRead && !open) {
      setProviderConnections(undefined);
      return;
    }
    const aiBridge = window.ade.ai;
    let cancelled = false;
    const loadProviderStatus = () => {
      aiBridge.getStatus()
        .then((status) => {
          if (!cancelled) setProviderConnections(status.providerConnections ?? null);
        })
        .catch(() => {
          if (!cancelled) setProviderConnections(null);
        });
    };
    loadProviderStatus();
    const interval = window.setInterval(loadProviderStatus, HEADER_USAGE_PROVIDER_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [deferInitialRead, open]);

  const detectedProviders = useMemo<UsageProvider[]>(() => {
    const providersWithUsage = TRACKED_PROVIDERS.filter((provider) =>
      snapshot?.windows.some((window) => window.provider === provider),
    );
    if (!providerConnections) {
      return providersWithUsage;
    }
    const configuredProviders = TRACKED_PROVIDERS.filter(
      (provider) => hasLocalProviderConnectionSignal(providerConnections[provider]),
    );
    return configuredProviders.length > 0 ? configuredProviders : providersWithUsage;
  }, [providerConnections, snapshot?.windows]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    return () => {
      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));
    };
  }, [open]);

  const providersWithUsage = useMemo(
    () => detectedProviders.map((provider) => ({
      provider,
      usage: headerUsageFor(snapshot, provider),
    })),
    [detectedProviders, snapshot],
  );
  const warning = useMemo(() => usageWarning(snapshot), [snapshot]);
  const hasErrors = warning.warn;
  const updatedAgo = formatUpdatedAgo(snapshot, nowMs);

  const titleParts = providersWithUsage.map(
    ({ provider, usage }) => `${PROVIDER_LABEL[provider]} ${formatUsageTitle(usage)}`,
  );
  let buttonTitle: string;
  if (titleParts.length > 0) {
    buttonTitle = `Usage · ${titleParts.join(" · ")}${hasErrors ? " · warnings" : ""}`;
  } else if (hasErrors) {
    buttonTitle = "Usage · warnings";
  } else {
    buttonTitle = "Usage";
  }

  const openUsage = () => {
    setOpen(true);
    onMenuActivate?.();
  };

  const trigger = variant === "menu-row" ? (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-fg/80 transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg/90",
      )}
      onClick={openUsage}
      title={buttonTitle}
      aria-label={buttonTitle}
      aria-expanded={open}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <Gauge
        size={12}
        weight="regular"
        className={cn("shrink-0", hasErrors && "animate-pulse")}
        style={{ color: hasErrors ? "#F59E0B" : "var(--color-accent)" }}
      />
      <span className="min-w-0 flex-1 truncate">Usage</span>
      {providersWithUsage.length > 0 ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-fg/55">
          {providersWithUsage.map(({ provider, usage }) => (
            `${PROVIDER_LABEL[provider]} ${percentLabel(usage.planPercent)}`
          )).join(" · ")}
        </span>
      ) : null}
    </button>
  ) : (
    <button
      type="button"
      className={cn(
        "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1",
        "text-[11px] font-medium transition-colors duration-150",
      )}
      data-variant="ghost"
      onClick={() => setOpen((value) => !value)}
      title={buttonTitle}
      aria-label={buttonTitle}
      aria-expanded={open}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {providersWithUsage.length > 0 ? (
        <div className="flex items-center gap-2">
          {providersWithUsage.map(({ provider, usage }) => (
            <HeaderProviderUsageChip key={provider} provider={provider} usage={usage} />
          ))}
        </div>
      ) : (
        <Gauge
          size={18}
          weight="regular"
          className={cn(hasErrors && "animate-pulse")}
          style={{ color: hasErrors ? "#F59E0B" : "var(--color-accent)" }}
        />
      )}
    </button>
  );

  return (
    <>
      {trigger}

      {open ? (
        <div
          className="fixed inset-0 z-[80]"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => setOpen(false)}
        >
          <div
            ref={panelRef}
            className={cn(
              "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(520px,calc(100vw-24px))] overflow-y-auto",
              "rounded-xl border border-white/10 bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/45"
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby="header-usage-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              }
            }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[color:var(--ade-shell-surface,#121019)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Gauge size={16} weight="regular" className="shrink-0 opacity-85" />
                <div id="header-usage-title" className="truncate text-[13px] font-semibold">
                  Usage
                </div>
              </div>
              <div className="flex items-center gap-2">
                {updatedAgo ? (
                  <span className="flex items-center gap-1.5 text-[10.5px] tabular-nums text-fg/40">
                    <span>{updatedAgo}</span>
                    {warning.warn ? (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-amber-400/80"
                        title={warning.detail ?? "Some usage couldn't be refreshed"}
                        aria-label={warning.detail ?? "Some usage couldn't be refreshed"}
                      />
                    ) : (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-emerald-400/70"
                        title="Usage is up to date"
                        aria-hidden
                      />
                    )}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                  data-variant="ghost"
                  onClick={() => void handleRefresh()}
                  disabled={refreshing}
                  title="Refresh usage"
                >
                  <RefreshCw size={13} weight="regular" className={cn(refreshing && "animate-spin")} />
                </button>
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                  data-variant="ghost"
                  onClick={() => setOpen(false)}
                  title="Close usage"
                >
                  <X size={13} weight="regular" />
                </button>
              </div>
            </div>
            <div className="space-y-3 p-3">
              <UsageQuotaPanel onSnapshotChange={applySnapshot} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
