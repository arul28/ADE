import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle } from "@phosphor-icons/react";
import type { CtoPersonalityPreset } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { cardCls, labelCls, recessedPanelCls, textareaCls } from "./shared/designTokens";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";
import { CtoPromptPreview } from "./CtoPromptPreview";

const CTO_DISPLAY_NAME = "CTO";

type PersonalityDraft = {
  customPersonality: string;
  personality: CtoPersonalityPreset;
};

export function OnboardingWizard({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [draft, setDraft] = useState<PersonalityDraft>({
    customPersonality: "",
    personality: "strategic",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.ade?.cto;
    if (!bridge) return;

    let cancelled = false;
    void bridge.getState({ recentLimit: 0 })
      .then((snapshot) => {
        if (cancelled || !snapshot.identity) return;
        setDraft({
          customPersonality: snapshot.identity.customPersonality
            ?? (snapshot.identity.personality === "custom" ? snapshot.identity.persona ?? "" : ""),
          personality: snapshot.identity.personality ?? "strategic",
        });
      })
      .catch(() => {
        // Non-fatal. The user can still pick a personality without the initial snapshot.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleFinish = useCallback(async () => {
    const bridge = window.ade?.cto;
    if (!bridge) {
      setError("CTO bridge is unavailable.");
      return;
    }
    if (draft.personality === "custom" && !draft.customPersonality.trim()) {
      setError("Add custom personality guidance or choose one of the built-in presets.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const preset = getCtoPersonalityPreset(draft.personality);
      await bridge.updateIdentity({
        patch: {
          name: CTO_DISPLAY_NAME,
          persona: draft.personality === "custom"
            ? draft.customPersonality.trim()
            : `Persistent project CTO with ${preset.label.toLowerCase()} personality.`,
          personality: draft.personality,
          ...(draft.personality === "custom"
            ? { customPersonality: draft.customPersonality.trim() }
            : { customPersonality: undefined }),
        },
      });
      await bridge.completeOnboardingStep({ stepId: "identity" });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save CTO personality.");
    } finally {
      setSaving(false);
    }
  }, [draft, onComplete]);

  const selectedPreset = getCtoPersonalityPreset(draft.personality);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "radial-gradient(circle at top left, rgba(56,189,248,0.12), transparent 24%), rgba(0, 0, 0, 0.72)",
        backdropFilter: "blur(14px)",
      }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-[28px] border shadow-float"
        style={{
          background: "linear-gradient(180deg, #0A1016 0%, #080C12 100%)",
          borderColor: "rgba(255, 255, 255, 0.08)",
        }}
      >
        <div
          className="border-b px-6 py-5"
          style={{
            borderColor: "rgba(255, 255, 255, 0.06)",
            background: "linear-gradient(180deg, rgba(12,17,25,0.96), rgba(8,12,18,0.9))",
          }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-fg/38">CTO setup</div>
          <div className="mt-2 text-[1.35rem] font-semibold tracking-[-0.03em] text-fg">Set the CTO personality</div>
          <div className="mt-2 max-w-[44rem] text-[13px] leading-6 text-muted-fg/48">
            Pick how the persistent CTO should sound. ADE handles project discovery, memory layers, and compaction recovery automatically.
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className={cn(cardCls, "space-y-4 p-4")}>
                <div>
                  <div className="font-sans text-base font-semibold text-fg">Choose a style</div>
                  <div className="mt-1 text-xs leading-5 text-muted-fg/45">
                    You can change this later in CTO settings. The personality overlay affects tone and decision style, not memory or ADE permissions.
                  </div>
                </div>

                <div className="grid gap-2 md:grid-cols-2">
                  {CTO_PERSONALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setDraft((current) => ({ ...current, personality: preset.id }));
                        setError(null);
                      }}
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

                {draft.personality === "custom" ? (
                  <label className="block space-y-1">
                    <div className={labelCls}>Custom personality overlay</div>
                    <textarea
                      className={cn(textareaCls, "min-h-[140px]")}
                      rows={6}
                      placeholder="Describe the CTO's tone, standards, and decision style."
                      value={draft.customPersonality}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, customPersonality: event.target.value }));
                        setError(null);
                      }}
                    />
                    <div className="text-[11px] leading-5 text-muted-fg/40">
                      Custom text only changes the personality overlay. ADE still controls doctrine, memory behavior, and recovery across compaction.
                    </div>
                  </label>
                ) : null}

                {error ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
                    {error}
                  </div>
                ) : null}
              </div>

              <div className={cn(recessedPanelCls, "space-y-3 p-4")}>
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">ADE handles the rest</div>
                <div className="space-y-2">
                  {[
                    "Repo and runtime context are discovered as needed instead of being manually stuffed into setup.",
                    "The CTO writes memory through ADE tools: memorySearch before work, memoryUpdateCore for standing brief changes, and memoryAdd for durable lessons.",
                    "The same persistent CTO identity survives chat compaction because ADE rehydrates doctrine, memory, and current context automatically.",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2 text-[11px] leading-5 text-fg/66">
                      <CheckCircle size={11} weight="fill" style={{ color: "#34D399", marginTop: 2 }} />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className={cn(recessedPanelCls, "p-4")}>
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Current choice</div>
                <div className="mt-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-3">
                  <div className="text-[10px] text-muted-fg/42">Personality</div>
                  <div className="mt-1 text-sm font-medium text-fg">{selectedPreset.label}</div>
                  <div className="mt-1 text-[11px] leading-5 text-muted-fg/45">{selectedPreset.description}</div>
                </div>
              </div>

              <CtoPromptPreview
                compact
                title="Prompt preview"
                subtitle="Only the personality overlay changes here. ADE still injects doctrine, memory rules, current context, and capabilities."
                identityOverride={{
                  name: CTO_DISPLAY_NAME,
                  personality: draft.personality,
                  customPersonality: draft.personality === "custom" ? draft.customPersonality : undefined,
                  persona: draft.personality === "custom" ? draft.customPersonality : undefined,
                }}
              />
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 border-t px-5 py-4"
          style={{
            borderColor: "rgba(255, 255, 255, 0.06)",
            background: "linear-gradient(180deg, rgba(10, 14, 21, 0.9), rgba(8, 11, 17, 0.96))",
          }}
        >
          <div className="text-[11px] text-muted-fg/38">
            Personality only. Project context and memory are managed inside ADE.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onSkip} disabled={saving}>
              Not now
            </Button>
            <Button variant="primary" onClick={() => void handleFinish()} disabled={saving}>
              {saving ? "Saving..." : "Finish setup"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
