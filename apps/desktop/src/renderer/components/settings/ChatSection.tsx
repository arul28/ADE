import React, { useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import {
  CHAT_FONT_SIZE_MAX_PX,
  CHAT_FONT_SIZE_MIN_PX,
  CHAT_CHROME_TINT_IDS,
  CHAT_SHELL_GEOMETRY_IDS,
  CHAT_TRANSCRIPT_DENSITY_IDS,
  CODE_BLOCK_COPY_POSITION_IDS,
  useAppStore,
  useRootAppStore,
  type ChatChromeTint,
  type ChatShellGeometry,
  type ChatTranscriptDensity,
  type CodeBlockCopyButtonPosition,
} from "../../state/appStore";
import { PROVIDER_CHAT_ACCENTS } from "../chat/chatSurfaceTheme";
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
import { ModernRow, ModernRows, ModernSection, SettingsColumn, SettingsToggle } from "./primitives";
import "./ChatSection.css";

/**
 * Chat settings: how the transcript reads and what the composer does.
 *
 * Laid out like Settings › Appearance: the choices on the left, each a short
 * heading over a visual option (a type sample, cards with tiny transcripts),
 * and on the right one live thread that stays in view, drawn for the runtime
 * picked above it, so every choice shows its effect the moment it is made.
 * On a narrow window the preview moves above the choices.
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
  const draftsButtonEnabled = useRootAppStore((s) => s.draftsButtonEnabled);
  const setDraftsButtonEnabled = useRootAppStore((s) => s.setDraftsButtonEnabled);
  const codeBlockCopyButtonPosition = useAppStore((s) => s.codeBlockCopyButtonPosition);
  const setCodeBlockCopyButtonPosition = useAppStore((s) => s.setCodeBlockCopyButtonPosition);
  const [previewProvider, setPreviewProvider] = useState<PreviewProviderKey>("claude");

  return (
    <SettingsColumn wide>
      <div className="ade-cs">
        <div className="ade-cs-layout">
          <div className="ade-cs-main">
            <ModernSection
              group="Transcript"
              anchor="chat-font-size"
              title="Text size"
              hint="The transcript and the composer. The rest of ADE keeps its size."
            >
              <FontSizeControl value={chatFontSizePx} onChange={setChatFontSizePx} />
            </ModernSection>

            <ModernSection group="Transcript" anchor="transcript-density" title="Density" hint="Space between messages.">
              <ChoiceGrid
                ariaLabel="Transcript density"
                value={chatTranscriptDensity}
                options={CHAT_TRANSCRIPT_DENSITY_IDS}
                label={(id) => TRANSCRIPT_DENSITY_LABEL[id]}
                onChange={setChatTranscriptDensity}
                art={(id) => <DensityArt density={id} />}
              />
            </ModernSection>

            <ModernSection group="Transcript" anchor="chat-corners" title="Corners" hint="How round the chat window is.">
              <ChoiceGrid
                ariaLabel="Chat shell corners"
                value={chatShellGeometry}
                options={CHAT_SHELL_GEOMETRY_IDS}
                label={(id) => SHELL_GEOMETRY_LABEL[id]}
                onChange={setChatShellGeometry}
                art={(id) => <CornersArt geometry={id} />}
              />
            </ModernSection>

            <ModernSection
              group="Transcript"
              anchor="chat-tint"
              title="Runtime color"
              hint="Give each runtime its own hue in the chat chrome."
            >
              <ChoiceGrid
                ariaLabel="Chat tint"
                value={chatChromeTint}
                options={CHAT_CHROME_TINT_IDS}
                label={(id) => CHAT_CHROME_TINT_LABEL[id]}
                onChange={setChatChromeTint}
                art={(id) => <TintArt tint={id} />}
                columns={2}
              />
            </ModernSection>

            <ModernSection
              group="Transcript"
              anchor="code-block-copy-position"
              title="Code block copy button"
              hint={COPY_POSITION_META[codeBlockCopyButtonPosition].hint}
            >
              <ChoiceGrid
                ariaLabel="Code block copy button position"
                value={codeBlockCopyButtonPosition}
                options={CODE_BLOCK_COPY_POSITION_IDS}
                label={(id) => COPY_POSITION_META[id].label}
                onChange={setCodeBlockCopyButtonPosition}
                art={(id) => <CopyArt position={id} />}
              />
            </ModernSection>

            <ModernSection group="Details" title="Details" hint="Small helpers around the transcript and the composer.">
              <ModernRows>
                <ModernRow
                  anchor="user-message-minimap"
                  title="Message minimap"
                  hint="A tick per message you sent in the left gutter. Hover to preview, click to jump."
                  control={(
                    <SettingsToggle
                      label="User message minimap"
                      checked={chatUserMinimapEnabled}
                      onChange={setChatUserMinimapEnabled}
                    />
                  )}
                />
                <ModernRow
                  anchor="drafts-button"
                  title="Prompt stash button"
                  hint="The bookmark beside the context meter. ⌘S works either way."
                  control={(
                    <SettingsToggle
                      label="Prompt stash button"
                      checked={draftsButtonEnabled}
                      onChange={setDraftsButtonEnabled}
                    />
                  )}
                />
              </ModernRows>
            </ModernSection>

            <LaunchPromptSection />

            {/* Voice input is chat dictation, so it lives with chat. */}
            <DictationSection />

            {/* Spoken conversations with a chat, carried by Codex voice. */}
            <VoiceConversationSection />
          </div>

          <aside
            className="ade-cs-aside"
            id="appearance-preview"
            data-settings-anchor="appearance-preview"
          >
            <div className="ade-cs-aside-head">
              <span className="kit-eyebrow">Preview</span>
              <PreviewProviderPicker value={previewProvider} onChange={setPreviewProvider} />
            </div>
            <div className="ade-cs-preview">
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
            <div className="ade-cs-aside-foot">
              <span className="kit-eyebrow">
                {PREVIEW_PROVIDER_META[previewProvider].name} · <span className="kit-num">{chatFontSizePx}px</span> · {TRANSCRIPT_DENSITY_LABEL[chatTranscriptDensity]}
              </span>
            </div>
          </aside>
        </div>
      </div>
    </SettingsColumn>
  );
}

/* ── Text size ──────────────────────────────────────────────────────── */

function FontSizeControl({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const span = CHAT_FONT_SIZE_MAX_PX - CHAT_FONT_SIZE_MIN_PX;
  const fill = span > 0 ? ((value - CHAT_FONT_SIZE_MIN_PX) / span) * 100 : 0;
  return (
    <div className="ade-cs-size">
      <div className="ade-cs-size-sample" style={{ fontSize: value }}>
        Ship the lane, then open the PR.
      </div>
      <div className="ade-cs-size-row">
        <span className="ade-cs-size-a" style={{ fontSize: 11 }} aria-hidden>A</span>
        <input
          type="range"
          min={CHAT_FONT_SIZE_MIN_PX}
          max={CHAT_FONT_SIZE_MAX_PX}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Chat font size"
          className="ade-cs-range"
          style={{ "--ade-cs-fill": `${fill}%` } as React.CSSProperties}
        />
        <span className="ade-cs-size-a" style={{ fontSize: 17 }} aria-hidden>A</span>
        <span className="kit-num ade-cs-size-value">{value}px</span>
      </div>
    </div>
  );
}

/* ── Choice cards ───────────────────────────────────────────────────── */

function ChoiceGrid<T extends string>({
  ariaLabel,
  value,
  options,
  label,
  onChange,
  art,
  columns = 3,
}: {
  ariaLabel: string;
  value: T;
  options: readonly T[];
  label: (id: T) => string;
  onChange: (next: T) => void;
  art: (id: T) => React.ReactNode;
  columns?: 2 | 3;
}) {
  return (
    <div className={columns === 2 ? "ade-cs-grid2" : "ade-ap-grid3"} role="radiogroup" aria-label={ariaLabel}>
      {options.map((id) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            className="ade-ap-choice"
            data-active={active}
            onClick={() => onChange(id)}
          >
            <div className="ade-cs-art" aria-hidden>{art(id)}</div>
            <div className="ade-ap-choice-foot">
              <span>{label(id)}</span>
              {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Gap between rows in each density, at a third of the real spacing. */
const DENSITY_ART_GAP: Record<ChatTranscriptDensity, number> = { compact: 2, comfortable: 5, spacious: 9 };

function DensityArt({ density }: { density: ChatTranscriptDensity }) {
  return (
    <div className="ade-cs-thread" style={{ gap: DENSITY_ART_GAP[density] }}>
      <span className="ade-cs-bubble" />
      <span className="ade-cs-line" style={{ width: "78%" }} />
      <span className="ade-cs-line" style={{ width: "56%" }} />
      <span className="ade-cs-bubble" style={{ width: "34%" }} />
      <span className="ade-cs-line" style={{ width: "66%" }} />
    </div>
  );
}

const CORNER_ART_RADIUS: Record<ChatShellGeometry, number> = { soft: 14, default: 8, sharp: 2 };

function CornersArt({ geometry }: { geometry: ChatShellGeometry }) {
  return (
    <div className="ade-cs-window" style={{ borderRadius: CORNER_ART_RADIUS[geometry] }}>
      <span className="ade-cs-window-head" />
      <span className="ade-cs-line" style={{ width: "60%" }} />
      <span className="ade-cs-line" style={{ width: "42%" }} />
    </div>
  );
}

const TINT_ART_RUNTIMES = ["claude", "codex", "opencode"] as const;

function TintArt({ tint }: { tint: ChatChromeTint }) {
  return (
    <div className="ade-cs-tints">
      {TINT_ART_RUNTIMES.map((runtime) => {
        const accent = PROVIDER_CHAT_ACCENTS[runtime] ?? "var(--color-accent)";
        const colored = tint === "colored";
        return (
          <div
            key={runtime}
            className="ade-cs-tint"
            style={colored ? {
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              borderColor: `color-mix(in srgb, ${accent} 38%, transparent)`,
            } : undefined}
          >
            <i style={{ background: colored ? accent : undefined }} />
            <span className="ade-cs-line" style={{ width: "55%" }} />
          </div>
        );
      })}
    </div>
  );
}

function CopyArt({ position }: { position: CodeBlockCopyButtonPosition }) {
  return (
    <div className="ade-cs-code" data-position={position}>
      <span className="ade-cs-code-line" style={{ width: "64%" }} />
      <span className="ade-cs-code-line" style={{ width: "48%", marginLeft: 8 }} />
      <span className="ade-cs-code-line" style={{ width: "56%", marginLeft: 8 }} />
      <span className="ade-cs-code-line" style={{ width: "30%" }} />
      <span className="ade-cs-code-copy"><Copy size={9} weight="bold" /></span>
    </div>
  );
}

/* ── Preview runtime picker ─────────────────────────────────────────── */

/** The runtime the preview draws, picked from a strip of runtime logos. */
function PreviewProviderPicker({
  value,
  onChange,
}: {
  value: PreviewProviderKey;
  onChange: (value: PreviewProviderKey) => void;
}) {
  return (
    <div className="kit-seg ade-cs-runtimes" role="radiogroup" aria-label="Preview runtime">
      {PREVIEW_PROVIDER_KEYS.map((key) => {
        const meta = PREVIEW_PROVIDER_META[key];
        const selected = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Preview runtime: ${meta.name}`}
            title={meta.name}
            onClick={() => onChange(key)}
          >
            <meta.Logo size={13} />
          </button>
        );
      })}
    </div>
  );
}
