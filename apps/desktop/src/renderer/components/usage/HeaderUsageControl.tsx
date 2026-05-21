import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretRight, Gauge, X } from "@phosphor-icons/react";
import type {
  AiProviderConnections,
  BudgetCapConfig,
  UsageProvider,
  UsageSnapshot,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { BudgetCapEditor } from "../settings/BudgetCapEditor";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

const OPEN_USAGE_EVENT = "ade-open-usage-drawer";
const HEADER_USAGE_REFRESH_INTERVAL_MS = 120_000;
const HEADER_USAGE_FOCUS_REFRESH_STALE_MS = 60_000;
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
  return `5h ${percentLabel(usage.fiveHourPercent)}, ${usage.planLabel} ${percentLabel(usage.planPercent)}`;
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
        <span className="text-muted-fg">5h</span>
        <span style={percentStyle(usage.fiveHourPercent)}>{percentLabel(usage.fiveHourPercent)}</span>
        <span className="ml-1 text-muted-fg">{usage.planLabel}</span>
        <span style={percentStyle(usage.planPercent)}>{percentLabel(usage.planPercent)}</span>
      </span>
    </div>
  );
}

export function HeaderUsageControl() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [providerConnections, setProviderConnections] = useState<AiProviderConnections | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<UsageSnapshot | null>(null);

  const applySnapshot = useCallback((nextSnapshot: UsageSnapshot | null) => {
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
  }, []);

  useEffect(() => {
    if (!window.ade?.usage) return;
    const usageBridge = window.ade.usage;
    let cancelled = false;
    let requestSerial = 0;
    const readSnapshot = async (force: boolean) => {
      try {
        const nextSnapshot = force
          ? await usageBridge.refresh()
          : await usageBridge.getSnapshot();
        return { failed: false, snapshot: nextSnapshot };
      } catch {
        return { failed: true, snapshot: null };
      }
    };
    const unsubscribe = usageBridge.onUpdate?.((nextSnapshot) => {
      if (!cancelled) applySnapshot(nextSnapshot);
    });
    const refreshIfMounted = (force: boolean) => {
      if (cancelled) return;
      const currentRequest = ++requestSerial;
      void readSnapshot(force).then(({ failed, snapshot: nextSnapshot }) => {
        if (cancelled) return;
        if (failed && snapshotRef.current) return;
        const isLatestRequest = currentRequest === requestSerial;
        const isInitialCachedSnapshot = !force && snapshotRef.current == null;
        if (isLatestRequest || isInitialCachedSnapshot) applySnapshot(nextSnapshot);
      });
    };

    // Get any cached value onto the button immediately, then force a poll so a
    // cold app launch does not wait for the drawer to be opened.
    refreshIfMounted(false);
    refreshIfMounted(true);

    const interval = window.setInterval(() => {
      refreshIfMounted(true);
    }, HEADER_USAGE_REFRESH_INTERVAL_MS);

    const refreshOnFocus = () => {
      if (cancelled) return;
      const latestSnapshot = snapshotRef.current;
      const lastPolledAt = latestSnapshot?.lastPolledAt ? new Date(latestSnapshot.lastPolledAt).getTime() : 0;
      if (!lastPolledAt || Date.now() - lastPolledAt >= HEADER_USAGE_FOCUS_REFRESH_STALE_MS) {
        refreshIfMounted(true);
      }
    };
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      unsubscribe?.();
    };
  }, [applySnapshot]);

  // Fetch provider connection status so we can hide providers whose CLI is
  // not installed on this machine.
  useEffect(() => {
    if (!window.ade?.ai?.getStatus) return;
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
  }, []);

  // Listen for programmatic open requests (used by the threshold toast).
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_USAGE_EVENT, handler);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, handler);
  }, []);

  const detectedProviders = useMemo<UsageProvider[]>(() => {
    if (!providerConnections) return TRACKED_PROVIDERS;
    return TRACKED_PROVIDERS.filter(
      (provider) => providerConnections[provider]?.runtimeDetected !== false,
    );
  }, [providerConnections]);

  useEffect(() => {
    if (!open || !window.ade?.usage?.getBudgetConfig) return;
    let cancelled = false;
    window.ade.usage
      .getBudgetConfig()
      .then((config) => {
        if (!cancelled) setBudgetConfig(config);
      })
      .catch((err) => {
        if (!cancelled) setBudgetError(extractError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveBudget = useCallback(async (next: BudgetCapConfig) => {
    if (!window.ade?.usage?.saveBudgetConfig) {
      setBudgetError("Budget save bridge unavailable.");
      return;
    }
    setBudgetSaving(true);
    setBudgetError(null);
    try {
      const saved = await window.ade.usage.saveBudgetConfig(next);
      setBudgetConfig(saved);
    } catch (err) {
      setBudgetError(extractError(err));
    } finally {
      setBudgetSaving(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const providersWithUsage = useMemo(
    () => detectedProviders.map((provider) => ({
      provider,
      usage: headerUsageFor(snapshot, provider),
    })),
    [detectedProviders, snapshot],
  );
  const hasErrors = (snapshot?.errors.length ?? 0) > 0;

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

  return (
    <>
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
            <div className="space-y-3 p-3">
              <UsageQuotaPanel onSnapshotChange={applySnapshot} />

              <section
                className="rounded-lg border border-white/10 bg-card/95 p-3 backdrop-blur-sm"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left"
                  onClick={() => setGuardrailsOpen((value) => !value)}
                  aria-expanded={guardrailsOpen}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-fg">Automation guardrails</div>
                    <div className="mt-0.5 text-[11px] text-muted-fg">
                      Shared budget rules that govern automation runs.
                    </div>
                  </div>
                  {guardrailsOpen ? (
                    <CaretDown size={14} weight="regular" className="shrink-0 opacity-70" />
                  ) : (
                    <CaretRight size={14} weight="regular" className="shrink-0 opacity-70" />
                  )}
                </button>

                {guardrailsOpen ? (
                  <div className="mt-3">
                    <BudgetCapEditor
                      config={budgetConfig}
                      saving={budgetSaving}
                      saveError={budgetError}
                      onSave={saveBudget}
                    />
                  </div>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { OPEN_USAGE_EVENT };
