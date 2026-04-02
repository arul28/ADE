import React, { useCallback, useEffect, useState } from "react";
import { Briefcase, Handshake, Lightning, Sparkle, Strategy, Wrench } from "@phosphor-icons/react";
import type { CtoPersonalityPreset } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { labelCls, textareaCls } from "./shared/designTokens";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";

const CTO_DISPLAY_NAME = "CTO";

const PERSONALITY_THEME: Record<
  CtoPersonalityPreset,
  { rgb: string; hex: string; icon: React.ElementType }
> = {
  strategic: { rgb: "96, 165, 250", hex: "#60A5FA", icon: Strategy },
  professional: { rgb: "167, 139, 250", hex: "#A78BFA", icon: Briefcase },
  hands_on: { rgb: "52, 211, 153", hex: "#34D399", icon: Wrench },
  casual: { rgb: "251, 191, 36", hex: "#FBBF24", icon: Handshake },
  minimal: { rgb: "34, 211, 238", hex: "#22D3EE", icon: Lightning },
  custom: { rgb: "244, 114, 182", hex: "#F472B6", icon: Sparkle },
};

const HINTS = [
  "Memory layers active",
  "Context discovered automatically",
  "Recovery across compaction",
  "Doctrine stays immutable",
];

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
  const [hintIndex, setHintIndex] = useState(0);

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

  useEffect(() => {
    const id = setInterval(() => {
      setHintIndex((prev) => (prev + 1) % HINTS.length);
    }, 2500);
    return () => clearInterval(id);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "radial-gradient(circle at top left, rgba(56,189,248,0.12), transparent 24%), rgba(0, 0, 0, 0.72)",
        backdropFilter: "blur(14px)",
      }}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] border shadow-float"
        style={{
          background: "linear-gradient(180deg, #0A1016 0%, #080C12 100%)",
          borderColor: "rgba(255, 255, 255, 0.08)",
        }}
      >
        {/* Header */}
        <div
          className="border-b px-6 py-5"
          style={{
            borderColor: "rgba(255, 255, 255, 0.06)",
            background: "linear-gradient(180deg, rgba(12,17,25,0.96), rgba(8,12,18,0.9))",
          }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-fg/38">CTO setup</div>
          <div className="mt-2 text-[1.35rem] font-semibold tracking-[-0.03em] text-fg">Choose a personality</div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {CTO_PERSONALITY_PRESETS.map((preset) => {
              const theme = PERSONALITY_THEME[preset.id];
              const isSelected = draft.personality === preset.id;
              const Icon = theme.icon;

              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setDraft((current) => ({ ...current, personality: preset.id }));
                    setError(null);
                  }}
                  className="rounded-2xl px-4 py-4 text-left transition-all duration-200"
                  style={isSelected
                    ? {
                        background: `linear-gradient(180deg, rgba(${theme.rgb}, 0.14) 0%, rgba(${theme.rgb}, 0.06) 100%)`,
                        border: `1px solid rgba(${theme.rgb}, 0.35)`,
                        backdropFilter: "blur(20px)",
                        boxShadow: `0 0 20px rgba(${theme.rgb}, 0.15), inset 0 1px 0 rgba(255,255,255,0.06)`,
                      }
                    : {
                        background: `linear-gradient(180deg, rgba(${theme.rgb}, 0.06) 0%, rgba(${theme.rgb}, 0.02) 100%)`,
                        border: "1px solid rgba(255, 255, 255, 0.06)",
                        backdropFilter: "blur(20px)",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                      }
                  }
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                      style={{
                        background: `rgba(${theme.rgb}, ${isSelected ? 0.18 : 0.12})`,
                        border: `1px solid rgba(${theme.rgb}, ${isSelected ? 0.3 : 0.20})`,
                      }}
                    >
                      <Icon size={16} weight="duotone" style={{ color: theme.hex }} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-fg">{preset.label}</div>
                      <div className="mt-0.5 text-[11px] leading-4 text-muted-fg/50">{preset.description}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {draft.personality === "custom" ? (
            <div className="mt-4">
              <label className="block space-y-1">
                <div className={labelCls}>Custom personality overlay</div>
                <textarea
                  className={cn(textareaCls, "min-h-[120px]")}
                  rows={5}
                  placeholder="Describe the CTO's tone, standards, and decision style."
                  value={draft.customPersonality}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, customPersonality: event.target.value }));
                    setError(null);
                  }}
                />
              </label>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
              {error}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 border-t px-5 py-3.5"
          style={{
            borderColor: "rgba(255, 255, 255, 0.06)",
            background: "linear-gradient(180deg, rgba(10, 14, 21, 0.9), rgba(8, 11, 17, 0.96))",
          }}
        >
          <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
            {HINTS.map((hint, i) => (
              <span
                key={hint}
                className={cn(
                  "absolute inset-0 text-[11px] text-muted-fg/40 transition-all duration-500",
                  i === hintIndex ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
                )}
              >
                {hint}
              </span>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
