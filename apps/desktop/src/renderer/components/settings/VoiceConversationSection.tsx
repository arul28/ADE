import React, { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  CODEX_VOICE_NAMES,
  type CodexVoiceName,
  type CodexVoicePersonality,
  type CodexVoiceUpdateLevel,
} from "../../../shared/codexVoice";
import {
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsSelect,
  SettingsTextField,
  SettingsToggle,
  type SegmentedOption,
} from "./primitives";

const PERSONALITY_OPTIONS: readonly SegmentedOption<CodexVoicePersonality>[] = [
  { value: "playful", label: "Playful", hint: "Codex default" },
  { value: "calm", label: "Calm" },
  { value: "focused", label: "Focused" },
  { value: "coach", label: "Coach" },
  { value: "custom", label: "Custom" },
];

const UPDATE_OPTIONS: readonly SegmentedOption<CodexVoiceUpdateLevel>[] = [
  { value: "chatty", label: "Often" },
  { value: "balanced", label: "Sometimes" },
  { value: "quiet", label: "Only results" },
];

const VOICE_OPTIONS = CODEX_VOICE_NAMES.map((name) => ({
  value: name,
  label: name === "cove" ? "Cove (default)" : name.charAt(0).toUpperCase() + name.slice(1),
}));

/** A text field that saves on blur, so each keystroke does not write the preference. */
function DraftTextField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <SettingsTextField
      value={draft}
      onChange={setDraft}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
      }}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
    />
  );
}

/** A sentence-case segmented radio strip in the surface-kit style. */
function SegRadio<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label={ariaLabel} style={{ flexWrap: "wrap" }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Voice conversations: talk with any chat. Voice runs on the user's Codex
 * (ChatGPT) sign-in; these settings shape how it sounds and behaves. They sync
 * with the ADE account and apply from the next conversation.
 */
export function VoiceConversationSection() {
  const preferences = useAppStore((s) => s.codexVoice);
  const update = useAppStore((s) => s.setCodexVoicePreferences);

  return (
    <ModernSection
      group="Voice conversations"
      title="Voice conversations"
      hint="Talk with a chat out loud. Runs on your Codex sign-in and applies from the next conversation."
    >
      <ModernRows>
        <ModernRow
          anchor="voice-conversations"
          title="Talk with chats"
          hint={(
            <>
              A waveform button in every chat's prompt box. Needs ChatGPT Plus or higher and uses your Codex usage at
              about <span className="kit-num">$0.05</span> a minute. The chat's own work is billed to its own provider.
            </>
          )}
          control={(
            <SettingsToggle
              label="Show the voice button in chats"
              checked={preferences.enabled}
              onChange={(enabled) => update({ enabled })}
            />
          )}
        />
        <ModernRow
          title="Personality"
          hint="How voice talks. Playful is Codex's own style."
          control={(
            <SegRadio
              ariaLabel="Voice personality"
              value={preferences.personality}
              options={PERSONALITY_OPTIONS}
              onChange={(personality) => update({ personality })}
            />
          )}
        >
          {preferences.personality === "custom" ? (
            <div style={{ marginTop: 12 }}>
              <DraftTextField
                value={preferences.customPersonality}
                onCommit={(customPersonality) => update({ customPersonality })}
                placeholder="For example: dry British humour, short answers, calls bugs 'gremlins'"
                ariaLabel="Custom voice personality"
              />
            </div>
          ) : null}
        </ModernRow>
        <ModernRow
          title="Voice"
          hint="The voice Codex speaks with."
          control={(
            <SettingsSelect<CodexVoiceName>
              ariaLabel="Voice"
              value={preferences.voice}
              options={VOICE_OPTIONS}
              onChange={(voice) => update({ voice })}
            />
          )}
        />
        <ModernRow
          title="Progress updates"
          hint="How often voice says what the agent is doing."
          control={(
            <SegRadio
              ariaLabel="Progress updates"
              value={preferences.updates}
              options={UPDATE_OPTIONS}
              onChange={(updates) => update({ updates })}
            />
          )}
        />
        <ModernRow title="Name and language" hint="Empty uses your Mac account's first name and the language you speak.">
          <div className="ade-voice-fields">
            <label className="ade-ap-field">
              <span className="kit-eyebrow">Call me</span>
              <DraftTextField
                value={preferences.preferredName}
                onCommit={(preferredName) => update({ preferredName })}
                placeholder="Your name"
                ariaLabel="What voice calls you"
              />
            </label>
            <label className="ade-ap-field">
              <span className="kit-eyebrow">Language</span>
              <DraftTextField
                value={preferences.language}
                onCommit={(language) => update({ language })}
                placeholder="For example: English"
                ariaLabel="Voice language"
              />
            </label>
          </div>
        </ModernRow>
      </ModernRows>
    </ModernSection>
  );
}
