import React from "react";
import { Bell, BookmarkSimple, ClockCounterClockwise, Copy, PencilSimple } from "@phosphor-icons/react";
import { isMacPlatform, modifierChordLabel } from "../../lib/platform";
import { promptSearchShortcutLabel } from "../chat/chatPromptHistory";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/** What the composer does with a launch prompt, and the small composer helpers. */
export function LaunchPromptSection() {
  const launchPromptClipboardEnabled = useAppStore((s) => s.promptClipboardCopyEnabled);
  const setPromptClipboardCopyEnabled = useAppStore((s) => s.setPromptClipboardCopyEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const setLaunchPromptClipboardNoticeEnabled = useAppStore((s) => s.setLaunchPromptClipboardNoticeEnabled);
  const draftsButtonEnabled = useRootAppStore((s) => s.draftsButtonEnabled);
  const setDraftsButtonEnabled = useRootAppStore((s) => s.setDraftsButtonEnabled);

  return (
    <ModernSection
      group="Composer"
      title="Composer"
      hint="Your earlier prompts, and what happens to a prompt when you send it."
      icon={<PencilSimple size={16} weight="bold" />}
      tone="blue"
    >
      <ModernRows>
        <ModernRow
          anchor="prompt-history"
          icon={<ClockCounterClockwise size={15} weight="bold" />}
          tone="blue"
          title="Prompt history"
          hint={`↑ in the composer recalls your earlier prompts: this chat's first, then every chat's on this computer. ↓ past the newest brings back what you were typing. ${promptSearchShortcutLabel(isMacPlatform())} searches them.`}
        />
        <ModernRow
          anchor="chat-launch-clipboard"
          icon={<Copy size={15} weight="bold" />}
          tone="blue"
          title="Copy prompts to clipboard"
          hint="Also put each prompt you send on the clipboard. Off by default: prompt history keeps them."
          control={(
            <SettingsToggle
              label="Copy prompts to clipboard"
              checked={launchPromptClipboardEnabled}
              onChange={setPromptClipboardCopyEnabled}
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
          hint={`The bookmark beside the context meter. ${modifierChordLabel("S")} works either way.`}
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
