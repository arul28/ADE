import React from "react";
import { AppWindow, BellRinging, Play, SpeakerHigh } from "@phosphor-icons/react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  useAppStore,
  type AgentTurnCompletionSound,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import {
  SettingsRow,
  SettingsSelect,
  SettingsSlider,
  SettingsToggle,
} from "./primitives";

function soundLabel(id: AgentTurnCompletionSound): string {
  if (id === "off") return "Off";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * The completion chime, as rows for a settings panel. Volume and the focus
 * rule only show once a sound is picked; with the sound off they do nothing.
 */
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

  return (
    <>
      <SettingsRow
        anchor="agent-completion-sound"
        icon={<BellRinging size={15} weight="duotone" />}
        tone="amber"
        title="Completion chime"
        description="When an agent finishes a turn. Back-to-back turns chime once."
        control={
          <>
            <button
              type="button"
              className="ade-settings-icon-button"
              aria-label="Preview the chime"
              title="Preview"
              disabled={soundIsOff}
              onClick={() => {
                if (soundIsOff) return;
                playAgentTurnCompletionSound(agentTurnCompletionSound, {
                  volume: agentTurnCompletionSoundVolume,
                  skipWhenFocused: false,
                });
              }}
            >
              <Play size={12} weight="fill" />
            </button>
            <SettingsSelect
              ariaLabel="Sound"
              value={agentTurnCompletionSound}
              onChange={(next) => setAgentTurnCompletionSound(next as AgentTurnCompletionSound)}
              options={AGENT_TURN_COMPLETION_SOUND_IDS.map((id) => ({ value: id, label: soundLabel(id) }))}
              style={{ minWidth: 120 }}
            />
          </>
        }
      />
      {soundIsOff ? null : (
        <>
          <SettingsRow
            icon={<SpeakerHigh size={15} weight="duotone" />}
            tone="blue"
            title="Volume"
            control={
              <SettingsSlider
                min={0}
                max={100}
                step={5}
                value={volumePercent}
                onChange={(next) => setAgentTurnCompletionSoundVolume(next / 100)}
                ariaLabel={`Volume · ${volumePercent}%`}
                valueLabel={`${volumePercent}%`}
              />
            }
          />
          <SettingsRow
            icon={<AppWindow size={15} weight="duotone" />}
            tone="slate"
            title="Only in the background"
            description="Skip the chime while ADE is the focused window."
            control={
              <SettingsToggle
                label="Only when ADE is in the background"
                checked={agentTurnCompletionSoundQuietWhenFocused}
                onChange={setAgentTurnCompletionSoundQuietWhenFocused}
              />
            }
          />
        </>
      )}
    </>
  );
}
