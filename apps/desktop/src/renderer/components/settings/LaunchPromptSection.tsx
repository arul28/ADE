import React from "react";
import { Bell, BookmarkSimple, Copy, PencilSimple } from "@phosphor-icons/react";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/** What the composer does with a launch prompt, and the small composer helpers. */
export function LaunchPromptSection() {
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const setLaunchPromptClipboardEnabled = useAppStore((s) => s.setLaunchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);
  const draftsButtonEnabled = useRootAppStore((s) => s.draftsButtonEnabled);
  const setDraftsButtonEnabled = useRootAppStore((s) => s.setDraftsButtonEnabled);

  return (
    <ModernSection
      group="Composer"
      title="Composer"
      hint="What happens to a prompt when a new chat starts."
      icon={<PencilSimple size={16} weight="bold" />}
      tone="blue"
    >
      <ModernRows>
        <ModernRow
          anchor="chat-launch-clipboard"
          icon={<Copy size={15} weight="bold" />}
          tone="blue"
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
            icon={<Bell size={15} weight="bold" />}
            tone="blue"
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
        <ModernRow
          anchor="drafts-button"
          icon={<BookmarkSimple size={15} weight="bold" />}
          tone="blue"
          title="Drafts button"
          hint="The bookmark beside the context meter. ⌘S works either way."
          control={(
            <SettingsToggle
              label="Drafts button"
              checked={draftsButtonEnabled}
              onChange={setDraftsButtonEnabled}
            />
          )}
        />
      </ModernRows>
    </ModernSection>
  );
}
