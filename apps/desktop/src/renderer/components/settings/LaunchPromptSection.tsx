import React from "react";
import { ClipboardText, Note } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { SettingsPanel, SettingsRow, SettingsSection, SettingsToggle } from "./primitives";

/** What the composer does with a launch prompt. */
export function LaunchPromptSection() {
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);

  return (
    <SettingsSection title="Composer">
      <SettingsPanel>
        <SettingsRow
          anchor="chat-launch-clipboard"
          icon={<ClipboardText size={15} weight="duotone" />}
          tone="green"
          title="Copy prompts to clipboard"
          description="Keep a copy of each launch prompt before ADE sends it."
          control={
            <SettingsToggle
              label="Copy prompts to clipboard"
              checked={launchPromptClipboardEnabled}
              onChange={setLaunchPromptClipboardEnabled}
            />
          }
        />
        {/* Only meaningful while copying is on. */}
        {launchPromptClipboardEnabled ? (
          <SettingsRow
            title="Show a copy reminder"
            icon={<Note size={15} weight="duotone" />}
            tone="slate"
            description="A short note in the composer when the prompt is copied."
            control={
              <SettingsToggle
                label="Show reminder in composer"
                checked={launchPromptClipboardNoticeEnabled}
                onChange={setLaunchPromptClipboardNoticeEnabled}
              />
            }
          />
        ) : null}
      </SettingsPanel>
    </SettingsSection>
  );
}
