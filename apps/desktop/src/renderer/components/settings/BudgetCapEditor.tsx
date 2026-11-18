import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BudgetCapAction,
  BudgetCapConfig,
  BudgetCapProvider,
  BudgetCapScope,
  BudgetCapType,
  BudgetPreset,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, recessedStyle } from "../lanes/laneDesignTokens";
import { ModernRow, ModernRows, ModernSection, SettingsNumber, SettingsSelect, SettingsTextField } from "./primitives";
import { useSettingsProjectPin, withProjectSettingsBound } from "./ProjectCopyScope";
import { useSettingsMachineScope, type SettingsMachineScope } from "./SettingsMachineScope";
import { InlineErrorNotice } from "../ui/notice";

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
        <BudgetSection hint="No budget configuration loaded." />
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
      <ModernSection
        group="Budget"
        anchor="budget-cap"
        title="Spend cap"
        hint="Warn, pause or block agents before they use up a subscription window."
      >
        <ModernRows>
        <ModernRow
          title="Usage guardrails"
          hint={summaryChips.length > 0 ? summaryChips.join(" · ") : "No budget caps configured yet."}
          control={(
            <>
              {dirty ? <span className="kit-tag" data-tone="warn">Unsaved</span> : null}
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="ade-modern-btn"
                aria-expanded={expanded}
              >
                {expanded ? "Collapse" : `${caps.length} cap${caps.length !== 1 ? "s" : ""}`}
              </button>
            </>
          )}
        >
        {expanded ? (
          <div style={{ display: "grid", gap: 14, marginTop: 14, paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--color-fg) 7%, transparent)" }}>
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
                <SettingsTextField
                  ariaLabel="Budget refresh interval in minutes"
                  value={draft.refreshIntervalMin}
                  onChange={(next) => { setDraft((current) => ({ ...current, refreshIntervalMin: next })); setDirty(true); }}
                />
              </Field>
              <Field label="Alert weekly %">
                <SettingsTextField
                  ariaLabel="Alert at weekly percent"
                  value={draft.alertAtWeeklyPercent}
                  onChange={(next) => { setDraft((current) => ({ ...current, alertAtWeeklyPercent: next })); setDirty(true); }}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={fieldLabelStyle}>Cap rules</span>
                <button
                  type="button"
                  className="ade-modern-btn"
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
                      <SettingsTextField
                        ariaLabel="Cap scope id"
                        value={cap.scopeId ?? ""}
                        onChange={(next) => updateCap(cap.rowId, { scopeId: next })}
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
                      className="ade-modern-btn"
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
              <InlineErrorNotice id="settings-budget-cap-save" message={saveError} />
            ) : null}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="ade-modern-btn"
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
                className="ade-modern-btn"
                data-tone="primary"
                onClick={() => void handleSave()}
                disabled={!dirty || saving || !onSave}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : null}
        </ModernRow>
        </ModernRows>
      </ModernSection>
    </div>
  );
}


/**
 * The spend cap as a settings row: owns the load/save round trip and renders
 * the editor. The cap lives in the open project's `.ade/local.yaml` on the
 * machine the page shows, so it is read and written through that project's
 * copy, never the machine route (which answers no budget actions).
 */
export function BudgetCapSettings() {
  const scope = useSettingsMachineScope();
  const projectPin = useSettingsProjectPin();
  const projectPinKey = projectPin?.key ?? null;
  const [config, setConfig] = useState<BudgetCapConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!projectPin) {
      setConfig(null);
      setStatus("failed");
      return;
    }
    let cancelled = false;
    setConfig(null);
    setStatus("loading");
    setSaveError(null);
    withProjectSettingsBound(
      window.ade.usage.getBudgetConfig(projectPin),
      scope.machineName,
      scope.isThisMachine,
    )
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSaveError(error instanceof Error ? error.message : "ADE could not load the spend cap.");
        setStatus("failed");
      });
    return () => { cancelled = true; };
    // The settings subtree remounts when the machine or project copy changes
    // (`SettingsMachineScopeProvider` key), so this mount's pin is stable;
    // `projectPinKey` is its identity for a re-render that carries the same copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPinKey, scope.machineName, scope.isThisMachine, reloadNonce]);

  const onSave = useCallback(async (next: BudgetCapConfig) => {
    // Never write after a failed load: an empty form must not replace a cap
    // that this page could not read.
    if (!projectPin || status !== "ready") return;
    setSaving(true);
    setSaveError(null);
    try {
      setConfig(await withProjectSettingsBound(
        window.ade.usage.saveBudgetConfig(next, projectPin),
        scope.machineName,
        scope.isThisMachine,
      ));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "ADE could not save the spend cap.");
    } finally {
      setSaving(false);
    }
  }, [projectPin, scope.machineName, scope.isThisMachine, status]);

  if (!projectPin) return <BudgetSection hint={budgetCapUnavailableHint(scope)} />;
  if (status === "loading") return <BudgetSection hint="Loading the spend cap…" />;
  if (status === "failed") {
    return (
      <BudgetSection hint="Couldn't load the spend cap.">
        <InlineErrorNotice
          id="settings-budget-cap-load"
          message={saveError ?? "ADE could not load the spend cap."}
        />
        <button type="button" className="ade-modern-btn" onClick={() => setReloadNonce((value) => value + 1)}>
          Try again
        </button>
      </BudgetSection>
    );
  }

  return <BudgetCapEditor config={config} saving={saving} saveError={saveError} onSave={onSave} />;
}

/** Why the spend cap cannot be reached on this page. */
function budgetCapUnavailableHint(scope: SettingsMachineScope): string {
  if (!scope.online) return `${scope.machineName} is offline. Reconnect to set its spend cap.`;
  if (scope.isThisMachine) return "Open this project on this computer to set its spend cap.";
  return `${scope.machineName} has no copy of this project. Open the project there to set its spend cap.`;
}

/** The spend cap's settings row, for the states before the editor can render. */
function BudgetSection({ hint, children }: { hint: string; children?: React.ReactNode }) {
  return (
    <ModernSection group="Budget" anchor="budget-cap" title="Spend cap" hint={hint}>
      {children ?? null}
    </ModernSection>
  );
}
