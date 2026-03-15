import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getModelById, resolveModelDescriptor } from "../../../shared/modelRegistry";
import type { CtoIdentity, CtoPersonalityPreset } from "../../../shared/types";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { cardCls, inputCls, labelCls, recessedPanelCls, selectCls, textareaCls } from "./shared/designTokens";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";

const CTO_DISPLAY_NAME = "CTO";

type IdentityDraft = {
  persona: string;
  personality: CtoPersonalityPreset;
  verbosity: string;
  proactivity: string;
  escalationThreshold: string;
  constraints: string;
  provider: string;
  model: string;
  modelId: string | null;
  reasoningEffort: string | null;
};

function pickReasoningEffort(modelId: string | null | undefined, preferred: string | null | undefined): string | null {
  const tiers = modelId ? (getModelById(modelId)?.reasoningTiers ?? []) : [];
  if (!tiers.length) return preferred ?? null;
  if (preferred && tiers.includes(preferred)) return preferred;
  return tiers.includes("medium") ? "medium" : tiers[0] ?? null;
}

function applyModelSelection(draft: IdentityDraft, modelId: string): IdentityDraft {
  const descriptor = getModelById(modelId);
  if (!descriptor) return draft;
  return {
    ...draft,
    provider: descriptor.family,
    model: descriptor.shortId ?? descriptor.id.split("/").pop() ?? descriptor.id,
    modelId: descriptor.id,
    reasoningEffort: pickReasoningEffort(descriptor.id, draft.reasoningEffort),
  };
}

function coerceConfiguredModel(draft: IdentityDraft, configuredModelIds: string[]): IdentityDraft {
  if (configuredModelIds.length === 0) {
    return draft.modelId ? applyModelSelection(draft, draft.modelId) : draft;
  }
  if (draft.modelId && configuredModelIds.includes(draft.modelId)) {
    return applyModelSelection(draft, draft.modelId);
  }
  return applyModelSelection(draft, configuredModelIds[0]!);
}

function draftFromIdentity(identity: CtoIdentity | null): IdentityDraft {
  const resolvedModel = resolveModelDescriptor(
    identity?.modelPreferences.modelId
    ?? identity?.modelPreferences.model
    ?? "",
  );
  const base: IdentityDraft = {
    persona: identity?.persona ?? getCtoPersonalityPreset(identity?.personality ?? "strategic").persona,
    personality: identity?.personality ?? "strategic",
    verbosity: identity?.communicationStyle?.verbosity ?? "adaptive",
    proactivity: identity?.communicationStyle?.proactivity ?? "balanced",
    escalationThreshold: identity?.communicationStyle?.escalationThreshold ?? "medium",
    constraints: (identity?.constraints ?? []).join(", "),
    provider: identity?.modelPreferences.provider ?? "claude",
    model: identity?.modelPreferences.model ?? "sonnet",
    modelId: identity?.modelPreferences.modelId ?? null,
    reasoningEffort: identity?.modelPreferences.reasoningEffort ?? "medium",
  };
  return resolvedModel ? applyModelSelection(base, resolvedModel.id) : base;
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
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromIdentity(identity));
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await window.ade.ai.getStatus();
        if (cancelled) return;
        const configured = deriveConfiguredModelIds(status);
        setAvailableModelIds(configured);
        setDraft((current) => coerceConfiguredModel(current, configured));
      } catch {
        if (!cancelled) {
          setAvailableModelIds([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedModelDescriptor = useMemo(
    () => (draft.modelId ? getModelById(draft.modelId) : null),
    [draft.modelId],
  );
  const selectedPreset = getCtoPersonalityPreset(draft.personality);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      if (!draft.modelId || !availableModelIds.includes(draft.modelId)) {
        throw new Error("Choose one of your configured models for the CTO.");
      }
      await onSave({
        name: CTO_DISPLAY_NAME,
        persona: draft.persona.trim(),
        personality: draft.personality,
        ...(draft.personality === "custom" ? { customPersonality: draft.persona.trim() } : {}),
        communicationStyle: {
          verbosity: draft.verbosity,
          proactivity: draft.proactivity,
          escalationThreshold: draft.escalationThreshold,
        },
        constraints: draft.constraints.split(",").map((value) => value.trim()).filter(Boolean),
        modelPreferences: {
          provider: draft.provider,
          model: draft.model,
          modelId: draft.modelId,
          reasoningEffort: draft.reasoningEffort ?? null,
        },
      });
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [availableModelIds, draft, onCancel, onSave]);

  return (
    <div className="space-y-3">
      <div className={cn(cardCls, "space-y-4")}>
        <div>
          <div className="font-sans text-sm font-semibold text-fg">CTO identity</div>
          <div className="mt-1 text-xs leading-5 text-muted-fg/45">
            This updates the hidden CTO identity that ADE carries across chats and compaction. The prompt itself stays internal.
          </div>
        </div>

        <div className="space-y-2">
          <div className={labelCls}>Model</div>
          <UnifiedModelSelector
            value={draft.modelId ?? ""}
            availableModelIds={availableModelIds}
            showReasoning
            reasoningEffort={draft.reasoningEffort}
            onReasoningEffortChange={(effort) => setDraft((current) => ({
              ...current,
              reasoningEffort: effort,
            }))}
            onChange={(modelId) => {
              setDraft((current) => applyModelSelection(current, modelId));
              setError(null);
            }}
          />
          {loadingModels ? (
            <div className="text-[11px] text-muted-fg/40">Checking configured models...</div>
          ) : availableModelIds.length === 0 ? (
            <div className="rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
              No configured models detected yet. Add one in ADE settings before saving.
            </div>
          ) : (
            <div className="text-[11px] text-muted-fg/40">You can change the model and thinking level any time from the CTO chat.</div>
          )}
        </div>

        <div>
          <div className="font-sans text-sm font-semibold text-fg">Working style</div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {CTO_PERSONALITY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setDraft((current) => ({
                  ...current,
                  personality: preset.id,
                  persona: preset.id === "custom" ? current.persona : preset.persona,
                  verbosity: preset.communicationStyle?.verbosity ?? current.verbosity,
                  proactivity: preset.communicationStyle?.proactivity ?? current.proactivity,
                  escalationThreshold: preset.communicationStyle?.escalationThreshold ?? current.escalationThreshold,
                }))}
                className={cn(
                  "rounded-2xl border px-3 py-3 text-left transition-all duration-200",
                  draft.personality === preset.id
                    ? "border-[rgba(56,189,248,0.28)] bg-[rgba(56,189,248,0.08)]"
                    : "border-white/[0.06] bg-[rgba(24,20,35,0.4)] hover:border-[rgba(56,189,248,0.16)]",
                )}
              >
                <div className="text-xs font-medium text-fg">{preset.label}</div>
                <div className="mt-1 text-[11px] leading-5 text-muted-fg/45">{preset.description}</div>
              </button>
            ))}
          </div>
        </div>

        <label className="space-y-1 block">
          <div className={labelCls}>Operating brief</div>
          <textarea
            className={cn(textareaCls, "min-h-[120px]")}
            rows={5}
            value={draft.persona}
            placeholder="Describe how this CTO should lead, communicate, and make tradeoffs."
            onChange={(event) => setDraft((current) => ({ ...current, persona: event.target.value }))}
          />
        </label>
      </div>

      <div className={cn(recessedPanelCls, "space-y-3 p-4")}>
        <div className="font-sans text-sm font-semibold text-fg">Communication tuning</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="space-y-1">
            <div className={labelCls}>Verbosity</div>
            <select className={selectCls} value={draft.verbosity} onChange={(event) => setDraft((current) => ({ ...current, verbosity: event.target.value }))}>
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
              <option value="adaptive">Adaptive</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Proactivity</div>
            <select className={selectCls} value={draft.proactivity} onChange={(event) => setDraft((current) => ({ ...current, proactivity: event.target.value }))}>
              <option value="reactive">Reactive</option>
              <option value="balanced">Balanced</option>
              <option value="proactive">Proactive</option>
            </select>
          </label>
          <label className="space-y-1">
            <div className={labelCls}>Escalation</div>
            <select className={selectCls} value={draft.escalationThreshold} onChange={(event) => setDraft((current) => ({ ...current, escalationThreshold: event.target.value }))}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>

        <label className="space-y-1 block">
          <div className={labelCls}>Constraints</div>
          <input
            className={inputCls}
            placeholder="never deploy without tests, always keep project memory updated"
            value={draft.constraints}
            onChange={(event) => setDraft((current) => ({ ...current, constraints: event.target.value }))}
          />
        </label>
      </div>

      <div className={cn(recessedPanelCls, "space-y-2 p-4")}>
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Current summary</div>
        <div className="grid gap-2 md:grid-cols-3">
          {[
            { label: "Role", value: CTO_DISPLAY_NAME },
            { label: "Model", value: selectedModelDescriptor?.displayName ?? "No model selected" },
            { label: "Style", value: selectedPreset.label },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <div className="text-[10px] text-muted-fg/40">{item.label}</div>
              <div className="mt-0.5 text-[11px] leading-5 text-fg/70">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="text-xs text-error">{error}</div>}

      <div className="flex gap-2 pt-1">
        <Button variant="primary" className="flex-1" disabled={saving} onClick={() => void handleSave()}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
