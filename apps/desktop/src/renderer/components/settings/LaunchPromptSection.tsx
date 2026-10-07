import React from "react";
import { useAppStore } from "../../state/appStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/** What the composer does with a launch prompt. */
export function LaunchPromptSection() {
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);

  return (
    <ModernSection group="Composer" title="Composer" hint="What happens to a prompt when a new chat starts.">
      <ModernRows>
        <ModernRow
          anchor="chat-launch-clipboard"
          title="Copy prompts to clipboard"
          hint="Keep a copy of each launch prompt before ADE sends it."
          control={(
            <SettingsToggle
              label="Copy prompts to clipboard"
              checked={launchPromptClipboardEnabled}
              onChange={setLaunchPromptClipboardEnabled}
            />
          )}
        />
        {/* Only meaningful while copying is on. */}
        {launchPromptClipboardEnabled ? (
          <ModernRow
            title="Show a copy reminder"
            hint="A short note in the composer when the prompt is copied."
            control={(
              <SettingsToggle
                label="Show reminder in composer"
                checked={launchPromptClipboardNoticeEnabled}
                onChange={setLaunchPromptClipboardNoticeEnabled}
              />
            )}
          />
        ) : null}
      </ModernRows>
    </ModernSection>
  );
}
