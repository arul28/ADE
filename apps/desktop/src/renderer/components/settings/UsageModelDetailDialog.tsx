/**
 * One model's detail on Settings → Usage: what it cost, how well it cached,
 * its daily trend, where its dollars went, and the price ADE bills it at —
 * with "Set price" and "Map to" for a model the public list gets wrong or
 * does not know. Prices and mappings are this machine's; saving re-prices its
 * history in the background.
 */
import React from "react";
import type {
  AdeUsageModelDetail,
  AdeUsageModelPrice,
  AdeUsageModelSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
} from "../../../shared/types";
import { formatSpend, formatTokens } from "../../lib/format";
import { CostSplitBars, SPLIT_COLORS } from "../usage/UsageCostSplit";
import { USAGE_EYEBROW_CLASS, USAGE_NUMERIC_CLASS, USAGE_TEXT } from "../usage/usageDesign";
import { cn } from "../ui/cn";
import { Dialog } from "../ui/dialog";

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={USAGE_EYEBROW_CLASS}>{label}</span>
      <span className={cn(USAGE_TEXT.title, USAGE_NUMERIC_CLASS, "text-fg")}>{value}</span>
    </div>
  );
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Every day from the range's start (or the model's first day, for an open
 * range) to its end, with the days the model was idle at zero. Three busy days
 * drawn as three full-width columns read as a steady habit; on a calendar they
 * read as the three days they were. Capped at the last 120 days.
 */
function fillTrendDays(detail: Pick<AdeUsageModelDetail, "daily" | "range">): AdeUsageModelDetail["daily"] {
  if (detail.daily.length === 0) return [];
  const byDate = new Map(detail.daily.map((day) => [day.date, day]));
  const first = detail.daily[0]!.date;
  const sinceKey = detail.range.since ? localDayKey(new Date(detail.range.since)) : first;
  const start = sinceKey > first ? first : sinceKey;
  const end = new Date(detail.range.until);
  const days: AdeUsageModelDetail["daily"] = [];
  for (let cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate()); days.length < 120; cursor.setDate(cursor.getDate() - 1)) {
    const key = localDayKey(cursor);
    if (key < start) break;
    days.push(byDate.get(key) ?? { date: key, costUsd: 0, totalTokens: 0 });
  }
  return days.reverse();
}

/** Daily cost, one column per day. One hue: the job is magnitude over time. */
function Trend({ daily, theme }: { daily: AdeUsageModelDetail["daily"]; theme: "dark" | "light" }) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  if (daily.length === 0) return null;
  const max = Math.max(...daily.map((day) => day.costUsd), 0);
  const color = SPLIT_COLORS.input[theme];
  const width = 100 / daily.length;
  const shown = hovered != null ? daily[hovered] : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>Daily cost</span>
        <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
          {shown ? `${shown.date} · ${formatSpend(shown.costUsd)} · ${formatTokens(shown.totalTokens)} tokens` : `peak ${formatSpend(max)}`}
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Daily cost">
        {daily.map((day, index) => {
          const height = max > 0 ? Math.max(0.6, (day.costUsd / max) * 38) : 0.6;
          return (
            <g key={day.date} onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}>
              {/* Full-height hit target: wider than the mark. */}
              <rect x={index * width} y={0} width={width} height={40} fill="transparent" />
              <rect
                x={index * width + width * 0.15}
                y={40 - height}
                width={width * 0.7}
                height={height}
                rx={0.6}
                fill={color}
                opacity={hovered == null || hovered === index ? 1 : 0.4}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function parseRate(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
}

export function UsageModelDetailDialog({
  model,
  preset,
  scope,
  theme,
  knownModels,
  onClose,
}: {
  model: AdeUsageModelSummary | null;
  preset: AdeUsageRangePreset;
  scope: AdeUsageScope;
  theme: "dark" | "light";
  /** Models on the page, offered as "Map to" targets. */
  knownModels: readonly string[];
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<AdeUsageModelDetail | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [mapTo, setMapTo] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const canEditPrices = typeof window.ade?.usage?.setModelPriceOverride === "function";

  // Only the newest request may fill the dialog: switching models quickly
  // must not let the previous model's answer land last.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async (target: AdeUsageModelSummary) => {
    const seq = ++loadSeq.current;
    setFailed(false);
    try {
      const result = await window.ade.usage.getModelDetail?.({ provider: target.provider, model: target.model, preset, scope });
      if (seq !== loadSeq.current) return;
      setDetail(result ?? null);
      if (!result) setFailed(true);
      else {
        setMapTo(result.mapTo ?? "");
        setEditing(result.price.unpriced);
        setDraft({
          input: result.price.unpriced ? "" : String(result.price.input),
          output: result.price.unpriced ? "" : String(result.price.output),
          cacheRead: result.price.cacheRead != null && !result.price.unpriced ? String(result.price.cacheRead) : "",
          cacheWrite: result.price.cacheWrite != null && !result.price.unpriced ? String(result.price.cacheWrite) : "",
        });
      }
    } catch {
      if (seq === loadSeq.current) setFailed(true);
    }
  }, [preset, scope]);

  React.useEffect(() => {
    setDetail(null);
    setMessage(null);
    if (model) void load(model);
  }, [load, model]);

  // A change applies to every raw id behind this model, or to `target` (a
  // model mapped onto this one) when given.
  const save = async (change: { price?: AdeUsageModelPrice | null; mapTo?: string | null }, done: string, target?: string) => {
    if (!model || !window.ade.usage.setModelPriceOverride) return;
    setSaving(true);
    setMessage(null);
    try {
      const ids = target ? [target] : detail?.modelIds ?? [];
      await window.ade.usage.setModelPriceOverride({ model: ids[0] ?? model.model, models: ids.slice(1), ...change });
      setMessage(`${done} Re-pricing history in the background; the page updates when it finishes.`);
      setEditing(false);
      await load(model);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const submitPrice = () => {
    const input = parseRate(draft.input);
    const output = parseRate(draft.output);
    const cacheRead = parseRate(draft.cacheRead);
    const cacheWrite = parseRate(draft.cacheWrite);
    if (input == null || output == null || Number.isNaN(input) || Number.isNaN(output) || Number.isNaN(cacheRead) || Number.isNaN(cacheWrite)) {
      setMessage("Enter input and output prices in USD per million tokens. Cache prices are optional.");
      return;
    }
    void save({ price: { input, output, ...(cacheRead != null ? { cacheRead } : {}), ...(cacheWrite != null ? { cacheWrite } : {}) } }, "Price saved.");
  };

  const price = detail?.price;
  const sourceLabel = price ? (price.unpriced ? "No public price" : price.source === "custom" ? "Your price" : price.source === "list" ? "models.dev" : "Built-in estimate") : "";
  const inputClass = "ade-settings-input w-24";

  return (
    <Dialog
      open={Boolean(model)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={model?.model ?? ""}
      description={model ? <span className="capitalize">{model.provider}</span> : undefined}
      width={620}
      actions={[{ label: "Close", onClick: onClose, variant: "secondary" }]}
    >
      {failed ? (
        <p className={cn(USAGE_TEXT.detail, "text-muted-fg")}>This host can&apos;t show model detail yet.</p>
      ) : !detail ? (
        <p className={cn(USAGE_TEXT.detail, "text-muted-fg")}>Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-4 gap-4">
            <Kpi label="Cost" value={formatSpend(detail.costUsd)} />
            <Kpi label="Tokens" value={formatTokens(detail.totalTokens)} />
            <Kpi label="Per 1M tokens" value={detail.costPerMillionUsd != null ? formatSpend(detail.costPerMillionUsd) : "—"} />
            <Kpi label="Cache hit" value={detail.cacheHitRate != null ? `${Math.round(detail.cacheHitRate * 100)}%` : "—"} />
          </div>
          <Trend daily={fillTrendDays(detail)} theme={theme} />
          <CostSplitBars split={detail.costSplit} theme={theme} />

          <div className="flex flex-col gap-2">
            <span className={USAGE_EYEBROW_CLASS}>Price</span>
            {!editing ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn(USAGE_TEXT.detail, USAGE_NUMERIC_CLASS, "text-fg")}>
                  {price && !price.unpriced
                    ? `$${price.input} in · $${price.output} out per 1M · ${sourceLabel}`
                    : "No public price, so this model counts as $0."}
                </span>
                {canEditPrices ? (
                  <span className="flex gap-2">
                    <button type="button" className="ade-settings-button" onClick={() => setEditing(true)} disabled={saving}>
                      {price?.unpriced ? "Set price" : "Change"}
                    </button>
                    {price?.source === "custom" ? (
                      <button type="button" className="ade-settings-button" onClick={() => void save({ price: null }, "Back to automatic pricing.")} disabled={saving}>
                        Automatic
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            ) : (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitPrice();
                }}
              >
                {(["input", "output", "cacheRead", "cacheWrite"] as const).map((field) => (
                  <label key={field} className={cn(USAGE_TEXT.micro, "flex flex-col gap-1 text-muted-fg")}>
                    {field === "input" ? "Input $/1M" : field === "output" ? "Output $/1M" : field === "cacheRead" ? "Cache read" : "Cache write"}
                    <input
                      className={inputClass}
                      inputMode="decimal"
                      placeholder={field === "cacheRead" || field === "cacheWrite" ? "= input" : "0.00"}
                      value={draft[field]}
                      onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
                <button type="submit" className="ade-settings-button" disabled={saving}>Save price</button>
                {!price?.unpriced ? (
                  <button type="button" className="ade-settings-button" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                ) : null}
              </form>
            )}
          </div>

          {canEditPrices ? (
            <div className="flex flex-col gap-2">
              <span className={USAGE_EYEBROW_CLASS}>Map to</span>
              <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
                Count this model as another one, such as a preview id under its released name. Its tokens and cost move to that model, at that model&apos;s price.
              </span>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save({ mapTo: mapTo.trim() || null }, mapTo.trim() ? `Now counted as ${mapTo.trim()}.` : "Mapping removed.");
                }}
              >
                <input
                  className="ade-settings-input min-w-[220px] flex-1"
                  list="ade-usage-map-targets"
                  placeholder="Model id, e.g. claude-opus-5-5"
                  value={mapTo}
                  onChange={(event) => setMapTo(event.target.value)}
                />
                <datalist id="ade-usage-map-targets">
                  {knownModels.filter((name) => name !== model?.model).map((name) => <option key={name} value={name} />)}
                </datalist>
                <button
                  type="submit"
                  className="ade-settings-button"
                  disabled={saving || (!mapTo.trim() && !detail.mapTo) || mapTo.trim() === (detail.mapTo ?? "")}
                >
                  {!mapTo.trim() && detail.mapTo ? "Remove mapping" : "Map"}
                </button>
              </form>
              {detail.mappedFrom?.length ? (
                <div className="flex flex-col gap-1">
                  <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>Also counted here:</span>
                  {detail.mappedFrom.map((source) => (
                    <div key={source} className="flex items-center gap-2">
                      <span className={cn(USAGE_TEXT.micro, "font-mono text-fg")}>{source}</span>
                      <button
                        type="button"
                        className="ade-settings-button"
                        disabled={saving}
                        onClick={() => void save({ mapTo: null }, `${source} is counted on its own again.`, source)}
                      >
                        Unmap
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {message ? <p className={cn(USAGE_TEXT.micro, "m-0 text-muted-fg")} role="status">{message}</p> : null}
        </div>
      )}
    </Dialog>
  );
}
