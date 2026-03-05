import React, { useCallback, useEffect, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import type { CtoCoreMemory, CtoIdentity, CtoSessionLogEntry } from "../../../shared/types";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";

/* ── Helpers ── */

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function splitTrimmed(val: string): string[] {
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

const inputCls =
  "h-8 w-full border border-border/15 bg-surface-recessed px-3 text-xs font-mono text-fg placeholder:text-muted-fg/50 focus:border-accent/40 focus:outline-none transition-colors";
const textareaCls =
  "w-full border border-border/15 bg-surface-recessed p-3 text-xs font-mono text-fg placeholder:text-muted-fg/50 focus:border-accent/40 focus:outline-none resize-vertical transition-colors";
const labelCls = "text-[10px] font-mono font-bold uppercase tracking-[1px] text-muted-fg/60";

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
}: {
  identity: CtoIdentity | null;
  coreMemory: CtoCoreMemory | null;
  sessionLogs: CtoSessionLogEntry[];
  onSaveIdentity: (draft: { name: string; persona: string; provider: string; model: string; reasoningEffort: string }) => Promise<void>;
  onSaveCoreMemory: (patch: CoreMemoryPatch) => Promise<void>;
}) {
  /* Identity editor */
  const [identityEditing, setIdentityEditing] = useState(false);
  const [identityDraft, setIdentityDraft] = useState({ name: "", persona: "", provider: "", model: "", reasoningEffort: "" });
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  useEffect(() => {
    if (!identityEditing && identity) {
      setIdentityDraft({
        name: identity.name,
        persona: identity.persona,
        provider: identity.modelPreferences.provider,
        model: identity.modelPreferences.model,
        reasoningEffort: identity.modelPreferences.reasoningEffort ?? "",
      });
    }
  }, [identity, identityEditing]);

  const handleSaveIdentity = async () => {
    setIdentitySaving(true); setIdentityError(null);
    try { await onSaveIdentity(identityDraft); setIdentityEditing(false); }
    catch (err) { setIdentityError(err instanceof Error ? err.message : "Failed."); }
    finally { setIdentitySaving(false); }
  };

  /* Memory editor */
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState({ projectSummary: "", criticalConventions: "", userPreferences: "", activeFocus: "", notes: "" });
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 gap-4">
      {/* CTO Identity */}
      <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card">
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
          <div className="p-4 space-y-3">
            <label className="space-y-1 block">
              <div className={labelCls}>Name</div>
              <input className={inputCls} value={identityDraft.name} onChange={(e) => setIdentityDraft((d) => ({ ...d, name: e.target.value }))} />
            </label>
            <label className="space-y-1 block">
              <div className={labelCls}>Persona</div>
              <textarea className={cn(textareaCls, "min-h-[60px]")} value={identityDraft.persona} onChange={(e) => setIdentityDraft((d) => ({ ...d, persona: e.target.value }))} />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <div className={labelCls}>Provider</div>
                <input className={inputCls} value={identityDraft.provider} onChange={(e) => setIdentityDraft((d) => ({ ...d, provider: e.target.value }))} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Model</div>
                <input className={inputCls} value={identityDraft.model} onChange={(e) => setIdentityDraft((d) => ({ ...d, model: e.target.value }))} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Reasoning</div>
                <input className={inputCls} placeholder="high/medium/low" value={identityDraft.reasoningEffort} onChange={(e) => setIdentityDraft((d) => ({ ...d, reasoningEffort: e.target.value }))} />
              </label>
            </div>
            {identityError && <div className="text-xs text-error">{identityError}</div>}
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={identitySaving} onClick={handleSaveIdentity}>
                {identitySaving ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" className="flex-1" disabled={identitySaving} onClick={() => setIdentityEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : identity ? (
          <div className="p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-bold text-fg">{identity.name}</span>
              <span className="font-mono text-[10px] text-muted-fg/50">v{identity.version}</span>
            </div>
            <div className="font-mono text-[10px] text-muted-fg leading-relaxed">{identity.persona}</div>
            <div className="flex gap-3 mt-1">
              <span className="font-mono text-[9px] text-muted-fg/40">Provider: <span className="text-muted-fg">{identity.modelPreferences.provider}</span></span>
              <span className="font-mono text-[9px] text-muted-fg/40">Model: <span className="text-muted-fg">{identity.modelPreferences.model}</span></span>
              {identity.modelPreferences.reasoningEffort && (
                <span className="font-mono text-[9px] text-muted-fg/40">Reasoning: <span className="text-muted-fg">{identity.modelPreferences.reasoningEffort}</span></span>
              )}
            </div>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-fg/50">Loading identity...</div>
        )}
      </div>

      {/* Core Memory */}
      <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card">
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
      <div className="border border-border/10 bg-card/60 backdrop-blur-sm shadow-card">
        <PaneHeader title="Recent Sessions" meta={`${sessionLogs.length}`} />
        <div className="p-3 max-h-64 overflow-y-auto space-y-1.5" data-testid="session-history-list">
          {sessionLogs.length === 0 ? (
            <div className="text-[10px] text-muted-fg/50 py-2">No sessions recorded yet.</div>
          ) : sessionLogs.map((s) => (
            <div key={s.id} className="bg-surface-recessed px-3 py-2">
              <div className="font-mono text-[9px] text-muted-fg/40">{formatDate(s.createdAt)}</div>
              <div className="font-mono text-[10px] text-muted-fg mt-0.5 line-clamp-2">{s.summary}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
