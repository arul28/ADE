import React, { useState, useCallback, useEffect } from "react";
import {
  GearSix,
  X,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { PhaseProfile, PhaseCard } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { ConfirmDialog, PromptDialog, useConfirmDialog, usePromptDialog } from "../shared/InlineDialogs";
import {
  type MissionSettingsDraft,
  toTeammatePlanMode,
} from "./missionHelpers";
import { PhaseCardEditor } from "./PhaseCardEditor";
import { WorkerPermissionsEditor } from "./WorkerPermissionsEditor";
import { ModelSelector } from "./ModelSelector";

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
  const [editPhases, setEditPhases] = useState<PhaseCard[]>(profile.phases);
  const [dirty, setDirty] = useState(false);
  const [expandedPhaseIds, setExpandedPhaseIds] = useState<Record<string, boolean>>({});
  const deleteConfirm = useConfirmDialog();

  const settingsInputStyle: React.CSSProperties = { height: 28, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 11, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  const isReadOnly = profile.isBuiltIn;

  return (
    <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <ConfirmDialog state={deleteConfirm.state} onClose={deleteConfirm.close} />
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
        <button
          style={outlineButton()}
          disabled={phaseBusy}
          onClick={() => {
            if (!expanded) {
              setEditName(profile.name);
              setEditDescription(profile.description);
              setEditPhases(profile.phases);
              setDirty(false);
              setExpandedPhaseIds({});
            }
            setExpanded(!expanded);
          }}
        >
          {expanded ? "HIDE" : isReadOnly ? "VIEW" : "EDIT"}
        </button>
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
              const ok = await deleteConfirm.confirmAsync({
                title: "Delete Phase Profile",
                message: `Delete phase profile "${profile.name}"?`,
                confirmLabel: "DELETE",
                danger: true,
              });
              if (!ok) return;
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

      {expanded && (
        <div className="mt-3 space-y-3 pt-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          {!isReadOnly && (
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
          )}

          <div className="space-y-1">
            <span style={settingsLabelStyle}>PHASES ({editPhases.length})</span>
            {editPhases.map((phase, idx) => (
              <PhaseCardEditor
                key={phase.id}
                phase={phase}
                index={idx}
                totalCount={editPhases.length}
                expanded={expandedPhaseIds[phase.id] === true}
                readOnly={isReadOnly}
                onToggleExpand={() => setExpandedPhaseIds((prev) => ({ ...prev, [phase.id]: !prev[phase.id] }))}
                onUpdate={(updated) => {
                  setEditPhases((prev) => prev.map((p) => p.id === updated.id ? updated : p));
                  setDirty(true);
                }}
                onMoveUp={() => {
                  if (idx === 0) return;
                  setEditPhases((prev) => {
                    const next = [...prev];
                    const moved = next[idx]!;
                    next.splice(idx, 1);
                    next.splice(idx - 1, 0, moved);
                    return next.map((p, i) => ({ ...p, position: i }));
                  });
                  setDirty(true);
                }}
                onMoveDown={() => {
                  setEditPhases((prev) => {
                    if (idx >= prev.length - 1) return prev;
                    const next = [...prev];
                    const moved = next[idx]!;
                    next.splice(idx, 1);
                    next.splice(idx + 1, 0, moved);
                    return next.map((p, i) => ({ ...p, position: i }));
                  });
                  setDirty(true);
                }}
                onRemove={phase.isCustom && !isReadOnly ? () => {
                  setEditPhases((prev) => prev.filter((p) => p.id !== phase.id).map((p, i) => ({ ...p, position: i })));
                  setDirty(true);
                } : undefined}
                labelStyle={settingsLabelStyle}
                inputStyle={settingsInputStyle}
              />
            ))}

            {!isReadOnly && (
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
                      model: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
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
            )}
          </div>

          {dirty && !isReadOnly && (
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
  const createPrompt = usePromptDialog();
  const importPrompt = usePromptDialog();

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

  const defaultProfile = phaseProfiles.find((p) => p.isDefault) ?? phaseProfiles[0] ?? null;

  if (!open) return null;

  const settingsInputStyle: React.CSSProperties = { height: 32, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <PromptDialog state={createPrompt.state} onClose={createPrompt.close} />
      <PromptDialog state={importPrompt.state} onClose={importPrompt.close} />
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
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="text-xs">
                <div style={settingsLabelStyle}>DEFAULT ORCHESTRATOR MODEL</div>
                <div className="mt-1">
                  <ModelSelector
                    value={draft.defaultOrchestratorModel}
                    onChange={(config) => onDraftChange({ defaultOrchestratorModel: config })}
                    compact
                  />
                </div>
              </div>
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
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <WorkerPermissionsEditor
              orchestratorModelId={draft.defaultOrchestratorModel?.modelId}
              phases={defaultProfile?.phases ?? []}
              permissionConfig={draft.permissionConfig}
              onPermissionChange={(next) => onDraftChange({ permissionConfig: next })}
            />
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
                    const name = await createPrompt.promptAsync({
                      title: "Create Phase Profile",
                      message: "Enter a name for the new phase profile.",
                      defaultValue: "Custom Profile",
                      confirmLabel: "CREATE",
                    });
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
                    const filePath = await importPrompt.promptAsync({
                      title: "Import Phase Profile",
                      message: "Enter the path to the phase profile JSON file.",
                      placeholder: "/path/to/profile.json",
                      confirmLabel: "IMPORT",
                    });
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
