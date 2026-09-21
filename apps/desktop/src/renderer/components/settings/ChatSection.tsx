import React from "react";
import {
  CHAT_FONT_SIZE_MAX_PX,
  CHAT_FONT_SIZE_MIN_PX,
  CHAT_CHROME_TINT_IDS,
  CHAT_SHELL_GEOMETRY_IDS,
  CHAT_TRANSCRIPT_DENSITY_IDS,
  CODE_BLOCK_COPY_POSITION_IDS,
  useAppStore,
  useRootAppStore,
} from "../../state/appStore";
import { COLORS } from "../lanes/laneDesignTokens";
import {
  CHAT_CHROME_TINT_LABEL,
  COPY_POSITION_META,
  SHELL_GEOMETRY_LABEL,
  TRANSCRIPT_DENSITY_LABEL,
} from "./AppearanceSection";
import { ChatAppearancePreview } from "./ChatAppearancePreview";
import { LaunchPromptSection } from "./LaunchPromptSection";
import {
  SettingsCard,
  SettingsGroup,
  SettingsSegmented,
  SettingsSlider,
  SettingsToggle,
} from "./primitives";

/**
 * Chat settings: how the transcript reads and what the composer does.
 *
 * Split out of Appearance because nine of that page's eleven rows were about
 * chat, and "Appearance" had become the place you look for a composer switch.
 * The label maps stay in `AppearanceSection` and are imported here rather than
 * copied, so the two pages cannot drift on what "Comfortable" means.
 *
 * Every anchor here is unchanged from when these rows lived on Appearance, so
 * deep links, ⌘K, and the manifest test all keep landing.
 */
export function ChatSection() {
  const theme = useAppStore((s) => s.theme);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const setChatFontSizePx = useAppStore((s) => s.setChatFontSizePx);
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const setChatTranscriptDensity = useAppStore((s) => s.setChatTranscriptDensity);
  const chatChromeTint = useAppStore((s) => s.chatChromeTint);
  const setChatChromeTint = useAppStore((s) => s.setChatChromeTint);
  const chatShellGeometry = useAppStore((s) => s.chatShellGeometry);
  const setChatShellGeometry = useAppStore((s) => s.setChatShellGeometry);
  const chatUserMinimapEnabled = useAppStore((s) => s.chatUserMinimapEnabled);
  const setChatUserMinimapEnabled = useAppStore((s) => s.setChatUserMinimapEnabled);
  const promptStashButtonEnabled = useRootAppStore((s) => s.promptStashButtonEnabled);
  const setPromptStashButtonEnabled = useRootAppStore((s) => s.setPromptStashButtonEnabled);
  const codeBlockCopyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const setCodeBlockCopyButtonPosition = useAppStore((s) => s.setCodeBlockCopyButtonPosition);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <SettingsGroup title="Chat typography">
        <SettingsCard
          anchor="chat-font-size"
          title="Chat font size"
          description="Sizes the transcript and composer. Not a whole-window zoom."
          control={
            <SettingsSlider
              min={CHAT_FONT_SIZE_MIN_PX}
              max={CHAT_FONT_SIZE_MAX_PX}
              value={chatFontSizePx}
              onChange={setChatFontSizePx}
              ariaLabel="Chat font size"
              valueLabel={`${chatFontSizePx}px`}
            />
          }
        />
        <SettingsCard
          anchor="transcript-density"
          title="Transcript density"
          description="Vertical spacing between messages."
          control={
            <SettingsSegmented
              ariaLabel="Transcript density"
              value={chatTranscriptDensity}
              onChange={setChatTranscriptDensity}
              options={CHAT_TRANSCRIPT_DENSITY_IDS.map((id) => ({
                value: id,
                label: TRANSCRIPT_DENSITY_LABEL[id],
              }))}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Chat surface">
        <SettingsCard
          anchor="chat-tint"
          title="Chat tint"
          description="Colored gives each runtime its own hue in the chat chrome."
          control={
            <SettingsSegmented
              ariaLabel="Chat tint"
              value={chatChromeTint}
              onChange={setChatChromeTint}
              options={CHAT_CHROME_TINT_IDS.map((id) => ({ value: id, label: CHAT_CHROME_TINT_LABEL[id] }))}
            />
          }
        />
        <SettingsCard
          anchor="chat-corners"
          title="Chat shell corners"
          control={
            <SettingsSegmented
              ariaLabel="Chat shell corners"
              value={chatShellGeometry}
              onChange={setChatShellGeometry}
              options={CHAT_SHELL_GEOMETRY_IDS.map((id) => ({ value: id, label: SHELL_GEOMETRY_LABEL[id] }))}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Chat details">
        <SettingsCard
          anchor="code-block-copy-position"
          title="Code block copy button"
          description="Where the copy control sits on a code block."
          control={
            <SettingsSegmented
              ariaLabel="Code block copy button position"
              value={codeBlockCopyButtonPosition}
              onChange={setCodeBlockCopyButtonPosition}
              options={CODE_BLOCK_COPY_POSITION_IDS.map((id) => ({
                value: id,
                label: COPY_POSITION_META[id].label,
                hint: COPY_POSITION_META[id].hint,
              }))}
            />
          }
        />
        <SettingsCard
          anchor="user-message-minimap"
          title="User message minimap"
          description="A tick per message you sent, in the chat's left gutter. Hover to preview, click to jump. Mouse only."
          control={
            <SettingsToggle
              label="User message minimap"
              checked={chatUserMinimapEnabled}
              onChange={setChatUserMinimapEnabled}
            />
          }
        />
        <SettingsCard
          anchor="prompt-stash-button"
          title="Prompt stash button"
          description="The bookmark beside the context meter. Cmd/Ctrl+S works either way."
          control={
            <SettingsToggle
              label="Prompt stash button"
              checked={promptStashButtonEnabled}
              onChange={setPromptStashButtonEnabled}
            />
          }
        />
        <LaunchPromptSection />
        <SettingsCard
          anchor="appearance-preview"
          title="Live preview"
          description="Reflects every choice above, in the theme set under Appearance."
          stacked
        >
          <div
            style={{
              border: `1px solid ${COLORS.borderMuted}`,
              borderRadius: 10,
              background: COLORS.recessedBg,
              padding: 14,
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            <ChatAppearancePreview
              theme={theme}
              chatFontSizePx={chatFontSizePx}
              transcriptDensity={chatTranscriptDensity}
              chromeTint={chatChromeTint}
              shellGeometry={chatShellGeometry}
              chatUserMinimapEnabled={chatUserMinimapEnabled}
            />
          </div>
        </SettingsCard>
      </SettingsGroup>
    </div>
  );
}
