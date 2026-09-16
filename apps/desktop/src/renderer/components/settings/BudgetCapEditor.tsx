import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BudgetCapAction,
  BudgetCapConfig,
  BudgetCapProvider,
  BudgetCapScope,
  BudgetCapType,
  BudgetPreset,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, recessedStyle } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsNumber, SettingsSelect } from "./primitives";

/**
 * The spend cap editor. Mounted in settings and in the top-bar usage popup, so
 * it is a single card rather than a page: the anchor is what a deeplink or a
 * ⌘K result lands on, and the caller supplies the surrounding layout.
 *
 * This is the one settings surface that still has a Save button: the caps are
 * a multi-field rule set, and a half-typed rule persisted on keystroke would
 * block or pause real work.
 */

type BudgetCapDraft = NonNullable<BudgetCapConfig["budgetCaps"]>[number] & { rowId: string };

const PRESET_OPTIONS: BudgetPreset[] = ["conservative", "maximize", "fixed"];
const SCOPE_OPTIONS: BudgetCapScope[] = ["global", "automation-rule"];
const TYPE_OPTIONS: BudgetCapType[] = ["weekly-percent", "five-hour-percent"];
const PROVIDER_OPTIONS: BudgetCapProvider[] = ["any", "claude", "codex"];
const ACTION_OPTIONS: BudgetCapAction[] = ["block", "warn", "pause"];

const fieldInputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "0 8px",
  fontFamily: SANS_FONT,
  fontSize: 12,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 8,
};

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: SANS_FONT,
  fontSize: 11,
  color: COLORS.textMuted,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
    </label>
  );
}

function capTypeLabel(value: BudgetCapType): string {
  if (value === "five-hour-percent") return "5-hour / session usage";
  if (value === "weekly-percent") return "Weekly usage";
  if (value === "usd-per-run") return "Legacy: per-run cost";
  if (value === "usd-per-day") return "Legacy: daily cost";
  return value;
}

function toDraft(config: BudgetCapConfig | null): {
  preset: string;
  alertAtWeeklyPercent: string;
  refreshIntervalMin: string;
  caps: BudgetCapDraft[];
} {
  return {
    preset: config?.preset ?? "",
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
    if (draft.alertAtWeeklyPercent.trim().length > 0) chips.push(`Alert at ${draft.alertAtWeeklyPercent}% weekly`);
    if (draft.refreshIntervalMin.trim().length > 0) chips.push(`Refresh every ${draft.refreshIntervalMin}m`);
    return chips;
  }, [draft.alertAtWeeklyPercent, draft.preset, draft.refreshIntervalMin]);

  if (!config && !onSave) {
    return (
      <div className={className}>
        <SettingsCard
          anchor="budget-cap"
          title="Usage Guardrails"
          description="No budget configuration loaded."
        />
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
    <div className={className}>
      <SettingsCard
        anchor="budget-cap"
        title="Usage Guardrails"
        description={
          summaryChips.length > 0 ? summaryChips.join(" · ") : "No budget caps configured yet."
        }
        control={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {dirty ? (
              <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.warning }}>Unsaved</span>
            ) : null}
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
            >
              {expanded ? "Collapse" : `${caps.length} cap${caps.length !== 1 ? "s" : ""}`}
            </button>
          </span>
        }
      >
        {expanded ? (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
              <Field label="Preset">
                <SettingsSelect
                  ariaLabel="Budget preset"
                  value={draft.preset}
                  onChange={(next) => { setDraft((current) => ({ ...current, preset: next })); setDirty(true); }}
                  options={[
                    { value: "", label: "None" },
                    ...PRESET_OPTIONS.map((option) => ({ value: option as string, label: option })),
                  ]}
                />
              </Field>
              <Field label="Refresh (min)">
                <input
                  aria-label="Budget refresh interval in minutes"
                  value={draft.refreshIntervalMin}
                  onChange={(event) => { setDraft((current) => ({ ...current, refreshIntervalMin: event.target.value })); setDirty(true); }}
                  style={fieldInputStyle}
                />
              </Field>
              <Field label="Alert weekly %">
                <input
                  aria-label="Alert at weekly percent"
                  value={draft.alertAtWeeklyPercent}
                  onChange={(event) => { setDraft((current) => ({ ...current, alertAtWeeklyPercent: event.target.value })); setDirty(true); }}
                  style={fieldInputStyle}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={fieldLabelStyle}>Cap rules</span>
                <button
                  type="button"
                  style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
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
                </button>
              </div>

              {caps.length === 0 ? (
                <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>No caps configured.</div>
              ) : caps.map((cap) => (
                <div key={cap.rowId} style={recessedStyle({ padding: 12, borderRadius: 10, display: "grid", gap: 12 })}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <Field label="Scope">
                      <SettingsSelect
                        ariaLabel="Cap scope"
                        value={cap.scope}
                        onChange={(next) => updateCap(cap.rowId, { scope: next as BudgetCapScope })}
                        options={SCOPE_OPTIONS.map((option) => ({ value: option as string, label: option }))}
                      />
                    </Field>
                    <Field label="Scope ID">
                      <input
                        aria-label="Cap scope id"
                        value={cap.scopeId ?? ""}
                        onChange={(event) => updateCap(cap.rowId, { scopeId: event.target.value })}
                        style={fieldInputStyle}
                      />
                    </Field>
                    <Field label="Cap type">
                      <SettingsSelect
                        ariaLabel="Cap type"
                        value={cap.capType}
                        onChange={(next) => updateCap(cap.rowId, { capType: next as BudgetCapType })}
                        options={[...TYPE_OPTIONS, ...(TYPE_OPTIONS.includes(cap.capType) ? [] : [cap.capType])]
                          .map((option) => ({ value: option as string, label: capTypeLabel(option) }))}
                      />
                    </Field>
                    <Field label="Provider">
                      <SettingsSelect
                        ariaLabel="Cap provider"
                        value={cap.provider}
                        onChange={(next) => updateCap(cap.rowId, { provider: next as BudgetCapProvider })}
                        options={PROVIDER_OPTIONS.map((option) => ({ value: option as string, label: option }))}
                      />
                    </Field>
                    <Field label="Limit">
                      <SettingsNumber
                        ariaLabel="Cap limit"
                        value={Number(cap.limit)}
                        onChange={(next) => updateCap(cap.rowId, { limit: next })}
                      />
                    </Field>
                    <Field label="Action">
                      <SettingsSelect
                        ariaLabel="Cap action"
                        value={cap.action}
                        onChange={(next) => updateCap(cap.rowId, { action: next as BudgetCapAction })}
                        options={ACTION_OPTIONS.map((option) => ({ value: option as string, label: option }))}
                      />
                    </Field>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>
                      {capTypeLabel(cap.capType)} cap, reset tracked from live provider windows.
                    </span>
                    <button
                      type="button"
                      style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                      onClick={() => {
                        setDraft((current) => ({ ...current, caps: current.caps.filter((entry) => entry.rowId !== cap.rowId) }));
                        setDirty(true);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {saveError ? (
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                  background: "color-mix(in srgb, var(--color-error) 15%, transparent)",
                  color: COLORS.danger,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                }}
              >
                {saveError}
              </div>
            ) : null}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                onClick={() => {
                  setDraft(toDraft(config));
                  setDirty(false);
                }}
                disabled={saving}
              >
                Reset
              </button>
              <button
                type="button"
                style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
                onClick={() => void handleSave()}
                disabled={!dirty || saving || !onSave}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : null}
      </SettingsCard>
    </div>
  );
}


/**
 * The spend cap as a settings row: owns the load/save round trip and renders
 * the editor. Lives on the Usage page because that is where spend lives; the
 * editor itself stays caller-agnostic so nothing else that mounts it changes.
 */
export function BudgetCapSettings() {
  const [config, setConfig] = useState<BudgetCapConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.usage.getBudgetConfig()
      .then((next) => { if (!cancelled) setConfig(next); })
      .catch(() => { if (!cancelled) setSaveError("ADE could not load the spend cap."); });
    return () => { cancelled = true; };
  }, []);

  const onSave = useCallback(async (next: BudgetCapConfig) => {
    setSaving(true);
    setSaveError(null);
    try {
      setConfig(await window.ade.usage.saveBudgetConfig(next));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "ADE could not save the spend cap.");
    } finally {
      setSaving(false);
    }
  }, []);

  return <BudgetCapEditor config={config} saving={saving} saveError={saveError} onSave={onSave} />;
}
