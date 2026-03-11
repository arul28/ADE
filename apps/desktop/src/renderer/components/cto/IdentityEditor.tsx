import React, { useCallback, useEffect, useState } from "react";
import { Eye } from "@phosphor-icons/react";
import type { CtoIdentity, CtoSystemPromptPreview } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { inputCls, labelCls, selectCls, textareaCls, cardCls } from "./shared/designTokens";
import { PaneHeader } from "../ui/PaneHeader";

type IdentityDraft = {
  name: string;
  persona: string;
  personality: string;
  customPersonality: string;
  verbosity: string;
  proactivity: string;
  escalationThreshold: string;
  constraints: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  systemPromptExtension: string;
};

function draftFromIdentity(identity: CtoIdentity | null): IdentityDraft {
  return {
    name: identity?.name ?? "CTO",
    persona: identity?.persona ?? "",
    personality: identity?.personality ?? "professional",
    customPersonality: identity?.customPersonality ?? "",
    verbosity: identity?.communicationStyle?.verbosity ?? "adaptive",
    proactivity: identity?.communicationStyle?.proactivity ?? "balanced",
    escalationThreshold: identity?.communicationStyle?.escalationThreshold ?? "medium",
    constraints: (identity?.constraints ?? []).join(", "),
    provider: identity?.modelPreferences.provider ?? "",
    model: identity?.modelPreferences.model ?? "",
    reasoningEffort: identity?.modelPreferences.reasoningEffort ?? "",
    systemPromptExtension: identity?.systemPromptExtension ?? "",
  };
}

export function IdentityEditor({
  identity,
  onSave,
  onCancel,
}: {
  identity: CtoIdentity | null;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<IdentityDraft>(draftFromIdentity(identity));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CtoSystemPromptPreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    setDraft(draftFromIdentity(identity));
  }, [identity]);

  const loadPreview = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const result = await window.ade.cto.previewSystemPrompt({
        identityOverride: {
          name: draft.name,
          persona: draft.persona,
          personality: draft.personality,
          customPersonality: draft.customPersonality,
          communicationStyle: {
            verbosity: draft.verbosity,
            proactivity: draft.proactivity,
            escalationThreshold: draft.escalationThreshold,
          },
          constraints: draft.constraints.split(",").map((s) => s.trim()).filter(Boolean),
          systemPromptExtension: draft.systemPromptExtension,
        },
      });
      setPreview(result);
    } catch { /* non-fatal */ }
  }, [draft]);

  useEffect(() => {
    if (!showPreview) return;
    const timeout = setTimeout(() => void loadPreview(), 300);
    return () => clearTimeout(timeout);
  }, [showPreview, loadPreview]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: draft.name,
        persona: draft.persona,
        personality: draft.personality,
        customPersonality: draft.customPersonality,
        communicationStyle: {
          verbosity: draft.verbosity,
          proactivity: draft.proactivity,
          escalationThreshold: draft.escalationThreshold,
        },
        constraints: draft.constraints.split(",").map((s) => s.trim()).filter(Boolean),
        systemPromptExtension: draft.systemPromptExtension,
        modelPreferences: {
          provider: draft.provider,
          model: draft.model,
          reasoningEffort: draft.reasoningEffort || null,
        },
      });
      onCancel(); // close editor
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* Form */}
      <div className="flex-1 overflow-y-auto space-y-3 min-w-0">
        <label className="space-y-1 block">
          <div className={labelCls}>Name</div>
          <input className={inputCls} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        </label>

        <label className="space-y-1 block">
          <div className={labelCls}>Persona</div>
          <textarea className={cn(textareaCls, "min-h-[60px]")} rows={3} value={draft.persona} onChange={(e) => setDraft((d) => ({ ...d, persona: e.target.value }))} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <div className={labelCls}>Personality</div>
            <select className={selectCls} value={draft.personality} onChange={(e) => setDraft((d) => ({ ...d, personality: e.target.value }))}>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="minimal">Minimal</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {draft.personality === "custom" && (
            <label className="space-y-1">
              <div className={labelCls}>Custom Personality</div>
              <input className={inputCls} placeholder="Describe personality..." value={draft.customPersonality} onChange={(e) => setDraft((d) => ({ ...d, customPersonality: e.target.value }))} />
            </label>
          )}
        </div>

        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-muted-fg/40 mt-4 mb-1">
          Communication Style
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <div className={labelCls}>Verbosity</div>
            <select className={selectCls} value={draft.verbosity} onChange={(e) => setDraft((d) => ({ ...d, verbosity: e.target.value }))}>
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
              <option value="adaptive">Adaptive</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Proactivity</div>
            <select className={selectCls} value={draft.proactivity} onChange={(e) => setDraft((d) => ({ ...d, proactivity: e.target.value }))}>
              <option value="reactive">Reactive</option>
              <option value="balanced">Balanced</option>
              <option value="proactive">Proactive</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Escalation</div>
            <select className={selectCls} value={draft.escalationThreshold} onChange={(e) => setDraft((d) => ({ ...d, escalationThreshold: e.target.value }))}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>

        <label className="space-y-1 block">
          <div className={labelCls}>Constraints</div>
          <input className={inputCls} placeholder="never deploy without tests, always use TypeScript (comma-separated)" value={draft.constraints} onChange={(e) => setDraft((d) => ({ ...d, constraints: e.target.value }))} />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <div className={labelCls}>Provider</div>
            <input className={inputCls} value={draft.provider} onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))} />
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Model</div>
            <input className={inputCls} value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} />
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Reasoning</div>
            <input className={inputCls} placeholder="high/medium/low" value={draft.reasoningEffort} onChange={(e) => setDraft((d) => ({ ...d, reasoningEffort: e.target.value }))} />
          </label>
        </div>

        <label className="space-y-1 block">
          <div className={labelCls}>System Prompt Extension</div>
          <textarea className={cn(textareaCls, "min-h-[40px]")} rows={2} placeholder="Additional instructions appended to base prompt..." value={draft.systemPromptExtension} onChange={(e) => setDraft((d) => ({ ...d, systemPromptExtension: e.target.value }))} />
        </label>

        {error && <div className="text-xs text-error">{error}</div>}

        <div className="flex gap-2 pt-1">
          <Button variant="primary" className="flex-1" disabled={saving} onClick={handleSave}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={() => setShowPreview(!showPreview)}>
            <Eye size={10} />
            Preview
          </Button>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>

      {/* Prompt Preview Panel */}
      {showPreview && (
        <div className="w-72 shrink-0 border-l border-border/20 overflow-y-auto">
          <div className="p-3">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-muted-fg/40 mb-2">
              System Prompt Preview
            </div>
            {preview ? (
              <>
                <pre className="font-mono text-[10px] text-fg/70 leading-relaxed whitespace-pre-wrap break-words bg-surface-recessed border border-border/10 p-3 max-h-96 overflow-y-auto">
                  {preview.prompt}
                </pre>
                <div className="font-mono text-[8px] text-muted-fg/30 mt-2">
                  ~{preview.tokenEstimate} tokens
                </div>
              </>
            ) : (
              <div className="font-mono text-[10px] text-muted-fg/40">Loading preview...</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
