import React, { useState, useCallback, useEffect } from "react";
import {
  GearSix,
  X,
  Plus,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { PhaseProfile } from "../../../shared/types";
import { MODEL_REGISTRY, MODEL_FAMILIES, type ProviderFamily } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import {
  type MissionSettingsDraft,
  type PlannerProvider,
  toTeammatePlanMode,
} from "./missionHelpers";

function PhaseProfileCard({
  profile,
  phaseBusy,
  setPhaseBusy,
  setPhaseNotice,
  setPhaseError,
  refreshPhaseProfiles,
}: {
  profile: PhaseProfile;
  phaseBusy: boolean;
  setPhaseBusy: (v: boolean) => void;
  setPhaseNotice: (v: string | null) => void;
  setPhaseError: (v: string | null) => void;
  refreshPhaseProfiles: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(profile.name);
  const [editDescription, setEditDescription] = useState(profile.description);
  const [editPhases, setEditPhases] = useState<import("../../../shared/types").PhaseCard[]>(profile.phases);
  const [dirty, setDirty] = useState(false);

  const settingsInputStyle: React.CSSProperties = { height: 28, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 11, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  return (
    <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold" style={{ color: COLORS.textPrimary }}>
            {profile.isBuiltIn ? <span style={{ color: COLORS.accent, marginRight: 4 }}>{"\u25CF"}</span> : null}
            {profile.name}
            {profile.isDefault ? <span style={{ fontSize: 9, fontWeight: 600, color: "#22C55E", marginLeft: 4, fontFamily: MONO_FONT }}>DEFAULT</span> : null}
          </div>
          <div className="truncate text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {profile.description || profile.phases.map((phase) => phase.name).join(" \u2192 ")}
          </div>
          <div className="text-[9px] mt-0.5" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            {profile.phases.length} phase{profile.phases.length !== 1 ? "s" : ""} · {profile.isBuiltIn ? "Built-in" : "Custom"}
          </div>
        </div>
        {!profile.isBuiltIn && (
          <button
            style={outlineButton()}
            disabled={phaseBusy}
            onClick={() => {
              if (!expanded) {
                setEditName(profile.name);
                setEditDescription(profile.description);
                setEditPhases(profile.phases);
                setDirty(false);
              }
              setExpanded(!expanded);
            }}
          >
            {expanded ? "HIDE" : "EDIT"}
          </button>
        )}
        <button
          style={outlineButton()}
          disabled={phaseBusy}
          onClick={async () => {
            setPhaseBusy(true);
            try {
              await window.ade.missions.clonePhaseProfile({ profileId: profile.id });
              await refreshPhaseProfiles();
              setPhaseNotice("Profile cloned.");
            } catch (err) {
              setPhaseError(err instanceof Error ? err.message : String(err));
            } finally {
              setPhaseBusy(false);
            }
          }}
        >
          CLONE
        </button>
        <button
          style={outlineButton()}
          disabled={phaseBusy}
          onClick={async () => {
            setPhaseBusy(true);
            try {
              const exported = await window.ade.missions.exportPhaseProfile({ profileId: profile.id });
              setPhaseNotice(exported.savedPath ? `Exported: ${exported.savedPath}` : "Profile exported.");
            } catch (err) {
              setPhaseError(err instanceof Error ? err.message : String(err));
            } finally {
              setPhaseBusy(false);
            }
          }}
        >
          EXPORT
        </button>
        {!profile.isBuiltIn ? (
          <button
            style={dangerButton()}
            disabled={phaseBusy}
            onClick={async () => {
              if (!window.confirm(`Delete phase profile "${profile.name}"?`)) return;
              setPhaseBusy(true);
              try {
                await window.ade.missions.deletePhaseProfile({ profileId: profile.id });
                await refreshPhaseProfiles();
                setPhaseNotice("Profile deleted.");
              } catch (err) {
                setPhaseError(err instanceof Error ? err.message : String(err));
              } finally {
                setPhaseBusy(false);
              }
            }}
          >
            DELETE
          </button>
        ) : null}
      </div>

      {expanded && !profile.isBuiltIn && (
        <div className="mt-3 space-y-3 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="space-y-0.5">
              <span style={settingsLabelStyle}>PROFILE NAME</span>
              <input
                value={editName}
                onChange={(e) => { setEditName(e.target.value); setDirty(true); }}
                style={settingsInputStyle}
              />
            </label>
            <label className="space-y-0.5">
              <span style={settingsLabelStyle}>DESCRIPTION</span>
              <input
                value={editDescription}
                onChange={(e) => { setEditDescription(e.target.value); setDirty(true); }}
                placeholder="Describe this profile"
                style={settingsInputStyle}
              />
            </label>
          </div>

          <div className="space-y-1">
            <span style={settingsLabelStyle}>PHASES ({editPhases.length})</span>
            {editPhases.map((phase, idx) => (
              <div key={phase.id} className="flex items-center gap-2 py-1 px-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <span className="text-[10px] font-bold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, minWidth: 16 }}>{idx + 1}.</span>
                <input
                  value={phase.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setEditPhases((prev) => prev.map((p) => p.id === phase.id ? { ...p, name } : p));
                    setDirty(true);
                  }}
                  className="h-6 flex-1 px-1 text-[11px] outline-none"
                  style={{ background: "transparent", border: "none", color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                />
                <span className="text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>{phase.model.modelId}</span>
                <button
                  type="button"
                  className="px-1 text-[10px]"
                  style={{ color: COLORS.textMuted }}
                  disabled={idx === 0}
                  onClick={() => {
                    setEditPhases((prev) => {
                      const next = [...prev];
                      const moved = next[idx]!;
                      next.splice(idx, 1);
                      next.splice(idx - 1, 0, moved);
                      return next.map((p, i) => ({ ...p, position: i }));
                    });
                    setDirty(true);
                  }}
                >
                  {"\u2191"}
                </button>
                <button
                  type="button"
                  className="px-1 text-[10px]"
                  style={{ color: COLORS.textMuted }}
                  disabled={idx === editPhases.length - 1}
                  onClick={() => {
                    setEditPhases((prev) => {
                      const next = [...prev];
                      const moved = next[idx]!;
                      next.splice(idx, 1);
                      next.splice(idx + 1, 0, moved);
                      return next.map((p, i) => ({ ...p, position: i }));
                    });
                    setDirty(true);
                  }}
                >
                  {"\u2193"}
                </button>
                {phase.isCustom && (
                  <button
                    type="button"
                    className="px-1"
                    style={{ color: COLORS.danger, background: "none", border: "none", cursor: "pointer" }}
                    onClick={() => {
                      setEditPhases((prev) => prev.filter((p) => p.id !== phase.id).map((p, i) => ({ ...p, position: i })));
                      setDirty(true);
                    }}
                  >
                    <X size={10} weight="bold" />
                  </button>
                )}
              </div>
            ))}

            <button
              type="button"
              style={outlineButton()}
              onClick={() => {
                const now = new Date().toISOString();
                setEditPhases((prev) => [
                  ...prev,
                  {
                    id: `custom:${Date.now()}`,
                    phaseKey: `custom_${prev.length + 1}`,
                    name: `Custom Phase ${prev.length + 1}`,
                    description: "",
                    instructions: "",
                    model: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
                    budget: {},
                    orderingConstraints: {},
                    askQuestions: { enabled: false, mode: "never" },
                    validationGate: { tier: "self", required: false },
                    isBuiltIn: false,
                    isCustom: true,
                    position: prev.length,
                    createdAt: now,
                    updatedAt: now,
                  }
                ]);
                setDirty(true);
              }}
            >
              + ADD PHASE
            </button>
          </div>

          {dirty && (
            <div className="flex items-center gap-2 pt-1">
              <button
                style={primaryButton()}
                disabled={phaseBusy || !editName.trim()}
                onClick={async () => {
                  setPhaseBusy(true);
                  try {
                    await window.ade.missions.savePhaseProfile({
                      profile: {
                        id: profile.id,
                        name: editName.trim(),
                        description: editDescription.trim(),
                        phases: editPhases,
                      }
                    });
                    await refreshPhaseProfiles();
                    setPhaseNotice("Profile saved.");
                    setDirty(false);
                    setExpanded(false);
                  } catch (err) {
                    setPhaseError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setPhaseBusy(false);
                  }
                }}
              >
                SAVE
              </button>
              <button
                style={outlineButton()}
                onClick={() => {
                  setEditName(profile.name);
                  setEditDescription(profile.description);
                  setEditPhases(profile.phases);
                  setDirty(false);
                }}
              >
                REVERT
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MissionSettingsDialog({
  open,
  onClose,
  draft,
  onDraftChange,
  onSave,
  busy,
  error,
  notice
}: {
  open: boolean;
  onClose: () => void;
  draft: MissionSettingsDraft;
  onDraftChange: (update: Partial<MissionSettingsDraft>) => void;
  onSave: () => void;
  busy: boolean;
  error: string | null;
  notice: string | null;
}) {
  const [phaseProfiles, setPhaseProfiles] = useState<PhaseProfile[]>([]);
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [phaseNotice, setPhaseNotice] = useState<string | null>(null);
  const [phaseError, setPhaseError] = useState<string | null>(null);

  const refreshPhaseProfiles = useCallback(async () => {
    try {
      const profiles = await window.ade.missions.listPhaseProfiles({});
      setPhaseProfiles(profiles);
      setPhaseError(null);
    } catch (err) {
      setPhaseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPhaseNotice(null);
    void refreshPhaseProfiles();
  }, [open, refreshPhaseProfiles]);

  if (!open) return null;

  const settingsInputStyle: React.CSSProperties = { height: 32, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl shadow-2xl"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
      >
        <div className="flex items-center justify-between px-5 h-14" style={{ background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <GearSix className="h-4 w-4" style={{ color: COLORS.accent }} />
            <h2 className="text-sm font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>MISSION SETTINGS</h2>
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: COLORS.textMuted }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {notice ? <div className="px-3 py-2 text-xs" style={{ border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}18`, color: COLORS.success }}>{notice}</div> : null}
          {error ? <div className="px-3 py-2 text-xs" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}>{error}</div> : null}

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>MISSION DEFAULTS</div>
            <div className="mt-3">
              <div className="px-2 py-1.5 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Execution policy is derived from your Phase Profiles below. Customize phases to control planning, testing, validation, and review behavior.
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="text-xs">
                <div style={settingsLabelStyle}>DEFAULT PLANNER MODEL</div>
                <div className="mt-1">
                  <select
                    style={settingsInputStyle}
                    value={draft.defaultPlannerProvider}
                    onChange={(e) => onDraftChange({ defaultPlannerProvider: e.target.value as PlannerProvider })}
                  >
                    <option value="auto">Auto</option>
                    {([...new Set(MODEL_REGISTRY.map((m) => m.family))] as ProviderFamily[]).map((family) => {
                      const familyModels = MODEL_REGISTRY.filter((m) => m.family === family && !m.deprecated);
                      if (!familyModels.length) return null;
                      return (
                        <optgroup key={family} label={MODEL_FAMILIES[family]?.displayName ?? family}>
                          {familyModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.displayName}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
              </label>
              <label className="text-xs">
                <div style={settingsLabelStyle}>TEAMMATE PLAN MODE</div>
                <select
                  style={settingsInputStyle}
                  value={draft.teammatePlanMode}
                  onChange={(e) => onDraftChange({ teammatePlanMode: toTeammatePlanMode(e.target.value) })}
                >
                  <option value="auto">Auto</option>
                  <option value="off">Off</option>
                  <option value="required">Required</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs pt-5" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                <input
                  type="checkbox"
                  checked={draft.requirePlanReview}
                  onChange={(e) => onDraftChange({ requirePlanReview: e.target.checked })}
                />
                Require plan review
              </label>
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>WORKER PERMISSIONS</div>
            <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>CLAUDE WORKER</div>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>PERMISSION MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.claudePermissionMode}
                    disabled={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudePermissionMode: e.target.value })}
                  >
                    <option value="plan">Plan (read-only)</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="bypassPermissions">Bypass permissions</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudeDangerouslySkip: e.target.checked })}
                  />
                  Dangerously skip permissions
                </label>
                <div className="text-[11px]" style={{ color: COLORS.textMuted }}>
                  Claude workers read `CLAUDE.md` and `.claude/settings.json` from the lane repository root.
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>CODEX WORKER</div>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>SANDBOX MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.codexSandboxPermissions}
                    onChange={(e) => onDraftChange({ codexSandboxPermissions: e.target.value })}
                  >
                    <option value="read-only">Read-only</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="danger-full-access">Full access (dangerous)</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>APPROVAL MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.codexApprovalMode}
                    onChange={(e) => onDraftChange({ codexApprovalMode: e.target.value })}
                  >
                    <option value="suggest">Suggest</option>
                    <option value="auto-edit">Auto-edit</option>
                    <option value="full-auto">Full auto</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>CONFIG TOML PATH</div>
                  <input
                    type="text"
                    style={settingsInputStyle}
                    value={draft.codexConfigPath}
                    onChange={(e) => onDraftChange({ codexConfigPath: e.target.value })}
                    placeholder="e.g. /Users/you/.config/codex/config.toml"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                PHASE PROFILES
              </div>
              <div className="flex items-center gap-2">
                <button
                  style={outlineButton()}
                  disabled={phaseBusy}
                  onClick={async () => {
                    const name = window.prompt("New phase profile name", "Custom Profile");
                    if (!name || !name.trim()) return;
                    const fallback = phaseProfiles.find((profile) => profile.isDefault) ?? phaseProfiles[0] ?? null;
                    const phases = fallback?.phases ?? [];
                    if (!phases.length) return;
                    setPhaseBusy(true);
                    try {
                      await window.ade.missions.savePhaseProfile({
                        profile: {
                          name: name.trim(),
                          description: "Created from Mission Settings",
                          phases
                        }
                      });
                      await refreshPhaseProfiles();
                      setPhaseNotice("Phase profile created.");
                    } catch (err) {
                      setPhaseError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setPhaseBusy(false);
                    }
                  }}
                >
                  + CREATE
                </button>
                <button
                  style={outlineButton()}
                  disabled={phaseBusy}
                  onClick={async () => {
                    const filePath = window.prompt("Import profile JSON path");
                    if (!filePath || !filePath.trim()) return;
                    setPhaseBusy(true);
                    try {
                      await window.ade.missions.importPhaseProfile({ filePath: filePath.trim() });
                      await refreshPhaseProfiles();
                      setPhaseNotice("Profile imported.");
                    } catch (err) {
                      setPhaseError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setPhaseBusy(false);
                    }
                  }}
                >
                  IMPORT
                </button>
              </div>
            </div>

            {phaseNotice ? (
              <div className="mt-2 px-2 py-1.5 text-[10px]" style={{ border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}15`, color: COLORS.success }}>
                {phaseNotice}
              </div>
            ) : null}
            {phaseError ? (
              <div className="mt-2 px-2 py-1.5 text-[10px]" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, color: COLORS.danger }}>
                {phaseError}
              </div>
            ) : null}

            <div className="mt-3 space-y-2">
              {phaseProfiles.map((profile) => (
                <PhaseProfileCard
                  key={profile.id}
                  profile={profile}
                  phaseBusy={phaseBusy}
                  setPhaseBusy={setPhaseBusy}
                  setPhaseNotice={setPhaseNotice}
                  setPhaseError={setPhaseError}
                  refreshPhaseProfiles={refreshPhaseProfiles}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <button style={outlineButton()} onClick={onClose} disabled={busy}>CLOSE</button>
          <button style={primaryButton()} onClick={onSave} disabled={busy}>
            {busy ? "SAVING..." : "SAVE SETTINGS"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
