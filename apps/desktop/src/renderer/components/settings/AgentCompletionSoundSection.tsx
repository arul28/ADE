import React from "react";
import { SpeakerHigh } from "@phosphor-icons/react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  useAppStore,
  type AgentTurnCompletionSound,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton } from "../lanes/laneDesignTokens";
import {
  SettingsCard,
  SettingsSelect,
  SettingsSlider,
  SettingsToggle,
} from "./primitives";

function soundLabel(id: AgentTurnCompletionSound): string {
  if (id === "off") return "Off";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function AgentCompletionSoundSection() {
  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const setAgentTurnCompletionSound = useAppStore((s) => s.setAgentTurnCompletionSound);
  const agentTurnCompletionSoundVolume = useAppStore((s) => s.agentTurnCompletionSoundVolume);
  const setAgentTurnCompletionSoundVolume = useAppStore((s) => s.setAgentTurnCompletionSoundVolume);
  const agentTurnCompletionSoundQuietWhenFocused = useAppStore(
    (s) => s.agentTurnCompletionSoundQuietWhenFocused,
  );
  const setAgentTurnCompletionSoundQuietWhenFocused = useAppStore(
    (s) => s.setAgentTurnCompletionSoundQuietWhenFocused,
  );

  const volumePercent = Math.round(agentTurnCompletionSoundVolume * 100);
  const soundIsOff = agentTurnCompletionSound === "off";

  // No `SettingsGroup` here: Notifications already renders this card inside its
  // own "Sound" group, and a second heading over one card is noise.
  return (
    <SettingsCard
      anchor="agent-completion-sound"
      title="Completion sound"
      description="Play a short chime when an agent finishes a turn and the chat goes idle. Rapid back-to-back turns collapse into a single chime so long runs do not spam audio."
      control={
        <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <SettingsSelect
            ariaLabel="Sound"
            value={agentTurnCompletionSound}
            onChange={(next) => setAgentTurnCompletionSound(next as AgentTurnCompletionSound)}
            options={AGENT_TURN_COMPLETION_SOUND_IDS.map((id) => ({ value: id, label: soundLabel(id) }))}
          />
          <button
            type="button"
            disabled={soundIsOff}
            onClick={() => {
              if (soundIsOff) return;
              playAgentTurnCompletionSound(agentTurnCompletionSound, {
                volume: agentTurnCompletionSoundVolume,
                skipWhenFocused: false,
              });
            }}
            style={{
              ...primaryButton({ height: 30, padding: "0 14px", fontSize: 12 }),
              opacity: soundIsOff ? 0.45 : 1,
              cursor: soundIsOff ? "not-allowed" : "pointer",
            }}
          >
            Preview
          </button>
        </span>
      }
    >
      {soundIsOff ? (
        <p style={{ margin: 0, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textDim }}>
          Pick a sound above to configure volume and focus behavior.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <SoundField
            label={
              <>
                <SpeakerHigh size={16} weight="duotone" style={{ color: COLORS.accent }} />
                Volume
              </>
            }
          >
            <SettingsSlider
              min={0}
              max={100}
              step={5}
              value={volumePercent}
              onChange={(next) => setAgentTurnCompletionSoundVolume(next / 100)}
              ariaLabel={`Volume · ${volumePercent}%`}
              valueLabel={`${volumePercent}%`}
            />
          </SoundField>

          <SoundField
            label="Only when ADE is in the background"
            hint="Skips the chime while ADE is the focused window."
          >
            <SettingsToggle
              label="Only when ADE is in the background"
              checked={agentTurnCompletionSoundQuietWhenFocused}
              onChange={setAgentTurnCompletionSoundQuietWhenFocused}
            />
          </SoundField>
        </div>
      )}
    </SettingsCard>
  );
}

/** A labelled control inside the card — the in-card field shape Appearance uses. */
function SoundField({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: COLORS.textMuted,
        }}
      >
        {label}
      </span>
      {children}
      {hint ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, lineHeight: 1.5 }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
