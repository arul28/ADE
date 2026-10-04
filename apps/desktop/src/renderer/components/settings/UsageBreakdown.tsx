/**
 * Settings → Usage → Breakdown: one ranked list, four views.
 *
 * Models come from the page's own stats (every session on the machine,
 * including ones started outside ADE). Chats, Lanes and Accounts come from
 * ADE's per-turn ledger through `usage.getCostBreakdown`, so they cover chats
 * ADE ran, and say so. Share and ranking follow the page's Cost/Tokens toggle.
 * The tail past the top rows folds into "Other".
 */
import React from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import type {
  AdeUsageCostBreakdown,
  AdeUsageCostBreakdownBy,
  AdeUsageModelSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
} from "../../../shared/types";
import { formatSpend, formatTokens } from "../../lib/format";
import { triggerBrowserDownload } from "../../lib/transcriptExport";
import { ProviderLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import {
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_HOVER_ROW_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_TEXT,
} from "../usage/usageDesign";
import { SettingsSegmented } from "./primitives";

export type UsageBreakdownView = "models" | AdeUsageCostBreakdownBy;
type Metric = "cost" | "tokens";

const MODEL_ROWS = 10;

type ListRow = {
  key: string;
  label: string;
  detail?: string | null;
  provider?: string | null;
  costUsd: number;
  totalTokens: number;
  billedUsd?: number;
  planValueUsd?: number;
  /** Folded tail; not clickable. */
  other?: boolean;
  onOpen?: () => void;
};

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The current view as CSV: the table a reader reconciles against a bill. */
function breakdownCsv(view: UsageBreakdownView, rows: readonly ListRow[]): string {
  const ledger = view !== "models";
  const header = ledger
    ? [view, "detail", "api_equivalent_usd", "billed_usd", "plan_value_usd", "tokens"]
    : ["model", "provider", "cost_usd", "tokens"];
  const lines = rows.map((row) => (ledger
    ? [row.label, row.detail ?? "", row.costUsd.toFixed(6), (row.billedUsd ?? 0).toFixed(6), (row.planValueUsd ?? 0).toFixed(6), row.totalTokens]
    : [row.label, row.provider ?? "", row.costUsd.toFixed(6), row.totalTokens]
  ).map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}

function modelRows(models: readonly AdeUsageModelSummary[], metric: Metric, onOpenModel: (model: AdeUsageModelSummary) => void): ListRow[] {
  const value = (model: AdeUsageModelSummary) => (metric === "cost" ? model.costUsd : model.totalTokens);
  const ranked = [...models].filter((model) => model.totalTokens > 0 || model.costUsd > 0).sort((a, b) => value(b) - value(a));
  const rows: ListRow[] = ranked.slice(0, MODEL_ROWS).map((model) => ({
    key: `${model.provider}:${model.model}`,
    label: model.model,
    provider: model.provider,
    costUsd: model.costUsd,
    totalTokens: model.totalTokens,
    onOpen: () => onOpenModel(model),
  }));
  const tail = ranked.slice(MODEL_ROWS);
  if (tail.length) {
    rows.push({
      key: "other",
      label: `Other (${tail.length} models)`,
      costUsd: tail.reduce((sum, model) => sum + model.costUsd, 0),
      totalTokens: tail.reduce((sum, model) => sum + model.totalTokens, 0),
      other: true,
    });
  }
  return rows;
}

function ledgerRows(breakdown: AdeUsageCostBreakdown, metric: Metric, onOpenLane: (laneId: string, name: string) => void): ListRow[] {
  const value = (row: { costUsd: number; totalTokens: number }) => (metric === "cost" ? row.costUsd : row.totalTokens);
  const rows: ListRow[] = [...breakdown.rows].sort((a, b) => value(b) - value(a)).map((row) => ({
    key: row.key || "none",
    label: row.label,
    detail: row.detail ?? null,
    provider: breakdown.by === "chat" || breakdown.by === "account" ? row.provider ?? null : null,
    costUsd: row.costUsd,
    totalTokens: row.totalTokens,
    billedUsd: row.billedUsd,
    planValueUsd: row.planValueUsd,
    ...(breakdown.by === "lane" && row.laneId ? { onOpen: () => onOpenLane(row.laneId!, row.label) } : {}),
  }));
  if (breakdown.other) {
    rows.push({
      key: "other",
      label: `Other (${breakdown.other.count})`,
      costUsd: breakdown.other.costUsd,
      totalTokens: breakdown.other.totalTokens,
      billedUsd: breakdown.other.billedUsd,
      planValueUsd: breakdown.other.planValueUsd,
      other: true,
    });
  }
  return rows;
}

export function UsageBreakdown({
  models,
  preset,
  scope,
  metric,
  reloadKey,
  onOpenModel,
}: {
  models: readonly AdeUsageModelSummary[];
  preset: AdeUsageRangePreset;
  scope: AdeUsageScope;
  metric: Metric;
  /** Changes when the page's stats reload, so the ledger views re-read too. */
  reloadKey: unknown;
  onOpenModel: (model: AdeUsageModelSummary) => void;
}) {
  const canReadLedger = typeof window.ade?.usage?.getCostBreakdown === "function";
  const [view, setView] = React.useState<UsageBreakdownView>("models");
  const [lane, setLane] = React.useState<{ id: string; name: string } | null>(null);
  const [breakdown, setBreakdown] = React.useState<AdeUsageCostBreakdown | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (view === "models" || !canReadLedger) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void window.ade.usage.getCostBreakdown!({
      by: view,
      preset,
      // Ranked by the metric on screen before the tail folds into Other, so a
      // cheap chat with the most tokens is not hidden behind the cost top 50.
      rankBy: metric,
      ...(view === "chat" && lane ? { laneId: lane.id } : {}),
    })
      .then((result) => {
        if (!cancelled) setBreakdown(result);
      })
      .catch(() => {
        if (!cancelled) {
          setBreakdown(null);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canReadLedger, lane, metric, preset, reloadKey, view]);

  const changeView = React.useCallback((next: UsageBreakdownView) => {
    setLane(null);
    setBreakdown(null);
    setView(next);
  }, []);

  const openLane = React.useCallback((laneId: string, name: string) => {
    setBreakdown(null);
    setLane({ id: laneId, name });
    setView("chat");
  }, []);

  const rows = React.useMemo(() => {
    if (view === "models") return modelRows(models, metric, onOpenModel);
    if (!breakdown || breakdown.by !== view) return [];
    const ranked = ledgerRows(breakdown, metric, openLane);
    // Inside one lane every chat's detail would repeat that lane's name.
    return lane ? ranked.map((row) => ({ ...row, detail: null })) : ranked;
  }, [breakdown, lane, metric, models, onOpenModel, openLane, view]);
  const total = rows.reduce((sum, row) => sum + (metric === "cost" ? row.costUsd : row.totalTokens), 0);

  const exportCsv = React.useCallback(() => {
    if (!rows.length) return;
    const suffix = view === "chat" && lane ? `-${lane.name.replace(/[^\w.-]+/g, "-")}` : "";
    triggerBrowserDownload(`ade-usage-${view}${suffix}-${preset}.csv`, breakdownCsv(view, rows), "text/csv;charset=utf-8");
  }, [lane, preset, rows, view]);

  // ⌘⇧E / Ctrl+Shift+E exports the view on screen, unless a field has focus.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "e") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      exportCsv();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportCsv]);

  const ledgerView = view !== "models";
  const viewOptions: Array<{ value: UsageBreakdownView; label: string }> = [
    { value: "models", label: "Models" },
    ...(canReadLedger
      ? [
          { value: "chat" as const, label: "Chats" },
          { value: "lane" as const, label: "Lanes" },
          { value: "account" as const, label: "Accounts" },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SettingsSegmented ariaLabel="Breakdown view" options={viewOptions} value={view} onChange={changeView} />
        <button
          type="button"
          onClick={exportCsv}
          disabled={!rows.length}
          className="ade-settings-icon-button"
          aria-label="Export this view as CSV"
          title="Export CSV (⌘⇧E)"
        >
          <DownloadSimple size={13} />
        </button>
      </div>
      {ledgerView ? (
        <p className={cn(USAGE_TEXT.micro, "m-0 text-muted-fg")}>
          {lane ? (
            <>
              <button type="button" className="text-fg underline-offset-2 hover:underline" onClick={() => changeView("lane")}>
                Lanes
              </button>
              {` › ${lane.name} · `}
            </>
          ) : null}
          {view === "account" ? "ADE chats on this machine." : scope === "account" ? "ADE chats in this project, on this machine." : "ADE chats in this project."}
          {" Value is at list prices; billed is what API keys were charged."}
        </p>
      ) : null}
      {loading && !rows.length ? (
        <p className={cn(USAGE_TEXT.detail, "py-6 text-center text-muted-fg")}>Loading…</p>
      ) : failed ? (
        <p className={cn(USAGE_TEXT.detail, "py-6 text-center text-muted-fg")}>Couldn&apos;t load this view.</p>
      ) : ledgerView && breakdown && !breakdown.available ? (
        <p className={cn(USAGE_TEXT.detail, "py-6 text-center text-muted-fg")}>This host does not keep a per-turn ledger.</p>
      ) : rows.length === 0 ? (
        <p className={cn(USAGE_TEXT.detail, "py-6 text-center text-muted-fg")}>
          {ledgerView ? "No ADE chat turns in this range." : "No model activity in this range."}
        </p>
      ) : (
        <table className={cn(USAGE_TEXT.detail, "w-full")}>
          <thead>
            <tr className={cn(USAGE_TEXT.micro, "border-b text-left text-muted-fg", USAGE_HAIRLINE_CLASS)}>
              <th className="py-2 pl-2 font-normal">{viewOptions.find((option) => option.value === view)?.label.replace(/s$/, "")}</th>
              <th className="py-2 text-right font-normal">{metric === "cost" ? "Cost" : "Tokens"}</th>
              {ledgerView ? <th className="py-2 text-right font-normal">Billed</th> : null}
              <th className="w-[28%] py-2 pr-2 text-right font-normal">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const value = metric === "cost" ? row.costUsd : row.totalTokens;
              const share = total > 0 ? value / total : 0;
              const interactive = Boolean(row.onOpen);
              return (
                <tr
                  key={row.key}
                  className={cn(
                    "border-b last:border-b-0",
                    USAGE_DIVIDER_COLOR_CLASS,
                    interactive && cn("cursor-pointer hover:bg-muted", USAGE_HOVER_ROW_CLASS),
                    row.other && "text-muted-fg",
                  )}
                  onClick={row.onOpen}
                  onKeyDown={(event) => {
                    if (interactive && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      row.onOpen?.();
                    }
                  }}
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? "button" : undefined}
                >
                  <td className="max-w-0 py-2 pl-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {row.provider ? <ProviderLogo family={row.provider} size={14} /> : null}
                      <span className="min-w-0 shrink truncate text-fg" title={row.label}>{row.label}</span>
                      {row.detail ? <span className="min-w-0 shrink-[4] truncate text-muted-fg" title={row.detail}>{row.detail}</span> : null}
                    </span>
                  </td>
                  <td className={cn("py-2 text-right text-fg", USAGE_NUMERIC_CLASS)}>
                    {metric === "cost" ? formatSpend(row.costUsd) : formatTokens(row.totalTokens)}
                  </td>
                  {ledgerView ? (
                    <td className={cn("py-2 text-right text-muted-fg", USAGE_NUMERIC_CLASS)}>
                      {(row.billedUsd ?? 0) > 0 ? formatSpend(row.billedUsd ?? 0) : "—"}
                    </td>
                  ) : null}
                  <td className="py-2 pr-2">
                    <span className="flex items-center justify-end gap-2">
                      <span className="h-1.5 w-full max-w-[96px] overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-fg/45" style={{ width: `${(share * 100).toFixed(1)}%` }} />
                      </span>
                      <span className={cn(USAGE_NUMERIC_CLASS, "w-9 text-right text-muted-fg")}>{`${Math.round(share * 100)}%`}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
