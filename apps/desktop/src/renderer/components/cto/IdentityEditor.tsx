import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { CtoCommunicationStyle, CtoIdentity, CtoPersonalityPreset } from "../../../shared/types";
import { cn } from "../ui/cn";
import { textareaCls } from "./shared/designTokens";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";
import {
  getPersonalityTheme,
  normalizeCommunicationStyle,
  WORK_STYLE_ROWS,
} from "./personalityTheme";
import { Segmented } from "./Segmented";

const CTO_DEFAULT_NAME = "CTO";

type IdentityDraft = {
  name: string;
  personality: CtoPersonalityPreset;
  customPersonality: string;
  communicationStyle: CtoCommunicationStyle;
};

function draftFromIdentity(identity: CtoIdentity | null): IdentityDraft {
  return {
    name: identity?.name && identity.name !== CTO_DEFAULT_NAME ? identity.name : "",
    personality: identity?.personality ?? "strategic",
    customPersonality:
      identity?.customPersonality
      ?? (identity?.personality === "custom" ? identity?.persona ?? "" : ""),
    communicationStyle: normalizeCommunicationStyle(identity?.communicationStyle),
  };
}

function draftsEqual(a: IdentityDraft, b: IdentityDraft): boolean {
  return a.name === b.name
    && a.personality === b.personality
    && a.customPersonality === b.customPersonality
    && a.communicationStyle.verbosity === b.communicationStyle.verbosity
    && a.communicationStyle.proactivity === b.communicationStyle.proactivity
    && a.communicationStyle.escalationThreshold === b.communicationStyle.escalationThreshold;
}

/**
 * Identity section of CTO settings: name, personality preset, and the three
 * work-style rows. The model lives in its own section; this saves only the
 * personality overlay.
 */
export function IdentityEditor({
  identity,
  onSave,
}: {
  identity: CtoIdentity | null;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const baseline = useMemo(() => draftFromIdentity(identity), [identity]);
  const [draft, setDraft] = useState<IdentityDraft>(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(baseline);
  }, [baseline]);

  const activeTheme = getPersonalityTheme(draft.personality);
  const dirty = !draftsEqual(draft, baseline);

  const handleSave = useCallback(async () => {
    if (draft.personality === "custom" && !draft.customPersonality.trim()) {
      setError("Describe the custom personality, or pick one of the presets.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const preset = getCtoPersonalityPreset(draft.personality);
      await onSave({
        name: draft.name.trim() || CTO_DEFAULT_NAME,
        persona: draft.personality === "custom"
          ? draft.customPersonality.trim()
          : `Persistent project CTO with ${preset.label.toLowerCase()} personality.`,
        personality: draft.personality,
        communicationStyle: draft.communicationStyle,
        ...(draft.personality === "custom"
          ? { customPersonality: draft.customPersonality.trim() }
          : { customPersonality: undefined }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  return (
    <div className="space-y-6">
      {/* Name */}
      <div>
        <label className="block text-[12px] font-medium text-muted-fg/70" htmlFor="cto-identity-name">
          Name
        </label>
        <input
          id="cto-identity-name"
          type="text"
          value={draft.name}
          placeholder="CTO"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          className="mt-1.5 h-9 w-full rounded-lg border border-white/[0.08] bg-black/25 px-3 text-[13px] text-fg placeholder:text-muted-fg/35 focus:border-white/20 focus:outline-none"
        />
      </div>

      {/* Personality */}
      <div>
        <div className="text-[12px] font-medium text-muted-fg/70">Personality</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {CTO_PERSONALITY_PRESETS.map((preset) => {
            const theme = getPersonalityTheme(preset.id);
            const selected = draft.personality === preset.id;
            const Icon = theme.icon;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => {
                  setDraft((current) => ({ ...current, personality: preset.id }));
                  setError(null);
                }}
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
          className={cn(textareaCls, "min-h-[96px]")}
          rows={4}
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
      <div className="space-y-3">
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

      {/* Constraints (read-only, when configured) */}
      {identity?.constraints && identity.constraints.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-muted-fg/70">Constraints</div>
          <ul className="mt-2 space-y-1.5">
            {identity.constraints.map((constraint, index) => (
              <li key={index} className="flex gap-2 text-[12px] leading-5 text-muted-fg/60">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-fg/40" />
                {constraint}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="text-[12px] text-error">{error}</div>}

      <button
        type="button"
        disabled={!dirty || saving}
        onClick={() => void handleSave()}
        className={cn(
          "h-9 w-full rounded-lg text-[13px] font-semibold transition-opacity",
          dirty && !saving ? "text-[#0A0A0F]" : "cursor-default text-[#0A0A0F]/70",
        )}
        style={{ background: activeTheme.hex, opacity: dirty && !saving ? 1 : 0.55 }}
      >
        {saving ? "Saving…" : dirty ? "Save identity" : "Saved"}
      </button>
    </div>
  );
}
