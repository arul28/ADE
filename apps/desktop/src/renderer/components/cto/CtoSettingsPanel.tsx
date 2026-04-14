import React, { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react";
import type { CtoCoreMemory, CtoIdentity, CtoSessionLogEntry, ExternalMcpAccessPolicy } from "../../../shared/types";
import { IdentityEditor } from "./IdentityEditor";
import { TimelineEntry } from "./shared/TimelineEntry";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { inputCls, labelCls, textareaCls } from "./shared/designTokens";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ExternalMcpAccessEditor } from "../shared/ExternalMcpAccessEditor";
import { OpenclawConnectionPanel } from "./OpenclawConnectionPanel";
import { getCtoPersonalityPreset } from "./identityPresets";
import { CtoPromptPreview } from "./CtoPromptPreview";

/* ── Helpers ── */

function splitTrimmed(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function describeIdentityPersonality(identity: CtoIdentity): string {
  if (identity.personality === "custom") {
    return identity.customPersonality?.trim() || identity.persona || "Custom personality configured.";
  }
  return getCtoPersonalityPreset(identity.personality ?? "strategic").description;
}

type CoreMemoryPatch = Partial<{
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
}>;

/* ── Main Panel ── */

export function CtoSettingsPanel({
  identity,
  coreMemory,
  sessionLogs,
  onSaveIdentity,
  onSaveCoreMemory,
  availableExternalMcpServers,
  onResetOnboarding,
}: {
  identity: CtoIdentity | null;
  coreMemory: CtoCoreMemory | null;
  sessionLogs: CtoSessionLogEntry[];
  onSaveIdentity: (patch: Record<string, unknown>) => Promise<void>;
  onSaveCoreMemory: (patch: CoreMemoryPatch) => Promise<void>;
  availableExternalMcpServers: string[];
  onResetOnboarding?: () => void;
}) {
  const [identityEditing, setIdentityEditing] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState({ projectSummary: "", criticalConventions: "", userPreferences: "", activeFocus: "", notes: "" });
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [externalMcpDraft, setExternalMcpDraft] = useState<ExternalMcpAccessPolicy>({ allowAll: true, allowedServers: [], blockedServers: [] });
  const [externalMcpSaving, setExternalMcpSaving] = useState(false);
  const [externalMcpError, setExternalMcpError] = useState<string | null>(null);

  useEffect(() => {
    if (!memoryEditing && coreMemory) {
      setMemoryDraft({
        projectSummary: coreMemory.projectSummary,
        criticalConventions: coreMemory.criticalConventions.join(", "),
        userPreferences: coreMemory.userPreferences.join(", "),
        activeFocus: coreMemory.activeFocus.join(", "),
        notes: coreMemory.notes.join(", "),
      });
    }
  }, [coreMemory, memoryEditing]);

  useEffect(() => {
    setExternalMcpDraft({
      allowAll: identity?.externalMcpAccess?.allowAll !== false,
      allowedServers: [...new Set(identity?.externalMcpAccess?.allowedServers ?? [])],
      blockedServers: [...new Set(identity?.externalMcpAccess?.blockedServers ?? [])],
    });
  }, [identity]);

  const handleSaveMemory = async () => {
    setMemorySaving(true); setMemoryError(null);
    try {
      await onSaveCoreMemory({
        projectSummary: memoryDraft.projectSummary.trim() || coreMemory?.projectSummary,
        criticalConventions: splitTrimmed(memoryDraft.criticalConventions),
        userPreferences: splitTrimmed(memoryDraft.userPreferences),
        activeFocus: splitTrimmed(memoryDraft.activeFocus),
        notes: splitTrimmed(memoryDraft.notes),
      });
      setMemoryEditing(false);
    } catch (err) { setMemoryError(err instanceof Error ? err.message : "Save failed."); }
    finally { setMemorySaving(false); }
  };

  const handleSaveExternalMcp = useCallback(async () => {
    setExternalMcpSaving(true); setExternalMcpError(null);
    try {
      await onSaveIdentity({ externalMcpAccess: externalMcpDraft });
    } catch (err) {
      setExternalMcpError(err instanceof Error ? err.message : "Save failed.");
    } finally { setExternalMcpSaving(false); }
  }, [externalMcpDraft, onSaveIdentity]);

  const [settingsTab, setSettingsTab] = useState<"identity" | "brief" | "integrations">("identity");

  const SUB_TABS = [
    { id: "identity" as const, label: "Identity", tooltip: "CTO personality, model, and reasoning configuration." },
    { id: "brief" as const, label: "Brief", tooltip: "Project summary, conventions, and focus areas that persist across sessions." },
    { id: "integrations" as const, label: "Integrations", tooltip: "MCP server access and OpenClaw bridge configuration." },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-4">
      {/* Sub-tab bar */}
      <div className="flex items-center gap-1">
        {SUB_TABS.map(({ id, label, tooltip }) => (
          <SmartTooltip key={id} content={{ label, description: tooltip }} side="bottom">
            <button
              type="button"
              onClick={() => setSettingsTab(id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150",
                settingsTab === id
                  ? "bg-accent/10 text-accent border border-accent/20"
                  : "text-muted-fg/50 hover:text-muted-fg/80 hover:bg-white/[0.03] border border-transparent",
              )}
            >
              {label}
            </button>
          </SmartTooltip>
        ))}
        {onResetOnboarding && (
          <Button variant="ghost" size="sm" className="ml-auto !text-[10px] text-muted-fg/40" onClick={onResetOnboarding}>
            <ArrowCounterClockwise size={10} />
            Re-run setup
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        {/* ── Identity sub-tab ── */}
        {settingsTab === "identity" && (
          <>
            {identityEditing ? (
              <IdentityEditor identity={identity} onSave={onSaveIdentity} onCancel={() => setIdentityEditing(false)} />
            ) : identity ? (
              <div className="space-y-4">
                {/* Identity card */}
                <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid var(--color-accent)" }}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-xs font-semibold text-fg">CTO Identity</div>
                    <Button variant="outline" size="sm" onClick={() => setIdentityEditing(true)}>
                      <PencilSimple size={10} /> Edit
                    </Button>
                  </div>
                  <div className="text-xs text-muted-fg/55 leading-relaxed mb-3">{describeIdentityPersonality(identity)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: `${identity.modelPreferences.provider}/${identity.modelPreferences.model}` },
                      ...(identity.personality ? [{ label: getCtoPersonalityPreset(identity.personality).label }] : []),
                      ...(identity.modelPreferences.reasoningEffort ? [{ label: `reasoning: ${identity.modelPreferences.reasoningEffort}` }] : []),
                    ].map((tag) => (
                      <span key={tag.label} className="rounded-md border border-accent/15 bg-accent/8 px-2 py-0.5 text-[10px] font-medium text-accent">
                        {tag.label}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Prompt preview card */}
                <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid #60A5FA" }}>
                  <div className="text-xs font-semibold text-fg mb-3">Prompt Preview</div>
                  <CtoPromptPreview compact />
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-fg/40">Loading...</div>
            )}
          </>
        )}

        {/* ── Brief sub-tab ── */}
        {settingsTab === "brief" && (
          <>
            {/* Brief card */}
            <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid #22C55E" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-fg">Project Brief</div>
                {!memoryEditing && (
                  <Button variant="outline" size="sm" onClick={() => setMemoryEditing(true)} data-testid="core-memory-edit-btn">
                    <PencilSimple size={10} /> Edit
                  </Button>
                )}
              </div>
              <div className="text-[11px] text-muted-fg/40 mb-3">
                The persistent brief ADE reloads after compaction and across fresh chat resumes.
              </div>

            {memoryEditing ? (
              <div className="space-y-3">
                {[
                  { key: "projectSummary" as const, label: "Summary", multiline: true },
                  { key: "criticalConventions" as const, label: "Conventions", multiline: false },
                  { key: "userPreferences" as const, label: "Preferences", multiline: false },
                  { key: "activeFocus" as const, label: "Focus", multiline: false },
                  { key: "notes" as const, label: "Notes", multiline: false },
                ].map(({ key, label, multiline }) => (
                  <label key={key} className="space-y-1.5 block">
                    <div className={labelCls}>{label}</div>
                    {multiline ? (
                      <textarea className={cn(textareaCls, "min-h-[60px]")} rows={3} value={memoryDraft[key]} onChange={(e) => setMemoryDraft((d) => ({ ...d, [key]: e.target.value }))} />
                    ) : (
                      <input className={inputCls} placeholder="comma-separated" value={memoryDraft[key]} onChange={(e) => setMemoryDraft((d) => ({ ...d, [key]: e.target.value }))} />
                    )}
                  </label>
                ))}
                {memoryError && <div className="text-xs text-error" data-testid="core-memory-save-error">{memoryError}</div>}
                <div className="flex gap-2">
                  <Button variant="primary" disabled={memorySaving} onClick={handleSaveMemory} data-testid="core-memory-save-btn">
                    {memorySaving ? "Saving..." : "Save"}
                  </Button>
                  <Button variant="outline" disabled={memorySaving} onClick={() => { setMemoryEditing(false); setMemoryError(null); }} data-testid="core-memory-cancel-btn">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : coreMemory ? (
              <div className="space-y-3" data-testid="core-memory-view">
                <div className="text-xs text-muted-fg/55 leading-relaxed">
                  {coreMemory.projectSummary || "No project summary yet."}
                </div>
                {[
                  { items: coreMemory.criticalConventions, label: "Conventions" },
                  { items: coreMemory.activeFocus, label: "Focus" },
                  { items: coreMemory.userPreferences, label: "Preferences" },
                  { items: coreMemory.notes, label: "Notes" },
                ].filter(({ items }) => items.length > 0).map(({ items, label }) => (
                  <div key={label} className="flex items-start gap-2">
                    <span className="text-[10px] font-medium text-muted-fg/50 shrink-0">{label}:</span>
                    <span className="text-[10px] text-muted-fg/40">{items.join(", ")}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-fg/40">Loading...</div>
            )}
            </div>

            {/* Session history card */}
            <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid #FBBF24" }}>
              <div className="text-xs font-semibold text-fg mb-3">Session History</div>
              <div className="max-h-48 overflow-y-auto space-y-1" data-testid="session-history-list">
                {sessionLogs.length === 0 ? (
                  <div className="text-[10px] text-muted-fg/40 py-2">No sessions yet.</div>
                ) : sessionLogs.map((s) => (
                  <TimelineEntry
                    key={s.id}
                    timestamp={s.createdAt}
                    title={s.summary}
                    status={s.capabilityMode}
                    statusVariant={s.capabilityMode === "full_mcp" ? "success" : "muted"}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Integrations sub-tab ── */}
        {settingsTab === "integrations" && (
          <div className="space-y-4">
            {/* MCP Access card */}
            <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid #3B82F6" }}>
              <div className="text-xs font-semibold text-fg mb-3">MCP Access</div>
              <ExternalMcpAccessEditor
                value={externalMcpDraft}
                availableServers={availableExternalMcpServers}
                description="Controls which MCP servers the CTO and workers can access."
                onChange={setExternalMcpDraft}
              />
              {externalMcpError && <div className="text-xs text-error mt-2">{externalMcpError}</div>}
              <div className="flex justify-end mt-3">
                <Button variant="outline" size="sm" disabled={externalMcpSaving} onClick={() => void handleSaveExternalMcp()}>
                  {externalMcpSaving ? "Saving..." : "Save MCP Policy"}
                </Button>
              </div>
            </div>

            {/* OpenClaw Bridge card */}
            <div className="rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] backdrop-blur-[20px] shadow-card p-4" style={{ borderLeft: "3px solid #FB7185" }}>
              <div className="text-xs font-semibold text-fg mb-3">OpenClaw Bridge</div>
              <OpenclawConnectionPanel identity={identity} onSaveIdentity={onSaveIdentity} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
