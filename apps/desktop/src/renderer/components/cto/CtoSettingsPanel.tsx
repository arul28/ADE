import React, { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react";
import type { CtoCoreMemory, CtoIdentity, CtoSessionLogEntry, ExternalMcpAccessPolicy } from "../../../shared/types";
import { IdentityEditor } from "./IdentityEditor";
import { TimelineEntry } from "./shared/TimelineEntry";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";
import { inputCls, labelCls, textareaCls, cardCls } from "./shared/designTokens";
import { ExternalMcpAccessEditor } from "../shared/ExternalMcpAccessEditor";
import { OpenclawConnectionPanel } from "./OpenclawConnectionPanel";

/* ── Helpers ── */

function splitTrimmed(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
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
  /* Identity editor toggle */
  const [identityEditing, setIdentityEditing] = useState(false);

  /* Memory editor */
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState({ projectSummary: "", criticalConventions: "", userPreferences: "", activeFocus: "", notes: "" });
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [externalMcpDraft, setExternalMcpDraft] = useState<ExternalMcpAccessPolicy>({
    allowAll: true,
    allowedServers: [],
    blockedServers: [],
  });
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
    setExternalMcpSaving(true);
    setExternalMcpError(null);
    try {
      await onSaveIdentity({ externalMcpAccess: externalMcpDraft });
    } catch (err) {
      setExternalMcpError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setExternalMcpSaving(false);
    }
  }, [externalMcpDraft, onSaveIdentity]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 gap-4">
      {/* CTO Identity */}
      <div className={cn(cardCls, "overflow-hidden")}>
        <PaneHeader
          title="CTO Identity"
          right={
            !identityEditing ? (
              <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => setIdentityEditing(true)}>
                <PencilSimple size={10} />
              </Button>
            ) : undefined
          }
        />
        {identityEditing ? (
          <div className="p-4">
            <IdentityEditor
              identity={identity}
              onSave={onSaveIdentity}
              onCancel={() => setIdentityEditing(false)}
            />
          </div>
        ) : identity ? (
          <div className="p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-bold text-fg">{identity.name}</span>
              <span className="font-mono text-[10px] text-muted-fg/50">v{identity.version}</span>
            </div>
            <div className="font-mono text-[10px] text-muted-fg leading-relaxed">{identity.persona}</div>
            {identity.personality && (
              <div className="font-mono text-[9px] text-muted-fg/40">
                Personality: <span className="text-muted-fg">{identity.personality}{identity.customPersonality ? ` — ${identity.customPersonality}` : ""}</span>
              </div>
            )}
            <div className="flex gap-3 mt-1">
              <span className="font-mono text-[9px] text-muted-fg/40">Provider: <span className="text-muted-fg">{identity.modelPreferences.provider}</span></span>
              <span className="font-mono text-[9px] text-muted-fg/40">Model: <span className="text-muted-fg">{identity.modelPreferences.model}</span></span>
              {identity.modelPreferences.reasoningEffort && (
                <span className="font-mono text-[9px] text-muted-fg/40">Reasoning: <span className="text-muted-fg">{identity.modelPreferences.reasoningEffort}</span></span>
              )}
            </div>
            {identity.communicationStyle && (
              <div className="flex gap-3 mt-0.5">
                <span className="font-mono text-[9px] text-muted-fg/40">Verbosity: <span className="text-muted-fg">{identity.communicationStyle.verbosity}</span></span>
                <span className="font-mono text-[9px] text-muted-fg/40">Proactivity: <span className="text-muted-fg">{identity.communicationStyle.proactivity}</span></span>
                <span className="font-mono text-[9px] text-muted-fg/40">Escalation: <span className="text-muted-fg">{identity.communicationStyle.escalationThreshold}</span></span>
              </div>
            )}
            {identity.constraints && identity.constraints.length > 0 && (
              <div className="mt-1">
                <span className="font-mono text-[9px] text-muted-fg/40">Constraints: </span>
                <span className="font-mono text-[9px] text-muted-fg/60">{identity.constraints.join(", ")}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-fg/50">Loading identity...</div>
        )}
      </div>

      {/* Core Memory */}
      <div className={cn(cardCls, "overflow-hidden")}>
        <PaneHeader title="External MCP Access" />
        <div className="p-4 space-y-3">
          <ExternalMcpAccessEditor
            value={externalMcpDraft}
            availableServers={availableExternalMcpServers}
            description="This policy applies to CTO-managed sessions and to ADE-managed mission workers that don’t belong to a named persistent worker profile."
            onChange={setExternalMcpDraft}
          />
          {externalMcpError && <div className="text-xs text-error">{externalMcpError}</div>}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={externalMcpSaving} onClick={() => void handleSaveExternalMcp()}>
              {externalMcpSaving ? "Saving..." : "Save Access Policy"}
            </Button>
          </div>
        </div>
      </div>

      <div className={cn(cardCls, "overflow-hidden")}>
        <PaneHeader title="OpenClaw" />
        <div className="p-4">
          <OpenclawConnectionPanel
            identity={identity}
            onSaveIdentity={onSaveIdentity}
          />
        </div>
      </div>

      {/* Core Memory */}
      <div className={cn(cardCls, "overflow-hidden")}>
        <PaneHeader
          title="Core Memory"
          right={
            !memoryEditing ? (
              <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => setMemoryEditing(true)} data-testid="core-memory-edit-btn">
                <PencilSimple size={10} />
              </Button>
            ) : undefined
          }
        />
        {memoryEditing ? (
          <div className="p-4 space-y-3">
            {[
              { key: "projectSummary" as const, label: "Summary", multiline: true },
              { key: "criticalConventions" as const, label: "Conventions", multiline: false },
              { key: "userPreferences" as const, label: "Preferences", multiline: false },
              { key: "activeFocus" as const, label: "Focus", multiline: false },
              { key: "notes" as const, label: "Notes", multiline: false },
            ].map(({ key, label, multiline }) => (
              <label key={key} className="space-y-1 block">
                <div className={labelCls}>{label}</div>
                {multiline ? (
                  <textarea className={cn(textareaCls, "min-h-[40px]")} rows={2} value={memoryDraft[key]} onChange={(e) => setMemoryDraft((d) => ({ ...d, [key]: e.target.value }))} />
                ) : (
                  <input className={inputCls} placeholder="comma-separated" value={memoryDraft[key]} onChange={(e) => setMemoryDraft((d) => ({ ...d, [key]: e.target.value }))} />
                )}
              </label>
            ))}
            {memoryError && <div className="text-xs text-error" data-testid="core-memory-save-error">{memoryError}</div>}
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={memorySaving} onClick={handleSaveMemory} data-testid="core-memory-save-btn">
                {memorySaving ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" className="flex-1" disabled={memorySaving} onClick={() => { setMemoryEditing(false); setMemoryError(null); }} data-testid="core-memory-cancel-btn">
                Cancel
              </Button>
            </div>
          </div>
        ) : coreMemory ? (
          <div className="p-4" data-testid="core-memory-view">
            <div className="font-mono text-[10px] text-muted-fg leading-relaxed">
              {coreMemory.projectSummary || "No project summary yet."}
            </div>
            {[
              { items: coreMemory.criticalConventions, label: "Conventions" },
              { items: coreMemory.activeFocus, label: "Focus" },
              { items: coreMemory.userPreferences, label: "Prefs" },
              { items: coreMemory.notes, label: "Notes" },
            ].filter(({ items }) => items.length > 0).map(({ items, label }) => (
              <div key={label} className="mt-1.5">
                <span className="font-mono text-[9px] text-muted-fg/40">{label}: </span>
                <span className="font-mono text-[9px] text-muted-fg/60">{items.join(", ")}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-fg/50">Loading memory...</div>
        )}
      </div>

      {/* Session History */}
      <div className={cn(cardCls, "overflow-hidden")}>
        <PaneHeader title="Recent Sessions" meta={`${sessionLogs.length}`} />
        <div className="p-3 max-h-64 overflow-y-auto space-y-1" data-testid="session-history-list">
          {sessionLogs.length === 0 ? (
            <div className="text-[10px] text-muted-fg/50 py-2">No sessions recorded yet.</div>
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

      {/* Re-run Setup Wizard */}
      {onResetOnboarding && (
        <div className={cn(cardCls, "overflow-hidden")}>
          <PaneHeader title="Setup Wizard" />
          <div className="p-4 flex items-center justify-between">
            <div className="font-mono text-[10px] text-muted-fg leading-relaxed">
              Re-run the initial setup wizard to reconfigure identity, project context, and integrations.
            </div>
            <Button variant="outline" size="sm" className="shrink-0 ml-4" onClick={onResetOnboarding}>
              <ArrowCounterClockwise size={10} />
              Re-run Setup
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
