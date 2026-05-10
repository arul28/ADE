import { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, CaretRight, Gauge, X } from "@phosphor-icons/react";
import type {
  BudgetCapConfig,
  UsageProvider,
  UsageSnapshot,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { BudgetCapEditor } from "../settings/BudgetCapEditor";
import { UsageQuotaPanel } from "./UsageQuotaPanel";

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usageTone(percent: number, hasErrors: boolean): string {
  if (percent >= 90) return "#EF4444";
  if (percent >= 70) return "#F59E0B";
  if (percent > 0) return "#4ADE80";
  if (hasErrors) return "#F59E0B";
  return "var(--color-muted-fg)";
}

function summaryPercent(snapshot: UsageSnapshot | null): number {
  if (!snapshot || snapshot.windows.length === 0) return 0;
  return Math.max(...snapshot.windows.map((window) => Math.max(0, Math.min(100, window.percentUsed))));
}

const PROVIDER_LABEL: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

function summaryTitle(snapshot: UsageSnapshot | null, percent: number, hasErrors: boolean): string {
  if (!snapshot || snapshot.windows.length === 0) {
    return hasErrors ? "Usage — provider polling has warnings" : "Usage";
  }
  const byProvider = new Map<UsageProvider, number>();
  for (const window of snapshot.windows) {
    const prev = byProvider.get(window.provider) ?? 0;
    byProvider.set(window.provider, Math.max(prev, Math.max(0, Math.min(100, window.percentUsed))));
  }
  const lines = Array.from(byProvider.entries())
    .map(([provider, value]) => `${PROVIDER_LABEL[provider]} ${Math.round(value)}%`);
  const head = `Usage ${Math.round(percent)}% peak`;
  const detail = lines.length > 0 ? ` (${lines.join(" · ")})` : "";
  const tail = hasErrors ? " — warnings" : "";
  return `${head}${detail}${tail}`;
}

export function HeaderUsageControl() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!window.ade?.usage) return;
    let cancelled = false;
    window.ade.usage.getSnapshot()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot);
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    const unsubscribe = window.ade.usage.onUpdate((nextSnapshot) => {
      if (!cancelled) setSnapshot(nextSnapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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

  const percent = summaryPercent(snapshot);
  const hasErrors = (snapshot?.errors.length ?? 0) > 0;
  const tone = usageTone(percent, hasErrors);
  const title = summaryTitle(snapshot, percent, hasErrors);
  const showDot = percent > 0 || hasErrors;

  return (
    <>
      <button
        type="button"
        className={cn(
          "ade-shell-control relative inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150"
        )}
        data-variant="ghost"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-expanded={open}
        style={{ WebkitAppRegion: "no-drag", color: tone } as React.CSSProperties}
      >
        <Gauge size={12} weight="regular" />
        {showDot ? (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full",
              percent >= 90 || hasErrors ? "animate-pulse" : null,
            )}
            style={{ background: tone, boxShadow: `0 0 6px ${tone}` }}
          />
        ) : null}
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
