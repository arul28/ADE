import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise as RefreshCw, ArrowSquareOut, Gauge, X } from "@phosphor-icons/react";
import type {
  AiProviderConnections,
  UsageProvider,
  UsageSnapshot,
} from "../../../shared/types";
import { hasLocalProviderConnectionSignal } from "../../lib/aiProviderStatus";
import { navigateToAppTarget } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { UsageLimitsBand } from "./UsageLimitsBand";
import {
  USAGE_BUTTON_CLASS,
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_OVERLAY_BG_CLASS,
  USAGE_TEXT,
  usagePressureColor,
} from "./usageDesign";
import { formatUpdatedAge } from "./usageWindowFormat";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { useUsageSnapshot } from "./useUsageSnapshot";

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

const WARNING_COLOR = "var(--color-usage-warn, #F5A623)";

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

// The chip stays quota-led: it is the ambient "am I about to be cut off"
// signal. Its thresholds are the shared ones, so "nearly dry" means the same
// thing in the top bar as it does on the Usage page. Below the warn threshold
// it reads calm green rather than a provider brand colour, because the chip
// carries no provider identity.
function percentStyle(percent: number | null): React.CSSProperties {
  return {
    color: percent == null
      ? "var(--color-muted-fg)"
      : usagePressureColor(percent, "var(--color-usage-ok, #34D399)"),
  };
}

function formatUsageTitle(usage: HeaderUsageWindowSummary): string {
  return `${usage.planLabel} ${percentLabel(usage.planPercent)}, 5h ${percentLabel(usage.fiveHourPercent)}`;
}

function formatUpdatedAgo(snapshot: UsageSnapshot | null, nowMs: number): string {
  const age = formatUpdatedAge(snapshot?.lastPolledAt, nowMs);
  return age === "not updated" ? "" : `updated ${age}`;
}

// A quiet, non-destructive warning: data is being shown, but the last refresh
// failed, needs re-authentication, or has nothing yet.
function usageWarning(snapshot: UsageSnapshot | null): { warn: boolean; detail: string | null } {
  const issues: string[] = [];
  if (snapshot?.spendControlReached === true) {
    issues.push("Codex spending cap reached");
  }
  const statuses = snapshot?.providerStatus;
  if (statuses) {
    for (const [provider, status] of Object.entries(statuses)) {
      if (status && status.state !== "ok") {
        issues.push(status.message ?? `${PROVIDER_LABEL[provider as UsageProvider] ?? provider} unavailable`);
      }
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
      <span
        className={cn("inline-flex items-center gap-0.5 font-semibold", USAGE_TEXT.micro, USAGE_NUMERIC_CLASS)}
      >
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
  const [providerConnections, setProviderConnections] =
    useState<AiProviderConnections | null | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The single subscription behind this surface. The band inside the popover
  // used to own a second one — its own ordering guard, binding generation and
  // refresh path — and hand its snapshot back up through `onSnapshotChange`,
  // so the copy here was only ever overwritten by the copy down there.
  const usage = useUsageSnapshot({
    readSnapshot: !deferInitialRead || open,
    // Demand is raised only while the popover is actually on screen: it tells
    // the adaptive scheduler this surface is being watched, which is not true
    // of a closed popover behind a chip.
    noteDemand: open,
  });
  const { snapshot, refreshing, bindingRevision, refreshNow } = usage;

  // Tick the "updated Xs ago" label only while the popup is open — it is the
  // only place the label is drawn.
  //
  // `snapshot` is a dependency so the clock is re-seeded when one arrives
  // rather than only when the popover opened. Two windows handed the same
  // snapshot then measure its age from the same instant, instead of each from
  // whenever its own popover happened to open.
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [open, snapshot]);

  // Drop the previous runtime's answer the moment the binding changes, so the
  // old project's meters are not drawn for the fraction of a second the new
  // answer is in flight. Keyed off a ref rather than folded into the fetch
  // effect below, which also re-runs when the popover opens — clearing there
  // would flicker the chips on every open.
  const clearedBindingRef = useRef(bindingRevision);
  useEffect(() => {
    if (clearedBindingRef.current === bindingRevision) return;
    clearedBindingRef.current = bindingRevision;
    setProviderConnections(undefined);
  }, [bindingRevision]);

  // Fetch provider connection status so the header only shows configured
  // Claude/Codex usage meters.
  useEffect(() => {
    if (!window.ade?.ai?.getStatus) return;
    if (deferInitialRead && !open) {
      setProviderConnections(undefined);
      return;
    }
    // `bindingRevision` is a dependency, not a value: provider connections are
    // resolved by whichever runtime the project is bound to, so a rebind (open
    // a project, connect a remote) has to re-ask. The bare `void` is what keeps
    // it in the dependency array — nothing reads it, and without the reference
    // it reads as an unused dep and gets removed, which silently pins the chips
    // to the previous runtime's answer.
    void bindingRevision;
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
  }, [bindingRevision, deferInitialRead, open]);

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
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium text-muted-fg transition-colors duration-150 hover:bg-muted hover:text-fg",
        USAGE_TEXT.micro,
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
        style={{ color: hasErrors ? WARNING_COLOR : "var(--color-accent)" }}
      />
      <span className="min-w-0 flex-1 truncate">Usage</span>
      {providersWithUsage.length > 0 ? (
        <span className={cn("shrink-0 text-muted-fg", USAGE_TEXT.micro, USAGE_NUMERIC_CLASS)}>
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
        "font-medium transition-colors duration-150",
        USAGE_TEXT.micro,
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
          style={{ color: hasErrors ? WARNING_COLOR : "var(--color-accent)" }}
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
            // The shell surface, the same hook every other top-bar popover
            // reads. An earlier pass moved this to `bg-surface-overlay`, which
            // is `rgba(255,255,255,0.92)` on the light theme — the popover read
            // as see-through and unanchored. A popover over live content needs
            // to be opaque; that is what this variable is for.
            //
            // The fallback is the theme's raised token rather than the shell's
            // literal `#121019`, because everything inside is drawn in `text-fg`
            // and a fixed dark plate would be dark-on-dark under the light
            // theme. `USAGE_OVERLAY_BG_CLASS` keeps this identical to the chart
            // and heatmap readouts.
            className={cn(
              "absolute right-3 top-10 max-h-[calc(100vh-72px)] w-[min(420px,calc(100vw-24px))] overflow-y-auto",
              "rounded-xl border shadow-2xl shadow-black/45",
              USAGE_HAIRLINE_CLASS,
              USAGE_OVERLAY_BG_CLASS,
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
            <div
              className={cn(
                "sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3",
                USAGE_DIVIDER_COLOR_CLASS,
                USAGE_OVERLAY_BG_CLASS,
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Gauge size={16} weight="regular" className="shrink-0 text-muted-fg" />
                <div id="header-usage-title" className={cn("truncate font-semibold text-fg", USAGE_TEXT.body)}>
                  Usage
                </div>
              </div>
              <div className="flex items-center gap-2">
                {updatedAgo ? (
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-muted-fg",
                      USAGE_TEXT.micro,
                      USAGE_NUMERIC_CLASS,
                    )}
                  >
                    <span>{updatedAgo}</span>
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: warning.warn
                          ? WARNING_COLOR
                          : "var(--color-usage-ok, #34D399)",
                      }}
                      title={warning.warn ? warning.detail ?? "Some usage couldn't be refreshed" : "Usage is up to date"}
                      aria-label={warning.warn ? warning.detail ?? "Some usage couldn't be refreshed" : undefined}
                      aria-hidden={warning.warn ? undefined : true}
                    />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-7 w-7 items-center justify-center rounded-md"
                  data-variant="ghost"
                  onClick={() => void refreshNow()}
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
            <div className="flex flex-col gap-3 p-3">
              <UsageLimitsBand nowMs={nowMs} usage={usage} />
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigateToAppTarget({ kind: "settings", tab: "stats", anchor: "ade-usage" });
                }}
                className={cn(USAGE_BUTTON_CLASS, "min-h-9 justify-center", USAGE_TEXT.detail)}
              >
                Open Usage
                <ArrowSquareOut size={12} weight="regular" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
