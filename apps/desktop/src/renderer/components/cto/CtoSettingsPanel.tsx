import React, { useCallback, useEffect, useState } from "react";
import { ArrowCounterClockwise, CaretDown, CaretRight, PencilSimple } from "@phosphor-icons/react";
import type { CtoCoreMemory, CtoIdentity, CtoSessionLogEntry, ExternalMcpAccessPolicy } from "../../../shared/types";
import { IdentityEditor } from "./IdentityEditor";
import { TimelineEntry } from "./shared/TimelineEntry";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { inputCls, labelCls, textareaCls, cardCls, ACCENT } from "./shared/designTokens";
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

/* ── Collapsible section ── */

function CollapsibleSection({ title, color, defaultOpen = true, right, children }: {
  title: string;
  color: string;
  defaultOpen?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn(cardCls, "overflow-hidden !p-0")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          <span className="text-xs font-semibold text-fg">{title}</span>
          {open ? <CaretDown size={10} className="text-muted-fg/30" /> : <CaretRight size={10} className="text-muted-fg/30" />}
        </div>
        {right && <div onClick={(e) => e.stopPropagation()}>{right}</div>}
      </button>
      {open && children}
    </div>
  );
}

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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 gap-3">
      {/* Identity */}
      <CollapsibleSection
        title="Identity"
        color={ACCENT.purple}
        right={
          !identityEditing ? (
            <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => setIdentityEditing(true)}>
              <PencilSimple size={10} />
            </Button>
          ) : undefined
        }
      >
        {identityEditing ? (
          <div className="px-4 pb-4">
            <IdentityEditor identity={identity} onSave={onSaveIdentity} onCancel={() => setIdentityEditing(false)} />
          </div>
        ) : identity ? (
          <div className="px-4 pb-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-fg">{identity.name}</span>
              <span className="text-[10px] text-muted-fg/35">v{identity.version}</span>
            </div>
            <div className="text-xs text-muted-fg/55 leading-relaxed line-clamp-3">{identity.persona}</div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {[
                { label: identity.modelPreferences.provider, color: ACCENT.blue },
                { label: identity.modelPreferences.model, color: ACCENT.green },
                ...(identity.personality ? [{ label: identity.personality, color: ACCENT.pink }] : []),
                ...(identity.modelPreferences.reasoningEffort ? [{ label: `reasoning: ${identity.modelPreferences.reasoningEffort}`, color: ACCENT.amber }] : []),
              ].map((tag) => (
                <span key={tag.label} className="rounded-md px-2 py-0.5 text-[10px] font-medium" style={{ color: tag.color, background: `${tag.color}12`, border: `1px solid ${tag.color}20` }}>
                  {tag.label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="px-4 pb-4 text-xs text-muted-fg/40">Loading...</div>
        )}
      </CollapsibleSection>

      {/* Core Memory */}
      <CollapsibleSection
        title="Core Memory"
        color={ACCENT.green}
        right={
          !memoryEditing ? (
            <Button variant="ghost" size="sm" className="!h-5 !px-1.5" onClick={() => setMemoryEditing(true)} data-testid="core-memory-edit-btn">
              <PencilSimple size={10} />
            </Button>
          ) : undefined
        }
      >
        {memoryEditing ? (
          <div className="px-4 pb-4 space-y-3">
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
          <div className="px-4 pb-4" data-testid="core-memory-view">
            <div className="text-xs text-muted-fg/55 leading-relaxed line-clamp-3">
              {coreMemory.projectSummary || "No project summary yet."}
            </div>
            {[
              { items: coreMemory.criticalConventions, label: "Conventions", color: ACCENT.blue },
              { items: coreMemory.activeFocus, label: "Focus", color: ACCENT.green },
              { items: coreMemory.userPreferences, label: "Prefs", color: ACCENT.pink },
              { items: coreMemory.notes, label: "Notes", color: ACCENT.amber },
            ].filter(({ items }) => items.length > 0).map(({ items, label, color }) => (
              <div key={label} className="mt-1.5 flex items-start gap-1.5">
                <span className="text-[10px] font-medium shrink-0" style={{ color }}>{label}:</span>
                <span className="text-[10px] text-muted-fg/50">{items.join(", ")}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 pb-4 text-xs text-muted-fg/40">Loading...</div>
        )}
      </CollapsibleSection>

      {/* External MCP Access — collapsed by default */}
      <CollapsibleSection title="MCP Access" color={ACCENT.blue} defaultOpen={false}>
        <div className="px-4 pb-4 space-y-3">
          <ExternalMcpAccessEditor
            value={externalMcpDraft}
            availableServers={availableExternalMcpServers}
            description="Controls which MCP servers the CTO and mission workers can access."
            onChange={setExternalMcpDraft}
          />
          {externalMcpError && <div className="text-xs text-error">{externalMcpError}</div>}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={externalMcpSaving} onClick={() => void handleSaveExternalMcp()}>
              {externalMcpSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* OpenClaw Bridge — collapsed by default */}
      <CollapsibleSection title="OpenClaw Bridge" color={ACCENT.pink} defaultOpen={false}>
        <div className="px-4 pb-4">
          <OpenclawConnectionPanel identity={identity} onSaveIdentity={onSaveIdentity} />
        </div>
      </CollapsibleSection>

      {/* Recent Sessions */}
      <CollapsibleSection title="Recent Sessions" color={ACCENT.amber} defaultOpen={false}>
        <div className="px-4 pb-3 max-h-48 overflow-y-auto space-y-1" data-testid="session-history-list">
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
      </CollapsibleSection>

      {/* Re-run Setup */}
      {onResetOnboarding && (
        <div className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-[rgba(24,20,35,0.3)] px-4 py-3">
          <span className="text-xs text-muted-fg/40">Re-run the setup wizard</span>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onResetOnboarding}>
            <ArrowCounterClockwise size={10} />
            Re-run
          </Button>
        </div>
      )}
    </div>
  );
}
