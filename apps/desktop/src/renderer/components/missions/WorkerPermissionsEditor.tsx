import React, { useMemo } from "react";
import { Shield, Warning } from "@phosphor-icons/react";
import type { PhaseCard, MissionPermissionConfig, AgentChatPermissionMode } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import {
  getPermissionOptions,
  safetyBadgeLabel,
  safetyColorHex,
  familyToPermissionKey,
  permissionFamilyLabel,
  type PermissionOption,
} from "../shared/permissionOptions";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

export type PermFamilyKey = "claude" | "codex" | "unified";

/** Derive unique model families in use from orchestrator + phase card models */
export function deriveActivePermFamilies(
  orchestratorModelId: string | undefined,
  phases: PhaseCard[],
): PermFamilyKey[] {
  const seen = new Set<PermFamilyKey>();
  const modelIds = new Set<string>();
  if (orchestratorModelId) modelIds.add(orchestratorModelId);
  for (const phase of phases) {
    if (phase.model?.modelId) modelIds.add(phase.model.modelId);
  }
  for (const id of modelIds) {
    const desc = getModelById(id);
    if (desc) {
      seen.add(familyToPermissionKey(desc.family, desc.isCliWrapped));
    }
  }
  const order: PermFamilyKey[] = ["claude", "codex", "unified"];
  return order.filter((k) => seen.has(k));
}

export type WorkerPermissionsEditorProps = {
  orchestratorModelId: string | undefined;
  phases: PhaseCard[];
  permissionConfig: MissionPermissionConfig;
  onPermissionChange: (next: MissionPermissionConfig) => void;
  labelStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
};

const DEFAULT_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

const DEFAULT_INPUT_STYLE: React.CSSProperties = {
  height: 28,
  width: "100%",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  padding: "0 8px",
  fontSize: 11,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  borderRadius: 0,
  outline: "none",
};

export function WorkerPermissionsEditor({
  orchestratorModelId,
  phases,
  permissionConfig,
  onPermissionChange,
  labelStyle: _lblStyle,
  inputStyle: inpStyle,
}: WorkerPermissionsEditorProps) {
  const families = useMemo(
    () => deriveActivePermFamilies(orchestratorModelId, phases),
    [orchestratorModelId, phases],
  );

  const provPerms = permissionConfig?.providers;

  const familyOptions = useMemo(() => {
    const map = new Map<PermFamilyKey, PermissionOption[]>();
    for (const fam of families) {
      const modelFamily = fam === "claude" ? "anthropic" : fam === "codex" ? "openai" : "unified";
      const isCliWrapped = fam === "claude" || fam === "codex";
      map.set(fam, getPermissionOptions({ family: modelFamily, isCliWrapped }));
    }
    return map;
  }, [families]);

  const updateProviderPerm = (key: PermFamilyKey, value: AgentChatPermissionMode) => {
    onPermissionChange({
      ...permissionConfig,
      providers: { ...permissionConfig?.providers, [key]: value },
    });
  };

  const updateCodexSandbox = (value: "read-only" | "workspace-write" | "danger-full-access") => {
    onPermissionChange({
      ...permissionConfig,
      providers: { ...permissionConfig?.providers, codexSandbox: value },
    });
  };

  const hasRestricted = families.some((f) => {
    const mode = provPerms?.[f] ?? "full-auto";
    return mode !== "full-auto";
  });

  const inputStyleResolved = inpStyle ?? DEFAULT_INPUT_STYLE;

  return (
    <div className="space-y-2">
      <span style={_lblStyle ?? DEFAULT_LABEL_STYLE}>
        <Shield size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
        WORKER PERMISSIONS
      </span>

      <div className="space-y-2">
        {families.length === 0 && (
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, padding: "8px 0" }}>
            Select an orchestrator model and phase models to configure permissions.
          </div>
        )}
        {families.map((fam) => {
          const opts = familyOptions.get(fam) ?? [];
          const current = provPerms?.[fam] ?? "full-auto";
          const selected = opts.find((o) => o.value === current) ?? opts[opts.length - 1];

          return (
            <div
              key={fam}
              style={{
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                padding: "10px 12px",
              }}
            >
              {/* Family header */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textPrimary }}>
                  {permissionFamilyLabel(fam)}
                </span>
                {selected && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: MONO_FONT,
                      textTransform: "uppercase" as const,
                      letterSpacing: "1px",
                      color: safetyColorHex(selected.safety),
                      marginLeft: "auto",
                    }}
                  >
                    {safetyBadgeLabel(selected.safety)}
                  </span>
                )}
              </div>

              {/* Permission dropdown */}
              <select
                value={current}
                onChange={(e) => updateProviderPerm(fam, e.target.value as AgentChatPermissionMode)}
                className="h-7 w-full px-2 outline-none"
                style={inputStyleResolved}
              >
                {opts.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} — {opt.shortDesc}
                  </option>
                ))}
              </select>

              {/* Description of selected mode */}
              {selected && (
                <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 6, lineHeight: "1.5" }}>
                  {selected.detail}
                </div>
              )}

              {/* Codex sandbox sub-dropdown */}
              {fam === "codex" && (
                <div style={{ marginTop: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted }}>
                    SANDBOX
                  </span>
                  <select
                    value={provPerms?.codexSandbox ?? "workspace-write"}
                    onChange={(e) => updateCodexSandbox(e.target.value as "read-only" | "workspace-write" | "danger-full-access")}
                    className="mt-1 h-7 w-full px-2 outline-none"
                    style={inputStyleResolved}
                  >
                    <option value="read-only">Read-only</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="danger-full-access">Danger full-access</option>
                  </select>
                </div>
              )}

              {/* Warning for selected mode */}
              {selected?.warning && (
                <div
                  style={{
                    fontSize: 10,
                    color: COLORS.danger,
                    fontFamily: MONO_FONT,
                    marginTop: 6,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Warning size={12} weight="bold" />
                  {selected.warning}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasRestricted && (
        <div
          style={{
            fontSize: 10,
            color: COLORS.warning,
            fontFamily: MONO_FONT,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Warning size={12} weight="bold" />
          Workers using restricted permissions may pause for approval during autonomous execution.
        </div>
      )}
    </div>
  );
}
