import React, { useId } from "react";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsToggle } from "./primitives";

export function LaunchPromptSection() {
  const copyToggleId = useId();
  const noticeToggleId = useId();
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);

  return (
    <SettingsCard
      anchor="chat-launch-clipboard"
      title="Copy prompts to clipboard"
      description="Saves the full launch prompt before ADE sends it to chat, CLI, or an agent session."
      control={
        <SettingsToggle
          id={copyToggleId}
          label="Copy prompts to clipboard"
          checked={launchPromptClipboardEnabled}
          onChange={setLaunchPromptClipboardEnabled}
        />
      }
    >
      {launchPromptClipboardEnabled ? (
        <div
          style={{
            paddingTop: 16,
            borderTop: `1px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                lineHeight: 1.4,
              }}
            >
              Show reminder in composer
            </div>
            <p style={{ margin: "4px 0 0", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              Displays a short note before copying so you know the prompt was saved.
            </p>
          </div>
          <SettingsToggle
            id={noticeToggleId}
            label="Show reminder in composer"
            checked={launchPromptClipboardNoticeEnabled}
            onChange={setLaunchPromptClipboardNoticeEnabled}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}
