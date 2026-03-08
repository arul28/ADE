import React, { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { GearSix, GitBranch, BookOpenText, Robot, Terminal, Keyboard, Lightning, Plugs, SquaresFour, Stack, Plus, X } from "@phosphor-icons/react";
import { GeneralSection } from "../settings/GeneralSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { GitHubSection } from "../settings/GitHubSection";
import { ContextSection } from "../settings/ContextSection";
import { UsageDashboard } from "../missions/UsageDashboard";
import { AutomationsSection } from "../settings/AutomationsSection";
import { TerminalProfilesSection } from "../settings/TerminalProfilesSection";
import { KeybindingsSection } from "../settings/KeybindingsSection";
import { LaneTemplatesSection } from "../settings/LaneTemplatesSection";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton, dangerButton } from "../lanes/laneDesignTokens";
import { ConfirmDialog, PromptDialog, useConfirmDialog, usePromptDialog } from "../shared/InlineDialogs";
import type { PhaseProfile, PhaseCard } from "../../../shared/types";
import { PhaseCardEditor } from "../missions/PhaseCardEditor";

const SECTIONS = [
  { id: "general", label: "General", icon: GearSix },
  { id: "providers", label: "Providers", icon: Plugs },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "context", label: "Context & Docs", icon: BookOpenText },
  { id: "automations", label: "Automations", icon: Robot },
  { id: "terminals", label: "Terminals", icon: Terminal },
  { id: "lane-templates", label: "Lane Templates", icon: Stack },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "phase-profiles", label: "Phase Profiles", icon: SquaresFour },
  { id: "usage", label: "Usage", icon: Lightning },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function padIndex(i: number): string {
  return String(i + 1).padStart(2, "0");
}

/* ──────────────── Phase Profiles Section ──────────────── */

const SECTION_LABEL: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const SETTINGS_INPUT: React.CSSProperties = {
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

const FIELD_LABEL: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

function PhaseProfileSettingsCard({
  profile,
  busy,
  onAction,
}: {
  profile: PhaseProfile;
  busy: boolean;
  onAction: (action: "clone" | "export" | "delete" | "save", payload?: { name: string; description: string; phases: PhaseCard[] }) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(profile.name);
  const [editDescription, setEditDescription] = useState(profile.description);
  const [editPhases, setEditPhases] = useState<PhaseCard[]>(profile.phases);
  const [dirty, setDirty] = useState(false);
  const [expandedPhaseIds, setExpandedPhaseIds] = useState<Record<string, boolean>>({});

  const isReadOnly = profile.isBuiltIn;

  return (
    <div style={{ ...cardStyle({ padding: 12 }), marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontFamily: MONO_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
            {profile.isBuiltIn && <span style={{ color: COLORS.accent, marginRight: 4 }}>{"\u25CF"}</span>}
            {profile.name}
            {profile.isDefault && <span style={{ fontSize: 9, fontWeight: 600, color: "#22C55E", marginLeft: 6, fontFamily: MONO_FONT }}>DEFAULT</span>}
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
            {profile.description || profile.phases.map((p) => p.name).join(" \u2192 ")}
          </div>
          <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 2 }}>
            {profile.phases.length} phase{profile.phases.length !== 1 ? "s" : ""} · {profile.isBuiltIn ? "Built-in (read-only)" : "Custom"}
          </div>
        </div>
        <button
          style={outlineButton()}
          disabled={busy}
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
        <button style={outlineButton()} disabled={busy} onClick={() => onAction("clone")}>CLONE</button>
        <button style={outlineButton()} disabled={busy} onClick={() => onAction("export")}>EXPORT</button>
        {!profile.isBuiltIn && (
          <button style={dangerButton()} disabled={busy} onClick={() => onAction("delete")}>DELETE</button>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
          {!isReadOnly && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <label>
                <div style={FIELD_LABEL}>PROFILE NAME</div>
                <input value={editName} onChange={(e) => { setEditName(e.target.value); setDirty(true); }} style={{ ...SETTINGS_INPUT, marginTop: 2 }} />
              </label>
              <label>
                <div style={FIELD_LABEL}>DESCRIPTION</div>
                <input value={editDescription} onChange={(e) => { setEditDescription(e.target.value); setDirty(true); }} placeholder="Describe this profile" style={{ ...SETTINGS_INPUT, marginTop: 2 }} />
              </label>
            </div>
          )}

          <div style={{ marginBottom: 4 }}>
            <div style={FIELD_LABEL}>PHASES ({editPhases.length})</div>
          </div>

          {editPhases.map((phase, idx) => (
            <div key={phase.id} style={{ marginBottom: 4 }}>
              <PhaseCardEditor
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
                labelStyle={FIELD_LABEL}
                inputStyle={SETTINGS_INPUT}
              />
            </div>
          ))}

          {!isReadOnly && (
            <button
              type="button"
              style={outlineButton({ marginTop: 4 })}
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
              <Plus size={10} weight="bold" /> ADD PHASE
            </button>
          )}

          {dirty && !isReadOnly && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <button
                style={primaryButton()}
                disabled={busy || !editName.trim()}
                onClick={() => onAction("save", { name: editName.trim(), description: editDescription.trim(), phases: editPhases })}
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

function PhaseProfilesSection() {
  const [profiles, setProfiles] = useState<PhaseProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deleteConfirm = useConfirmDialog();
  const createPrompt = usePromptDialog();
  const importPrompt = usePromptDialog();

  const refresh = useCallback(async () => {
    try {
      const result = await window.ade.missions.listPhaseProfiles({});
      setProfiles(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleAction = useCallback(async (
    profileId: string,
    action: "clone" | "export" | "delete" | "save",
    payload?: { name: string; description: string; phases: PhaseCard[] }
  ) => {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      if (action === "clone") {
        await window.ade.missions.clonePhaseProfile({ profileId });
        await refresh();
        setNotice("Profile cloned.");
      } else if (action === "export") {
        const exported = await window.ade.missions.exportPhaseProfile({ profileId });
        setNotice(exported.savedPath ? `Exported: ${exported.savedPath}` : "Profile exported.");
      } else if (action === "delete") {
        const profile = profiles.find((p) => p.id === profileId);
        const ok = await deleteConfirm.confirmAsync({
          title: "Delete Phase Profile",
          message: `Delete phase profile "${profile?.name ?? profileId}"?`,
          confirmLabel: "DELETE",
          danger: true,
        });
        if (!ok) {
          setBusy(false);
          return;
        }
        await window.ade.missions.deletePhaseProfile({ profileId });
        await refresh();
        setNotice("Profile deleted.");
      } else if (action === "save" && payload) {
        await window.ade.missions.savePhaseProfile({
          profile: {
            id: profileId,
            name: payload.name,
            description: payload.description,
            phases: payload.phases,
          }
        });
        await refresh();
        setNotice("Profile saved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [profiles, refresh]);

  if (loading) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Loading phase profiles...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <ConfirmDialog state={deleteConfirm.state} onClose={deleteConfirm.close} />
      <PromptDialog state={createPrompt.state} onClose={createPrompt.close} />
      <PromptDialog state={importPrompt.state} onClose={importPrompt.close} />
      <div style={SECTION_LABEL}>PHASE PROFILES</div>

      <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT, marginBottom: 12 }}>
        Phase profiles define the sequence of work phases for missions (development, testing, validation, PR). Built-in profiles can be viewed but not edited. Clone or create custom profiles to customize phase descriptions, instructions, models, validation gates, and clarification settings.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          style={outlineButton()}
          disabled={busy}
          onClick={async () => {
            const name = await createPrompt.promptAsync({
              title: "Create Phase Profile",
              message: "Enter a name for the new phase profile.",
              defaultValue: "Custom Profile",
              confirmLabel: "CREATE",
            });
            if (!name || !name.trim()) return;
            const fallback = profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;
            const phases = fallback?.phases ?? [];
            if (!phases.length) { setError("No base profile found to derive phases from."); return; }
            setBusy(true);
            try {
              await window.ade.missions.savePhaseProfile({
                profile: { name: name.trim(), description: "Created from Settings", phases }
              });
              await refresh();
              setNotice("Phase profile created.");
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus size={12} weight="bold" /> CREATE PROFILE
        </button>
        <button
          style={outlineButton()}
          disabled={busy}
          onClick={async () => {
            const filePath = await importPrompt.promptAsync({
              title: "Import Phase Profile",
              message: "Enter the path to the phase profile JSON file.",
              placeholder: "/path/to/profile.json",
              confirmLabel: "IMPORT",
            });
            if (!filePath || !filePath.trim()) return;
            setBusy(true);
            try {
              await window.ade.missions.importPhaseProfile({ filePath: filePath.trim() });
              await refresh();
              setNotice("Profile imported.");
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          IMPORT
        </button>
      </div>

      {notice && (
        <div style={{ padding: "6px 10px", marginBottom: 8, fontSize: 11, border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}15`, color: COLORS.success }}>
          {notice}
        </div>
      )}
      {error && (
        <div style={{ padding: "6px 10px", marginBottom: 8, fontSize: 11, border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, color: COLORS.danger }}>
          {error}
        </div>
      )}

      {profiles.map((profile) => (
        <PhaseProfileSettingsCard
          key={profile.id}
          profile={profile}
          busy={busy}
          onAction={(action, payload) => handleAction(profile.id, action, payload)}
        />
      ))}

      {profiles.length === 0 && !loading && (
        <div style={{ padding: 16, fontSize: 11, color: COLORS.textDim, fontFamily: MONO_FONT, textAlign: "center" as const }}>
          No phase profiles found. Create one or import from a JSON file.
        </div>
      )}
    </div>
  );
}

/* ──────────────── Main Settings Page ──────────────── */

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") as SectionId | null;
  const validTab = tabParam && SECTIONS.some((s) => s.id === tabParam) ? tabParam : null;
  const [section, setSection] = useState<SectionId>(validTab ?? "general");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Sync from URL when ?tab= changes
  useEffect(() => {
    if (validTab && validTab !== section) {
      setSection(validTab);
    }
  }, [validTab]);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Left sidebar */}
      <nav
        style={{
          width: 200,
          flexShrink: 0,
          background: COLORS.recessedBg,
          borderRight: `1px solid ${COLORS.border}`,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 8,
          paddingRight: 8,
        }}
      >
        <div style={{ ...LABEL_STYLE, paddingLeft: 10, marginBottom: 12 }}>
          SETTINGS
        </div>

        {SECTIONS.map((s, i) => {
          const isActive = section === s.id;
          const isHovered = hoveredId === s.id;

          const itemStyle: React.CSSProperties = {
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            border: "none",
            borderLeft: isActive ? `3px solid ${COLORS.accent}` : "3px solid transparent",
            background: isActive
              ? COLORS.accentSubtle
              : isHovered
                ? COLORS.hoverBg
                : "transparent",
            color: isActive ? COLORS.textPrimary : COLORS.textMuted,
            fontFamily: MONO_FONT,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "1px",
            cursor: "pointer",
            borderRadius: 0,
            transition: "background 120ms ease, color 120ms ease",
          };

          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={itemStyle}
            >
              <s.icon size={14} weight="regular" style={{ flexShrink: 0 }} />
              <span>{padIndex(i)} {s.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Right content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: COLORS.pageBg,
          padding: 24,
        }}
      >
        {section === "general" && <GeneralSection />}
        {section === "providers" && <ProvidersSection />}
        {section === "github" && <GitHubSection />}
        {section === "context" && <ContextSection />}
        {section === "automations" && <AutomationsSection />}
        {section === "terminals" && <TerminalProfilesSection />}
        {section === "lane-templates" && <LaneTemplatesSection />}
        {section === "keybindings" && <KeybindingsSection />}
        {section === "phase-profiles" && <PhaseProfilesSection />}
        {section === "usage" && <UsageDashboard missionId={null} />}
      </div>
    </div>
  );
}
