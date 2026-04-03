import React, { useEffect, useMemo, useState } from "react";
import { Shield, Warning } from "@phosphor-icons/react";
import type {
  PhaseCard,
  MissionPermissionConfig,
  AgentChatPermissionMode,
  ExternalMcpMissionSelection,
  ExternalMcpServerConfig,
  ExternalMcpServerSnapshot,
} from "../../../shared/types";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import {
  getPermissionOptions,
  safetyBadgeLabel,
  safetyColorHex,
  familyToPermissionKey,
  permissionFamilyLabel,
  type PermissionOption,
} from "../shared/permissionOptions";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

export type PermFamilyKey = "claude" | "codex" | "unified" | "cursor" | "droid";

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
    const desc = resolveModelDescriptor(id);
    if (desc) {
      seen.add(familyToPermissionKey(desc.family, desc.isCliWrapped));
    }
  }
  const order: PermFamilyKey[] = ["claude", "codex", "cursor", "droid", "unified"];
  return order.filter((k) => seen.has(k));
}

export type WorkerPermissionsEditorProps = {
  orchestratorModelId: string | undefined;
  phases: PhaseCard[];
  permissionConfig: MissionPermissionConfig;
  onPermissionChange: (next: MissionPermissionConfig) => void;
  labelStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
  title?: string;
  description?: string;
  showExternalMcp?: boolean;
};

function normalizeMissionSelection(value?: ExternalMcpMissionSelection | null): ExternalMcpMissionSelection {
  return {
    enabled: value?.enabled === true,
    selectedServers: [...new Set(value?.selectedServers ?? [])],
    selectedTools: [...new Set(value?.selectedTools ?? [])],
  };
}

function toggleValue(list: string[], value: string, enabled: boolean): string[] {
  const next = new Set(list);
  if (enabled) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}

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
  title,
  description,
  showExternalMcp = true,
}: WorkerPermissionsEditorProps) {
  const families = useMemo(
    () => deriveActivePermFamilies(orchestratorModelId, phases),
    [orchestratorModelId, phases],
  );

  const provPerms = permissionConfig?.providers;

  const familyOptions = useMemo(() => {
    const map = new Map<PermFamilyKey, PermissionOption[]>();
    for (const fam of families) {
      const modelFamily = fam === "claude"
        ? "anthropic"
        : fam === "codex"
          ? "openai"
          : fam === "droid"
            ? "factory"
            : "unified";
      const isCliWrapped = fam === "claude" || fam === "codex" || fam === "droid";
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

  const [externalConfigs, setExternalConfigs] = useState<ExternalMcpServerConfig[]>([]);
  const [externalSnapshots, setExternalSnapshots] = useState<ExternalMcpServerSnapshot[]>([]);
  const [externalRegistryError, setExternalRegistryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!window.ade?.externalMcp) return;
    void Promise.all([
      window.ade.externalMcp.listConfigs(),
      window.ade.externalMcp.listServers(),
    ]).then(([configs, snapshots]) => {
      if (cancelled) return;
      setExternalConfigs(configs);
      setExternalSnapshots(snapshots);
      setExternalRegistryError(null);
    }).catch((err) => {
      if (cancelled) return;
      setExternalConfigs([]);
      setExternalSnapshots([]);
      setExternalRegistryError(err instanceof Error ? err.message : "Failed to load external MCP registry.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateExternalMcp = (selection: ExternalMcpMissionSelection) => {
    onPermissionChange({
      ...permissionConfig,
      externalMcp: selection,
    });
  };

  const hasRestricted = families.some((f) => {
    const mode = provPerms?.[f] ?? "full-auto";
    return mode !== "full-auto";
  });

  const inputStyleResolved = inpStyle ?? DEFAULT_INPUT_STYLE;
  const externalSelection = normalizeMissionSelection(permissionConfig?.externalMcp);
  const snapshotByName = useMemo(
    () => new Map(externalSnapshots.map((entry) => [entry.config.name, entry] as const)),
    [externalSnapshots],
  );
  const availableServers = useMemo(
    () => externalConfigs.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
    [externalConfigs],
  );
  const availableTools = useMemo(() => {
    const serverFilter = new Set(externalSelection.selectedServers ?? []);
    return externalSnapshots
      .filter((snapshot) => serverFilter.size === 0 || serverFilter.has(snapshot.config.name))
      .flatMap((snapshot) => snapshot.tools.filter((tool) => tool.enabled));
  }, [externalSelection.selectedServers, externalSnapshots]);

  return (
    <div className="space-y-2">
      <span style={_lblStyle ?? DEFAULT_LABEL_STYLE}>
        <Shield size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
        {title ?? "WORKER PERMISSIONS"}
      </span>
      {description ? (
        <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, lineHeight: "1.5" }}>
          {description}
        </div>
      ) : null}

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
                  <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 6, lineHeight: "1.4" }}>
                    Mode controls approval behavior. Sandbox controls filesystem access. They are applied together for Codex workers.
                  </div>
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

      {showExternalMcp ? (
        <div
          style={{
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            padding: "10px 12px",
            marginTop: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textPrimary }}>
              ADE-managed MCP
            </span>
            <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
              Mission-level ADE-brokered tool surface
            </span>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
            <input
              type="checkbox"
              checked={externalSelection.enabled === true}
              onChange={(event) => updateExternalMcp({ ...externalSelection, enabled: event.target.checked })}
            />
            Enable ADE-managed MCP tools for this mission
          </label>

          {externalRegistryError && (
            <div style={{ fontSize: 10, color: COLORS.danger, fontFamily: MONO_FONT, marginTop: 8 }}>
              {externalRegistryError}
            </div>
          )}

          {!externalRegistryError && externalSelection.enabled === true && (
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {availableServers.length === 0 ? (
                <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  No ADE-managed MCP servers are configured in ADE yet.
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 6 }}>
                    Selected Servers
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {availableServers.map((serverName) => {
                      const snapshot = snapshotByName.get(serverName);
                      const isChecked = (externalSelection.selectedServers ?? []).includes(serverName);
                      return (
                        <label key={serverName} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(event) => {
                              const selectedServers = toggleValue(
                                externalSelection.selectedServers ?? [],
                                serverName,
                                event.target.checked,
                              );
                              const allowedToolNames = new Set(
                                externalSnapshots
                                  .filter((entry) => selectedServers.length === 0 || selectedServers.includes(entry.config.name))
                                  .flatMap((entry) => entry.tools.map((tool) => tool.namespacedName)),
                              );
                              updateExternalMcp({
                                ...externalSelection,
                                selectedServers,
                                selectedTools: (externalSelection.selectedTools ?? []).filter((toolName) => allowedToolNames.has(toolName)),
                              });
                            }}
                          />
                          <span>{serverName}</span>
                          <span style={{ marginLeft: "auto", color: COLORS.textMuted }}>
                            {snapshot?.state ?? "disconnected"} · {snapshot?.toolCount ?? 0} tools
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 6 }}>
                    Leave everything unchecked to allow all externally approved servers for this mission.
                  </div>
                </div>
              )}

              {availableTools.length > 0 && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 6 }}>
                    Selected Tools
                  </div>
                  <div style={{ display: "grid", gap: 6, maxHeight: 180, overflowY: "auto", paddingRight: 4 }}>
                    {availableTools.map((tool) => (
                      <label key={tool.namespacedName} style={{ display: "grid", gap: 2, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.cardBg, padding: "6px 8px" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={(externalSelection.selectedTools ?? []).includes(tool.namespacedName)}
                            onChange={(event) => updateExternalMcp({
                              ...externalSelection,
                              selectedTools: toggleValue(
                                externalSelection.selectedTools ?? [],
                                tool.namespacedName,
                                event.target.checked,
                              ),
                            })}
                          />
                          <span>{tool.namespacedName}</span>
                          <span style={{ marginLeft: "auto", color: tool.safety === "write" ? COLORS.warning : COLORS.info }}>
                            {tool.safety}
                          </span>
                        </span>
                        {tool.description && (
                          <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                            {tool.description}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 6 }}>
                    Leave everything unchecked to allow all tools from the selected servers.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
