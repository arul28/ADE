import React from "react";
import { BellRinging, Check, Play, SpeakerSlash } from "@phosphor-icons/react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  useAppStore,
  type AgentTurnCompletionSound,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import {
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsSlider,
  SettingsToggle,
} from "./primitives";

function soundLabel(id: AgentTurnCompletionSound): string {
  if (id === "off") return "Off";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** A tiny waveform per tone, so the cards read as sounds, not words. */
const SOUND_BARS: Record<Exclude<AgentTurnCompletionSound, "off">, number[]> = {
  chime: [10, 18, 28, 22, 30, 20, 12, 8],
  ping: [6, 30, 14, 8, 5, 4],
  bell: [24, 30, 26, 20, 16, 12, 9, 6, 4],
};

/**
 * The completion chime: a card per sound (picking one plays it), then volume
 * and the focus rule as rows. Volume and the focus rule only show once a
 * sound is picked; with the sound off they do nothing. `extraRows` lets the
 * page add its other sound rows to the same panel.
 */
export function AgentCompletionSoundSection({ extraRows }: { extraRows?: React.ReactNode } = {}) {
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

  const preview = (id: AgentTurnCompletionSound) => {
    if (id === "off") return;
    playAgentTurnCompletionSound(id, {
      volume: agentTurnCompletionSoundVolume,
      skipWhenFocused: false,
    });
  };

  return (
    <ModernSection
      group="Sound"
      anchor="agent-completion-sound"
      title="Sound"
      hint="A chime when an agent finishes a turn. Back-to-back turns chime once."
      actions={(
        <button
          type="button"
          className="ade-nt-preview"
          aria-label="Preview the chime"
          title="Preview"
          disabled={soundIsOff}
          onClick={() => preview(agentTurnCompletionSound)}
        >
          <Play size={10} weight="fill" />
          Preview
        </button>
      )}
    >
      <div className="ade-nt-sounds" role="radiogroup" aria-label="Sound">
        {AGENT_TURN_COMPLETION_SOUND_IDS.map((id) => {
          const active = id === agentTurnCompletionSound;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              className="ade-ap-choice"
              data-active={active}
              onClick={() => {
                setAgentTurnCompletionSound(id);
                preview(id);
              }}
            >
              <div className="ade-nt-sound-art" aria-hidden>
                {id === "off" ? (
                  <span className="ade-nt-sound-off" />
                ) : (
                  SOUND_BARS[id].map((height, index) => <i key={index} style={{ height }} />)
                )}
              </div>
              <div className="ade-ap-choice-foot">
                {id === "off" ? <SpeakerSlash size={13} /> : <BellRinging size={13} />}
                <span>{soundLabel(id)}</span>
                {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
              </div>
            </button>
          );
        })}
      </div>
      {soundIsOff && !extraRows ? null : (
      <ModernRows>
        {soundIsOff ? null : (
          <>
            <ModernRow
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
            <ModernRow
              title="Only in the background"
              hint="Skip the chime while ADE is the focused window."
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
        {extraRows}
      </ModernRows>
      )}
    </ModernSection>
  );
}
