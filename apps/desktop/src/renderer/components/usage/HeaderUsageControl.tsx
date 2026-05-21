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

function weeklyPercentFor(snapshot: UsageSnapshot | null, provider: UsageProvider): number | null {
  if (!snapshot) return null;
  const weekly = snapshot.windows.find(
    (w) => w.provider === provider && (w.windowType === "weekly" || w.windowType === "monthly"),
  );
  if (!weekly) return null;
  return Math.max(0, Math.min(100, weekly.percentUsed));
}

const OPEN_USAGE_EVENT = "ade-open-usage-drawer";
const HEADER_USAGE_STARTUP_DELAY_MS = 5_000;

export function HeaderUsageControl() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [providerConnections, setProviderConnections] = useState<AiProviderConnections | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Delay background usage reads during project boot, but hydrate immediately
  // when the drawer is opened.
  useEffect(() => {
    if (!window.ade?.usage) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      window.ade.usage.getSnapshot()
        .then((nextSnapshot) => {
          if (!cancelled) setSnapshot(nextSnapshot);
        })
        .catch(() => {
          if (!cancelled) setSnapshot(null);
        });
      unsubscribe = window.ade.usage.onUpdate?.((next) => {
        if (!cancelled) setSnapshot(next);
      });
    }, open ? 0 : HEADER_USAGE_STARTUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [open]);

  // Fetch provider connection status so we can hide providers whose CLI is
  // not installed on this machine.
  useEffect(() => {
    if (!window.ade?.ai?.getStatus) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      window.ade.ai.getStatus()
        .then((status) => {
          if (!cancelled) setProviderConnections(status.providerConnections ?? null);
        })
        .catch(() => {
          if (!cancelled) setProviderConnections(null);
        });
    }, open ? 0 : HEADER_USAGE_STARTUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open]);

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

  // Refresh on drawer open so the snapshot reflects current usage without
  // waiting for the next background poll.
  useEffect(() => {
    if (!open || !window.ade?.usage?.refresh) return;
    let cancelled = false;
    void window.ade.usage.refresh()
      .then((next) => {
        if (!cancelled && next) setSnapshot(next);
      })
      .catch(() => {
        // Refresh errors are surfaced by the drawer itself.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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
    () =>
      detectedProviders.map((provider) => ({
        provider,
        percent: weeklyPercentFor(snapshot, provider),
      })),
    [detectedProviders, snapshot],
  );
  const hasErrors = (snapshot?.errors.length ?? 0) > 0;

  const titleParts: string[] = [];
  for (const { provider, percent } of providersWithUsage) {
    if (percent == null) continue;
    titleParts.push(`${PROVIDER_LABEL[provider]} ${Math.round(percent)}%`);
  }
  let buttonTitle: string;
  if (titleParts.length > 0) {
    buttonTitle = `Usage · ${titleParts.join(" · ")}${hasErrors ? " · warnings" : ""}`;
  } else if (hasErrors) {
    buttonTitle = "Usage · warnings";
  } else {
    buttonTitle = "Usage";
  }

  // Render per-provider chips only when (a) we have at least one detected
  // provider AND (b) we have a real percent for at least one of them.
  // Otherwise we fall back to the gauge icon — empty em-dashes ("Claude —")
  // are worse UX than a single neutral icon during the initial poll.
  const hasAnyChip =
    providersWithUsage.length > 0 &&
    providersWithUsage.some(({ percent }) => percent != null);

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
        {hasAnyChip ? (
          <div className="flex items-center gap-2">
            {providersWithUsage.map(({ provider, percent }) => (
              <div key={provider} className="flex items-center gap-1">
                <ProviderLogo provider={provider} size={14} />
                <span
                  className="font-mono text-[10px] font-semibold tabular-nums"
                  style={{ color: percent == null ? "var(--color-muted-fg)" : thresholdColor(percent) }}
                >
                  {percent == null ? "—" : `${Math.round(percent)}%`}
                </span>
              </div>
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
              <UsageQuotaPanel onSnapshotChange={setSnapshot} />

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
