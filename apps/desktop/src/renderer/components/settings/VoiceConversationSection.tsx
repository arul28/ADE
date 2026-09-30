import React, { useEffect, useState } from "react";
import { ChatCircleText, Waveform, UserCircle, Translate, SpeakerHigh, Sparkle } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import {
  CODEX_VOICE_NAMES,
  type CodexVoiceName,
  type CodexVoicePersonality,
  type CodexVoiceUpdateLevel,
} from "../../../shared/codexVoice";
import {
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
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

/**
 * Voice conversations: talk with any chat. Voice runs on the user's Codex
 * (ChatGPT) sign-in; these settings shape how it sounds and behaves. They sync
 * with the ADE account and apply from the next conversation.
 */
export function VoiceConversationSection() {
  const preferences = useAppStore((s) => s.codexVoice);
  const update = useAppStore((s) => s.setCodexVoicePreferences);

  return (
    <SettingsSection title="Voice conversations">
      <SettingsPanel>
        <SettingsRow
          anchor="voice-conversations"
          icon={<Waveform size={15} weight="duotone" />}
          tone="accent"
          title="Talk with chats"
          description="A waveform button in every chat's prompt box starts a spoken conversation with that chat. Voice runs on your Codex sign-in (ChatGPT Plus or higher) and uses your Codex usage at about $0.05 a minute. The chat's own work is billed to its own provider."
          control={(
            <SettingsToggle
              label="Show the voice button in chats"
              checked={preferences.enabled}
              onChange={(enabled) => update({ enabled })}
            />
          )}
        />
        <SettingsRow
          icon={<Sparkle size={15} weight="duotone" />}
          tone="violet"
          title="Personality"
          description="How voice talks. Playful is Codex's own style."
        >
          <SettingsSegmented
            ariaLabel="Voice personality"
            value={preferences.personality}
            options={PERSONALITY_OPTIONS}
            onChange={(personality) => update({ personality })}
          />
          {preferences.personality === "custom" ? (
            <div style={{ marginTop: 10 }}>
              <DraftTextField
                value={preferences.customPersonality}
                onCommit={(customPersonality) => update({ customPersonality })}
                placeholder="For example: dry British humour, short answers, calls bugs 'gremlins'"
                ariaLabel="Custom voice personality"
              />
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          icon={<SpeakerHigh size={15} weight="duotone" />}
          tone="blue"
          title="Voice"
          description="The voice Codex speaks with."
          control={(
            <SettingsSelect<CodexVoiceName>
              ariaLabel="Voice"
              value={preferences.voice}
              options={VOICE_OPTIONS}
              onChange={(voice) => update({ voice })}
            />
          )}
        />
        <SettingsRow
          icon={<ChatCircleText size={15} weight="duotone" />}
          tone="green"
          title="Progress updates"
          description="How often voice tells you what the agent is doing while it works."
        >
          <SettingsSegmented
            ariaLabel="Progress updates"
            value={preferences.updates}
            options={UPDATE_OPTIONS}
            onChange={(updates) => update({ updates })}
          />
        </SettingsRow>
        <SettingsRow
          icon={<UserCircle size={15} weight="duotone" />}
          tone="amber"
          title="Call me"
          description="Empty uses the first name of your Mac account."
        >
          <DraftTextField
            value={preferences.preferredName}
            onCommit={(preferredName) => update({ preferredName })}
            placeholder="Your name"
            ariaLabel="What voice calls you"
          />
        </SettingsRow>
        <SettingsRow
          icon={<Translate size={15} weight="duotone" />}
          tone="red"
          title="Language"
          description="Empty answers in the language you speak."
        >
          <DraftTextField
            value={preferences.language}
            onCommit={(language) => update({ language })}
            placeholder="For example: English"
            ariaLabel="Voice language"
          />
        </SettingsRow>
      </SettingsPanel>
    </SettingsSection>
  );
}
