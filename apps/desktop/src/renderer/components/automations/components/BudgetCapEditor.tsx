import { useEffect, useMemo, useState } from "react";
import type {
  BudgetCapAction,
  BudgetCapConfig,
  BudgetCapProvider,
  BudgetCapScope,
  BudgetCapType,
  BudgetPreset,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { CARD_SHADOW_STYLE } from "../shared";

type BudgetCapDraft = NonNullable<BudgetCapConfig["budgetCaps"]>[number] & { rowId: string };

const PRESET_OPTIONS: BudgetPreset[] = ["conservative", "maximize", "fixed"];
const SCOPE_OPTIONS: BudgetCapScope[] = ["global", "automation-rule", "night-shift-run", "night-shift-global"];
const TYPE_OPTIONS: BudgetCapType[] = ["weekly-percent", "five-hour-percent"];
const PROVIDER_OPTIONS: BudgetCapProvider[] = ["any", "claude", "codex"];
const ACTION_OPTIONS: BudgetCapAction[] = ["block", "warn", "pause"];

const FIELD_CLS = "w-full rounded-sm border border-[#2D2840] px-2 py-1 font-mono text-[10px] text-[#FAFAFA]";
const FIELD_CLS_PRIMARY = `${FIELD_CLS} bg-[#14111D]`;
const FIELD_CLS_ROW = `${FIELD_CLS} bg-[#181423]`;

function capTypeLabel(value: BudgetCapType): string {
  if (value === "five-hour-percent") return "5-hour / session usage";
  if (value === "weekly-percent") return "Weekly usage";
  if (value === "usd-per-run") return "Legacy: per-run cost";
  if (value === "usd-per-day") return "Legacy: daily cost";
  return value;
}

function toDraft(config: BudgetCapConfig | null): {
  preset: string;
  nightShiftReservePercent: string;
  alertAtWeeklyPercent: string;
  refreshIntervalMin: string;
  caps: BudgetCapDraft[];
} {
  return {
    preset: config?.preset ?? "",
    nightShiftReservePercent: config?.nightShiftReservePercent != null ? String(config.nightShiftReservePercent) : "",
    alertAtWeeklyPercent: config?.alertAtWeeklyPercent != null ? String(config.alertAtWeeklyPercent) : "",
    refreshIntervalMin: config?.refreshIntervalMin != null ? String(config.refreshIntervalMin) : "",
    caps: (config?.budgetCaps ?? []).map((cap, index) => ({
      rowId: `cap-${index}-${cap.scope}-${cap.provider}-${cap.capType}`,
      scope: cap.scope,
      scopeId: cap.scopeId,
      capType: cap.capType,
      provider: cap.provider,
      limit: cap.limit,
      action: cap.action,
    })),
  };
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed.length) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function BudgetCapEditor({
  config,
  className,
  saving = false,
  saveError = null,
  onSave,
}: {
  config: BudgetCapConfig | null;
  className?: string;
  saving?: boolean;
  saveError?: string | null;
  onSave?: ((config: BudgetCapConfig) => Promise<void> | void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(config));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(toDraft(config));
    setDirty(false);
  }, [config]);

  const caps = draft.caps;
  const summaryChips = useMemo(() => {
    const chips: string[] = [];
    if (draft.preset) chips.push(`Preset: ${draft.preset}`);
    if (draft.nightShiftReservePercent.trim().length > 0) chips.push(`Night Shift Reserve: ${draft.nightShiftReservePercent}%`);
    if (draft.alertAtWeeklyPercent.trim().length > 0) chips.push(`Alert at ${draft.alertAtWeeklyPercent}% weekly`);
    if (draft.refreshIntervalMin.trim().length > 0) chips.push(`Refresh every ${draft.refreshIntervalMin}m`);
    return chips;
  }, [draft.alertAtWeeklyPercent, draft.nightShiftReservePercent, draft.preset, draft.refreshIntervalMin]);

  if (!config && !onSave) {
    return (
      <div
        className={cn("p-3", className)}
        style={{ background: "#181423", border: "1px solid #2D2840" }}
      >
        <div className="font-mono text-[10px] text-[#71717A]">No budget configuration loaded.</div>
      </div>
    );
  }

  const updateCap = (rowId: string, patch: Partial<BudgetCapDraft>) => {
    setDraft((current) => ({
      ...current,
      caps: current.caps.map((cap) => (cap.rowId === rowId ? { ...cap, ...patch } : cap)),
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!onSave) return;
    const nextConfig: BudgetCapConfig = {
      ...(draft.preset ? { preset: draft.preset as BudgetPreset } : {}),
      ...(parseOptionalNumber(draft.nightShiftReservePercent) != null
        ? { nightShiftReservePercent: parseOptionalNumber(draft.nightShiftReservePercent) }
        : {}),
      ...(parseOptionalNumber(draft.alertAtWeeklyPercent) != null
        ? { alertAtWeeklyPercent: parseOptionalNumber(draft.alertAtWeeklyPercent) }
        : {}),
      ...(parseOptionalNumber(draft.refreshIntervalMin) != null
        ? { refreshIntervalMin: parseOptionalNumber(draft.refreshIntervalMin) }
        : {}),
      budgetCaps: draft.caps.map(({ rowId: _rowId, ...cap }) => ({
        ...cap,
        scopeId: cap.scopeId?.trim() || undefined,
        limit: Number(cap.limit),
      })),
    };
    await onSave(nextConfig);
  };

  return (
    <div className={cn("p-3 space-y-3", className)} style={CARD_SHADOW_STYLE}>
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          Usage Guardrails
        </span>
        <div className="flex items-center gap-2">
          {dirty ? <Chip className="text-[8px] text-amber-300">Unsaved</Chip> : null}
          <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Collapse" : `${caps.length} cap${caps.length !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {summaryChips.length > 0 ? summaryChips.map((label) => (
          <Chip key={label} className="text-[9px] text-[#A78BFA]">{label}</Chip>
        )) : <span className="font-mono text-[10px] text-[#71717A]">No budget caps configured yet.</span>}
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-[#2D284060] pt-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.8px] text-[#71717A]">Preset</span>
              <select
                value={draft.preset}
                onChange={(event) => { setDraft((current) => ({ ...current, preset: event.target.value })); setDirty(true); }}
                className={FIELD_CLS_PRIMARY}
              >
                <option value="">None</option>
                {PRESET_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.8px] text-[#71717A]">Refresh (min)</span>
              <input
                value={draft.refreshIntervalMin}
                onChange={(event) => { setDraft((current) => ({ ...current, refreshIntervalMin: event.target.value })); setDirty(true); }}
                className={FIELD_CLS_PRIMARY}
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.8px] text-[#71717A]">Night Shift reserve %</span>
              <input
                value={draft.nightShiftReservePercent}
                onChange={(event) => { setDraft((current) => ({ ...current, nightShiftReservePercent: event.target.value })); setDirty(true); }}
                className={FIELD_CLS_PRIMARY}
              />
            </label>
            <label className="space-y-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.8px] text-[#71717A]">Alert weekly %</span>
              <input
                value={draft.alertAtWeeklyPercent}
                onChange={(event) => { setDraft((current) => ({ ...current, alertAtWeeklyPercent: event.target.value })); setDirty(true); }}
                className={FIELD_CLS_PRIMARY}
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9px] uppercase tracking-[0.8px] text-[#71717A]">Cap rules</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft((current) => ({
                    ...current,
                    caps: [
                      ...current.caps,
                      {
                        rowId: `new-${Date.now()}`,
                        scope: "automation-rule",
                        scopeId: "",
                        capType: "weekly-percent",
                        provider: "any",
                        limit: 80,
                        action: "warn",
                      },
                    ],
                  }));
                  setDirty(true);
                }}
              >
                Add cap
              </Button>
            </div>

            {caps.length === 0 ? (
              <div className="font-mono text-[10px] text-[#71717A]">No caps configured.</div>
            ) : caps.map((cap) => (
              <div
                key={cap.rowId}
                className="grid grid-cols-2 gap-2 rounded-sm border border-[#1E1B26] bg-[#14111D] p-2"
              >
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Scope</span>
                  <select
                    value={cap.scope}
                    onChange={(event) => updateCap(cap.rowId, { scope: event.target.value as BudgetCapScope })}
                    className={FIELD_CLS_ROW}
                  >
                    {SCOPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Scope ID</span>
                  <input
                    value={cap.scopeId ?? ""}
                    onChange={(event) => updateCap(cap.rowId, { scopeId: event.target.value })}
                    className={FIELD_CLS_ROW}
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Cap type</span>
                  <select
                    value={cap.capType}
                    onChange={(event) => updateCap(cap.rowId, { capType: event.target.value as BudgetCapType })}
                    className={FIELD_CLS_ROW}
                  >
                    {[...TYPE_OPTIONS, ...(TYPE_OPTIONS.includes(cap.capType) ? [] : [cap.capType])].map((option) => (
                      <option key={option} value={option}>{capTypeLabel(option)}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Provider</span>
                  <select
                    value={cap.provider}
                    onChange={(event) => updateCap(cap.rowId, { provider: event.target.value as BudgetCapProvider })}
                    className={FIELD_CLS_ROW}
                  >
                    {PROVIDER_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Limit</span>
                  <input
                    value={String(cap.limit)}
                    onChange={(event) => updateCap(cap.rowId, { limit: Number(event.target.value) })}
                    className={FIELD_CLS_ROW}
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-mono text-[9px] text-[#71717A]">Action</span>
                  <select
                    value={cap.action}
                    onChange={(event) => updateCap(cap.rowId, { action: event.target.value as BudgetCapAction })}
                    className={FIELD_CLS_ROW}
                  >
                    {ACTION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
                <div className="col-span-2 flex justify-end">
                  <span className="mr-auto self-center font-mono text-[9px] text-[#71717A]">
                    {capTypeLabel(cap.capType)} cap, reset tracked from live provider windows.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft((current) => ({ ...current, caps: current.caps.filter((entry) => entry.rowId !== cap.rowId) }));
                      setDirty(true);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {saveError ? (
            <div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2 font-mono text-[10px] text-red-300">
              {saveError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(toDraft(config));
                setDirty(false);
              }}
              disabled={saving}
            >
              Reset
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handleSave()} disabled={!dirty || saving || !onSave}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
