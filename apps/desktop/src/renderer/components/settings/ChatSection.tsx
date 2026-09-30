import React, { useEffect, useRef, useState } from "react";
import { TextAa, Rows, BoundingBox, Palette, Copy, MapTrifold, BookmarkSimple, CaretDown, Check } from "@phosphor-icons/react";
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
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Z_LAYERS } from "../ui/zLayers";
import {
  CHAT_CHROME_TINT_LABEL,
  COPY_POSITION_META,
  SHELL_GEOMETRY_LABEL,
  TRANSCRIPT_DENSITY_LABEL,
} from "./AppearanceSection";
import {
  ChatAppearancePreview,
  PREVIEW_PROVIDER_KEYS,
  PREVIEW_PROVIDER_META,
  type PreviewProviderKey,
} from "./ChatAppearancePreview";
import { DictationSection } from "./DictationSection";
import { VoiceConversationSection } from "./VoiceConversationSection";
import { LaunchPromptSection } from "./LaunchPromptSection";
import {
  SettingsColumn,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSlider,
  SettingsSplit,
  SettingsToggle,
} from "./primitives";

/**
 * Chat settings: how the transcript reads and what the composer does.
 *
 * The page leads with one live thread, drawn for the runtime picked in its
 * header, so every choice below shows its effect in place. Six threads side by
 * side made the page a wall and hid the one that mattered.
 *
 * The label maps stay in `AppearanceSection` and are imported here rather than
 * copied, so the two pages cannot drift on what "Comfortable" means. Every
 * anchor is unchanged, so deep links, ⌘K, and the manifest test keep landing.
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
  const [previewProvider, setPreviewProvider] = useState<PreviewProviderKey>("claude");

  return (
    <SettingsColumn wide>
      <SettingsSplit
        stickyStart
        ratio="start-wide"
        start={(
          <div id="appearance-preview" data-settings-anchor="appearance-preview" style={{ scrollMarginTop: 16 }}>
            <SettingsSection
              title="Preview"
              actions={<PreviewProviderPicker value={previewProvider} onChange={setPreviewProvider} />}
            >
              <div className="ade-chat-preview-stage">
                <div className="ade-chat-preview-frame">
                  <ChatAppearancePreview
                    theme={theme}
                    provider={previewProvider}
                    chatFontSizePx={chatFontSizePx}
                    transcriptDensity={chatTranscriptDensity}
                    chromeTint={chatChromeTint}
                    shellGeometry={chatShellGeometry}
                    chatUserMinimapEnabled={chatUserMinimapEnabled}
                  />
                </div>
              </div>
            </SettingsSection>
          </div>
        )}
        end={(
          <>
          <SettingsSection title="Transcript">
            <SettingsPanel>
              <SettingsRow
                anchor="chat-font-size"
                icon={<TextAa size={15} weight="duotone" />}
                tone="violet"
                title="Font size"
                description="The transcript and the composer. The rest of ADE keeps its size."
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
              <SettingsRow
                anchor="transcript-density"
                icon={<Rows size={15} weight="duotone" />}
                tone="blue"
                title="Density"
                description="Space between messages."
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
              <SettingsRow
                anchor="chat-corners"
                icon={<BoundingBox size={15} weight="duotone" />}
                tone="teal"
                title="Corners"
                description="How round the chat window is."
                control={
                  <SettingsSegmented
                    ariaLabel="Chat shell corners"
                    value={chatShellGeometry}
                    onChange={setChatShellGeometry}
                    options={CHAT_SHELL_GEOMETRY_IDS.map((id) => ({ value: id, label: SHELL_GEOMETRY_LABEL[id] }))}
                  />
                }
              />
              <SettingsRow
                anchor="chat-tint"
                icon={<Palette size={15} weight="duotone" />}
                tone="pink"
                title="Runtime color"
                description="Give each runtime its own hue in the chat chrome."
                control={
                  <SettingsSegmented
                    ariaLabel="Chat tint"
                    value={chatChromeTint}
                    onChange={setChatChromeTint}
                    options={CHAT_CHROME_TINT_IDS.map((id) => ({ value: id, label: CHAT_CHROME_TINT_LABEL[id] }))}
                  />
                }
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection title="Details">
            <SettingsPanel>
              <SettingsRow
                anchor="code-block-copy-position"
                icon={<Copy size={15} weight="duotone" />}
                tone="blue"
                title="Code block copy button"
                description={COPY_POSITION_META[codeBlockCopyButtonPosition].hint}
                control={
                  <SettingsSegmented
                    ariaLabel="Code block copy button position"
                    value={codeBlockCopyButtonPosition}
                    onChange={setCodeBlockCopyButtonPosition}
                    options={CODE_BLOCK_COPY_POSITION_IDS.map((id) => ({
                      value: id,
                      label: COPY_POSITION_META[id].label,
                    }))}
                  />
                }
              />
              <SettingsRow
                anchor="user-message-minimap"
                icon={<MapTrifold size={15} weight="duotone" />}
                tone="teal"
                title="Message minimap"
                description="A tick per message you sent in the left gutter. Hover to preview, click to jump."
                control={
                  <SettingsToggle
                    label="User message minimap"
                    checked={chatUserMinimapEnabled}
                    onChange={setChatUserMinimapEnabled}
                  />
                }
              />
              <SettingsRow
                anchor="prompt-stash-button"
                icon={<BookmarkSimple size={15} weight="duotone" />}
                tone="amber"
                title="Prompt stash button"
                description="The bookmark beside the context meter. ⌘S works either way."
                control={
                  <SettingsToggle
                    label="Prompt stash button"
                    checked={promptStashButtonEnabled}
                    onChange={setPromptStashButtonEnabled}
                  />
                }
              />
            </SettingsPanel>
          </SettingsSection>

          <LaunchPromptSection />

          {/* Voice input is chat dictation, so it lives with chat. */}
          <DictationSection />

          {/* Spoken conversations with a chat, carried by Codex voice. */}
          <VoiceConversationSection />
          </>
        )}
      />
    </SettingsColumn>
  );
}

/** The runtime the preview draws, picked from a small menu with each logo. */
function PreviewProviderPicker({
  value,
  onChange,
}: {
  value: PreviewProviderKey;
  onChange: (value: PreviewProviderKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { name, Logo } = PREVIEW_PROVIDER_META[value];

  // Close on a click outside the picker or on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Preview runtime: ${name}`}
        className="ade-settings-section-action"
        onClick={() => setOpen((next) => !next)}
      >
        <Logo size={13} />
        <span>{name}</span>
        <CaretDown size={11} />
      </button>
      {open ? (
        <div role="menu" className="ade-settings-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: Z_LAYERS.popover }}>
          {PREVIEW_PROVIDER_KEYS.map((key) => {
            const meta = PREVIEW_PROVIDER_META[key];
            const selected = key === value;
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className="ade-settings-menu-item"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
              >
                <meta.Logo size={14} />
                <span style={{ flex: 1, fontFamily: SANS_FONT }}>{meta.name}</span>
                {selected ? <Check size={12} weight="bold" style={{ color: COLORS.accent }} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
