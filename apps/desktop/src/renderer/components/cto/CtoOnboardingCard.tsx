import React, { useCallback, useEffect, useState } from "react";
import type { CtoCommunicationStyle, CtoPersonalityPreset } from "../../../shared/types";
import { cn } from "../ui/cn";
import { textareaCls } from "./shared/designTokens";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";
import {
  DEFAULT_COMMUNICATION_STYLE,
  getPersonalityTheme,
  WORK_STYLE_ROWS,
} from "./personalityTheme";
import { Segmented } from "./Segmented";
import { useAsyncAction } from "../../hooks/useAsyncAction";

const CTO_UNAVAILABLE = "The CTO isn't available right now. Try reopening ADE.";

const CTO_DISPLAY_NAME = "CTO";

type Draft = {
  name: string;
  personality: CtoPersonalityPreset;
  customPersonality: string;
  communicationStyle: CtoCommunicationStyle;
};

/**
 * First-run setup: one card over the thread. Pick a personality, tune three
 * work-style rows (sensible defaults preselected), optionally name the CTO, and
 * start. No multi-step wizard.
 */
export function CtoOnboardingCard({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: "",
    personality: "strategic",
    customPersonality: "",
    communicationStyle: DEFAULT_COMMUNICATION_STYLE,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.ade?.cto;
    if (!bridge) return;
    let cancelled = false;
    void bridge.getState({ recentLimit: 0 })
      .then((snapshot) => {
        if (cancelled || !snapshot.identity) return;
        const identity = snapshot.identity;
        setDraft((current) => ({
          ...current,
          name: identity.name && identity.name !== CTO_DISPLAY_NAME ? identity.name : "",
          personality: identity.personality ?? "strategic",
          customPersonality:
            identity.customPersonality
            ?? (identity.personality === "custom" ? identity.persona ?? "" : ""),
          communicationStyle: { ...current.communicationStyle, ...(identity.communicationStyle ?? {}) },
        }));
      })
      .catch(() => {
        /* non-fatal — the user can still choose without a prefilled snapshot */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTheme = getPersonalityTheme(draft.personality);

  const { run: saveIdentity, pending: saving } = useAsyncAction({
    action: async () => {
      // `handleStart` already gated on this; the throw only narrows the type.
      const bridge = window.ade?.cto;
      if (!bridge) throw new Error(CTO_UNAVAILABLE);
      const preset = getCtoPersonalityPreset(draft.personality);
      await bridge.updateIdentity({
        patch: {
          name: draft.name.trim() || CTO_DISPLAY_NAME,
          persona: draft.personality === "custom"
            ? draft.customPersonality.trim()
            : `Persistent project CTO with ${preset.label.toLowerCase()} personality.`,
          personality: draft.personality,
          communicationStyle: draft.communicationStyle,
          ...(draft.personality === "custom"
            ? { customPersonality: draft.customPersonality.trim() }
            : { customPersonality: undefined }),
        },
      });
      await bridge.completeOnboardingStep({ stepId: "identity" });
      onComplete();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't save your setup. Try again.");
    },
  });

  const handleStart = useCallback(() => {
    setError(null);
    if (!window.ade?.cto) {
      setError(CTO_UNAVAILABLE);
      return;
    }
    if (draft.personality === "custom" && !draft.customPersonality.trim()) {
      setError("Describe the custom personality, or pick one of the presets.");
      return;
    }
    saveIdentity();
  }, [draft.personality, draft.customPersonality, saveIdentity]);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div
        className="w-full max-w-[560px] rounded-[22px] border border-white/[0.08] p-6 shadow-float"
        style={{
          background:
            `radial-gradient(120% 80% at 0% 0%, rgba(${activeTheme.rgb}, 0.10), transparent 55%),`
            + " linear-gradient(180deg, rgba(20,19,28,0.92), rgba(13,12,18,0.96))",
        }}
      >
        {/* Intro */}
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: `rgba(${activeTheme.rgb}, 0.14)`,
              border: `1px solid rgba(${activeTheme.rgb}, 0.28)`,
            }}
          >
            <activeTheme.icon size={18} weight="duotone" style={{ color: activeTheme.hex }} />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-fg">Set up your CTO</div>
            <div className="mt-1 text-[12.5px] leading-5 text-muted-fg/55">
              A persistent technical lead for this project. It remembers decisions across
              models and compactions. Pick how it should work — you can change any of this later.
            </div>
          </div>
        </div>

        {/* Personality */}
        <div className="mt-6">
          <div className="text-[12px] font-medium text-muted-fg/70">Personality</div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CTO_PERSONALITY_PRESETS.map((preset) => {
              const theme = getPersonalityTheme(preset.id);
              const selected = draft.personality === preset.id;
              const Icon = theme.icon;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setDraft((current) => ({ ...current, personality: preset.id }));
                    setError(null);
                  }}
                  title={preset.description}
                  className={cn(
                    "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150",
                    selected
                      ? "border-transparent"
                      : "border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.03]",
                  )}
                  style={selected
                    ? {
                        background: `rgba(${theme.rgb}, 0.12)`,
                        boxShadow: `inset 0 0 0 1px rgba(${theme.rgb}, 0.34)`,
                      }
                    : undefined}
                >
                  <Icon
                    size={15}
                    weight={selected ? "duotone" : "regular"}
                    style={{ color: selected ? theme.hex : undefined }}
                    className={selected ? undefined : "text-muted-fg/50"}
                  />
                  <span className={cn("text-[12.5px] font-medium", selected ? "text-fg" : "text-muted-fg/70")}>
                    {preset.label}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-[11.5px] leading-4 text-muted-fg/45">
            {getCtoPersonalityPreset(draft.personality).description}
          </div>
        </div>

        {draft.personality === "custom" && (
          <textarea
            className={cn(textareaCls, "mt-3 min-h-[84px]")}
            rows={3}
            placeholder="Describe the CTO's tone, standards, and decision style."
            value={draft.customPersonality}
            onChange={(event) => {
              const next = event.target.value;
              setDraft((current) => ({ ...current, customPersonality: next }));
              setError(null);
            }}
          />
        )}

        {/* Work style */}
        <div className="mt-6 space-y-3">
          <div className="text-[12px] font-medium text-muted-fg/70">Work style</div>
          {WORK_STYLE_ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-fg/85">{row.label}</div>
                <div className="text-[11px] leading-4 text-muted-fg/45">{row.hint}</div>
              </div>
              <Segmented
                ariaLabel={row.label}
                options={row.options}
                value={draft.communicationStyle[row.key]}
                accentRgb={activeTheme.rgb}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    communicationStyle: { ...current.communicationStyle, [row.key]: value },
                  }))
                }
              />
            </div>
          ))}
        </div>

        {/* Name */}
        <div className="mt-6">
          <label className="block text-[12px] font-medium text-muted-fg/70" htmlFor="cto-name">
            Name <span className="font-normal text-muted-fg/40">— optional</span>
          </label>
          <input
            id="cto-name"
            type="text"
            value={draft.name}
            placeholder="CTO"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            className="mt-1.5 h-9 w-full rounded-lg border border-white/[0.08] bg-black/25 px-3 text-[13px] text-fg placeholder:text-muted-fg/35 focus:border-white/20 focus:outline-none"
          />
        </div>

        {error && <div className="mt-4 text-[12px] text-error">{error}</div>}

        {/* Actions */}
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={handleStart}
            className="h-9 flex-1 rounded-lg text-[13px] font-semibold text-[#0A0A0F] transition-opacity disabled:opacity-60"
            style={{ background: activeTheme.hex }}
          >
            {saving ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onSkip}
            className="h-9 rounded-lg px-3 text-[12.5px] font-medium text-muted-fg/50 transition-colors hover:text-muted-fg/80"
          >
            Set up later
          </button>
        </div>
      </div>
    </div>
  );
}
