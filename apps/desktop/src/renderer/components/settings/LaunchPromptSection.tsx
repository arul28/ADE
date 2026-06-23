import React, { useId } from "react";
import { ClipboardText } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { SettingsSectionShell, SettingsToggle } from "./settingsSectionUi";

export function LaunchPromptSection() {
  const copyToggleId = useId();
  const noticeToggleId = useId();
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);

  return (
    <SettingsSectionShell
      id="chat-launch-clipboard"
      title="Launch prompts"
      description="Optionally save what you send to chat, CLI, and agent sessions to your clipboard before ADE launches it."
      icon={ClipboardText}
      brandColor="#38BDF8"
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <label
              htmlFor={copyToggleId}
              style={{
                display: "block",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                cursor: "pointer",
                lineHeight: 1.4,
              }}
            >
              Copy prompts to clipboard
            </label>
            <p style={{ margin: "6px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              Saves the full launch prompt before ADE sends it to chat, CLI, or an agent session.
            </p>

            {launchPromptClipboardEnabled ? (
              <div
                style={{
                  marginTop: 16,
                  paddingTop: 16,
                  borderTop: `1px solid ${COLORS.border}`,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <label
                    htmlFor={noticeToggleId}
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
                    Show reminder in composer
                  </label>
                  <p style={{ margin: "4px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                    Displays a short note before copying so you know the prompt was saved.
                  </p>
                </div>
                <SettingsToggle
                  id={noticeToggleId}
                  checked={launchPromptClipboardNoticeEnabled}
                  onChange={setLaunchPromptClipboardNoticeEnabled}
                />
              </div>
            ) : null}
          </div>
          <SettingsToggle
            id={copyToggleId}
            checked={launchPromptClipboardEnabled}
            onChange={setLaunchPromptClipboardEnabled}
          />
        </div>
      </div>
    </SettingsSectionShell>
  );
}
