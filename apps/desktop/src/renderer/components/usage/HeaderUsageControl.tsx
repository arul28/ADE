import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise as RefreshCw, ArrowSquareOut, Gauge, X } from "@phosphor-icons/react";
import type {
  AiProviderConnections,
  UsageProvider,
  UsageSnapshot,
} from "../../../shared/types";
import { navigateToAppTarget } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { headerUsageProviders } from "./usageLimitModel";
import { UsageLimitsBand } from "./UsageLimitsBand";
import {
  USAGE_BUTTON_CLASS,
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_OVERLAY_BG_CLASS,
  USAGE_TEXT,
} from "./usageDesign";
import { formatUpdatedAge } from "./usageWindowFormat";
import { useAppStore } from "../../state/appStore";
import { usageProviderLogo } from "../terminals/ToolLogos";
import { providerColor } from "./providerColors";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { useUsageSnapshot } from "./useUsageSnapshot";

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  grok: "Grok",
  opencode: "OpenCode",
};

function ProviderLogo({ provider, size = 14 }: { provider: UsageProvider; size?: number }) {
  const Logo = usageProviderLogo(provider);
  return <Logo size={size} />;
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

/**
 * Headroom, matching the popup ("19% left"). The ring and the accessible name
 * both use this number. The bar used to print the consumed share, so the same
 * window read "wk 81%" in the top bar and "wk 19% left" one click later.
 */
function headroomPercent(percentUsed: number | null): number | null {
  if (percentUsed == null) return null;
  return Math.max(0, Math.min(100, Math.round(100 - percentUsed)));
}

function headroomLabel(percentUsed: number | null): string {
  const left = headroomPercent(percentUsed);
  return left == null ? "…" : `${left}% left`;
}

function formatUsageTitle(provider: UsageProvider, usage: HeaderUsageWindowSummary): string {
  const plan = `${usage.planLabel} ${headroomLabel(usage.planPercent)}`;
  // Claude and Codex always speak both windows. A provider that only has a
  // plan window (Cursor, Copilot, Grok) does not grow an empty 5h slot.
  if (provider === "claude" || provider === "codex" || usage.fiveHourPercent != null) {
    return `${plan}, 5h ${headroomLabel(usage.fiveHourPercent)}`;
  }
  return plan;
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

const USAGE_RING_SIZE = 22;
const USAGE_RING_STROKE = 1.5;
const USAGE_RING_LOGO = 16;

/**
 * One provider mark, drawn tight around the logo.
 *
 * The pale arc is what has been used. It starts at 12 o'clock and grows
 * clockwise as usage goes up. What is left stays the saturated brand colour.
 * The pale tint is opaque and much lighter than the brand, so a small change
 * in the week is visible. A provider with no week uses its month.
 */
function HeaderProviderUsageRing({
  provider,
  usage,
}: {
  provider: UsageProvider;
  usage: HeaderUsageWindowSummary;
}) {
  const theme = useAppStore((state) => state.theme);
  const color = providerColor(provider, theme);
  const left = headroomPercent(usage.planPercent);
  const used = left == null ? null : 100 - left;
  const center = USAGE_RING_SIZE / 2;
  const radius = (USAGE_RING_SIZE - USAGE_RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedDash = used == null ? 0 : (used / 100) * circumference;
  // Pale and opaque, far from the brand. On a dark header that is almost
  // white; on a light header a near-white arc would vanish, so the light
  // theme stays a pale tint of the page instead.
  const unshaded = theme === "light"
    ? `color-mix(in srgb, ${color} 14%, #eceae6)`
    : `color-mix(in srgb, ${color} 8%, white)`;
  const title = `${PROVIDER_LABEL[provider]} ${formatUsageTitle(provider, usage)}`;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: USAGE_RING_SIZE, height: USAGE_RING_SIZE }}
      title={title}
      data-usage-provider={provider}
      data-usage-window={usage.planLabel}
      data-usage-left={left == null ? "" : String(left)}
      data-usage-unshaded={used == null ? "" : String(used)}
    >
      <svg
        width={USAGE_RING_SIZE}
        height={USAGE_RING_SIZE}
        viewBox={`0 0 ${USAGE_RING_SIZE} ${USAGE_RING_SIZE}`}
        aria-hidden="true"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={left == null ? unshaded : color}
          strokeWidth={USAGE_RING_STROKE}
        />
        {used != null && used > 0 ? (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={unshaded}
            strokeWidth={USAGE_RING_STROKE}
            strokeDasharray={used >= 100 ? undefined : `${usedDash} ${circumference - usedDash}`}
            transform={`rotate(-90 ${center} ${center})`}
            data-ring-unshaded="true"
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <ProviderLogo provider={provider} size={USAGE_RING_LOGO} />
      </span>
    </span>
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

  const detectedProviders = useMemo<UsageProvider[]>(() => headerUsageProviders({
    connections: providerConnections,
    windows: snapshot?.windows,
    statuses: snapshot?.providerStatus,
  }), [providerConnections, snapshot?.windows, snapshot?.providerStatus]);

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
    ({ provider, usage }) => `${PROVIDER_LABEL[provider]} ${formatUsageTitle(provider, usage)}`,
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
        "ade-shell-control shrink-0 inline-flex items-center gap-0.5 rounded-md px-0.5 py-0.5",
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
        <div className="flex flex-nowrap items-center justify-end gap-0.5">
          {providersWithUsage.map(({ provider, usage }) => (
            <HeaderProviderUsageRing key={provider} provider={provider} usage={usage} />
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
