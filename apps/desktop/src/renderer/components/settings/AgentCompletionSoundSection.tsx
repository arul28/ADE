import React, { useId } from "react";
import { Bell, SpeakerHigh } from "@phosphor-icons/react";
import {
  AGENT_TURN_COMPLETION_SOUND_IDS,
  useAppStore,
  type AgentTurnCompletionSound,
} from "../../state/appStore";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, primaryButton } from "../lanes/laneDesignTokens";
import {
  SettingsToggle,
  SettingsSectionShell,
} from "./settingsSectionUi";

function soundLabel(id: AgentTurnCompletionSound): string {
  if (id === "off") return "Off";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function AgentCompletionSoundSection() {
  const soundSelectId = useId();
  const volumeSliderId = useId();
  const quietToggleId = useId();

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
    <SettingsSectionShell
      id="agent-completion-sound"
      title="Completion sound"
      description="Play a short chime when an agent finishes a turn and the chat goes idle."
      icon={Bell}
      brandColor="#F59E0B"
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label
                htmlFor={soundSelectId}
                style={{
                  display: "block",
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: SANS_FONT,
                  color: COLORS.textPrimary,
                  marginBottom: 6,
                }}
              >
                Sound
              </label>
              <p style={{ margin: "0 0 12px", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                Rapid back-to-back turns collapse into a single chime so long runs do not spam audio.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <select
                  id={soundSelectId}
                  value={agentTurnCompletionSound}
                  onChange={(e) => setAgentTurnCompletionSound(e.target.value as AgentTurnCompletionSound)}
                  style={{
                    height: 36,
                    minWidth: 160,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    background: COLORS.recessedBg,
                    color: COLORS.textPrimary,
                    fontSize: 12,
                    fontFamily: SANS_FONT,
                    padding: "0 10px",
                  }}
                >
                  {AGENT_TURN_COMPLETION_SOUND_IDS.map((id) => (
                    <option key={id} value={id}>
                      {soundLabel(id)}
                    </option>
                  ))}
                </select>
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
                    ...primaryButton({ height: 36, padding: "0 14px", fontSize: 12 }),
                    opacity: soundIsOff ? 0.45 : 1,
                    cursor: soundIsOff ? "not-allowed" : "pointer",
                  }}
                >
                  Preview
                </button>
              </div>
            </div>

            {!soundIsOff ? (
              <>
                <div style={{ paddingTop: 16, borderTop: `1px solid ${COLORS.border}` }}>
                  <label
                    htmlFor={volumeSliderId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: SANS_FONT,
                      color: COLORS.textPrimary,
                      marginBottom: 10,
                    }}
                  >
                    <SpeakerHigh size={16} weight="duotone" style={{ color: COLORS.accent }} />
                    Volume · {volumePercent}%
                  </label>
                  <input
                    id={volumeSliderId}
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={volumePercent}
                    onChange={(e) => setAgentTurnCompletionSoundVolume(Number(e.target.value) / 100)}
                    style={{ width: "100%", maxWidth: 320, accentColor: COLORS.accent }}
                  />
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 16,
                    paddingTop: 16,
                    borderTop: `1px solid ${COLORS.border}`,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <label
                      htmlFor={quietToggleId}
                      style={{
                        display: "block",
                        fontSize: 13,
                        fontWeight: 600,
                        fontFamily: SANS_FONT,
                        color: COLORS.textPrimary,
                        cursor: "pointer",
                        lineHeight: 1.4,
                      }}
                    >
                      Only when ADE is in the background
                    </label>
                    <p style={{ margin: "4px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                      Skips the chime while ADE is the focused window.
                    </p>
                  </div>
                  <SettingsToggle
                    id={quietToggleId}
                    checked={agentTurnCompletionSoundQuietWhenFocused}
                    onChange={setAgentTurnCompletionSoundQuietWhenFocused}
                  />
                </div>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                Pick a sound above to configure volume and focus behavior.
              </p>
            )}
        </div>
      </div>
    </SettingsSectionShell>
  );
}
