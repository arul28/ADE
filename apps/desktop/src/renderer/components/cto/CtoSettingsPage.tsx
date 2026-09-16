import React, { useRef, useState } from "react";
import {
  ArrowLeft,
  ClockCounterClockwise,
  Cpu,
  FileText,
  IdentificationCard,
  Microphone,
  Notebook,
} from "@phosphor-icons/react";

import type { CtoIdentity, CtoSessionLogEntry, CtoStartFreshSessionResult } from "../../../shared/types";
import { CTO_VOICE_DEFAULT, CTO_VOICE_VOICES } from "../../../shared/types/ctoVoice";
import { getModelById } from "../../../shared/modelRegistry";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { OpenAiKeySection } from "../settings/OpenAiKeySection";
import { SettingsSectionShell, SettingsToggle } from "../settings/settingsSectionUi";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import {
  formatTokenCount,
  providerLabel,
  reasoningEffortLabel,
  runsOnLabel,
} from "../shared/ModelPicker/modelFacts";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { CtoHistoryList } from "./CtoHistoryList";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { CTO_SECTION_COLORS, CtoCard, FactRow, ctoButtonStyle, type CtoSectionKey } from "./ctoSettingsUi";
import { ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";

/**
 * The CTO's settings, in the same visual language as the rest of Settings.
 *
 * Every section opens with the Settings section header — a 42px accent tile,
 * a title, one line saying what the section is for — and everything under it
 * is a Settings card. The page fills the width it is given rather than a
 * hand-set column, because the two surfaces sitting side by side in the same
 * app should not look like two products.
 */

const SECTIONS: Array<{
  id: CtoSectionKey;
  label: string;
  icon: React.ElementType;
  title: string;
  description: string;
}> = [
  {
    id: "identity",
    label: "Identity",
    icon: IdentificationCard,
    title: "Identity",
    description: "Set what the CTO is called and what it should always keep in mind.",
  },
  {
    id: "model",
    label: "Model",
    icon: Cpu,
    title: "Model",
    description: "The CTO thinks with this model, and only models that handle interruptions are listed.",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Microphone,
    title: "Voice calls",
    description: "Calls use your own OpenAI key, and the CTO still thinks with the model you picked.",
  },
  {
    id: "memory",
    label: "Memory",
    icon: Notebook,
    title: "Memory",
    description: "The CTO keeps these notes between turns and after you switch models.",
  },
  {
    id: "prompt",
    label: "Prompt",
    icon: FileText,
    title: "Prompt",
    description: "Everything the CTO is sent, assembled into one document.",
  },
  {
    id: "history",
    label: "History",
    icon: ClockCounterClockwise,
    title: "History",
    description: "Every session this CTO has run in this project.",
  },
];

/**
 * How many voice tiles sit in a row.
 *
 * Ten voices, five columns: two full rows, no tile left alone on a line, and
 * no tile 460px wide holding one word — which is what two columns became once
 * the page stopped being a 560px strip. It must divide `CTO_VOICE_VOICES`;
 * the test beside it is what says so.
 */
export const VOICE_GRID_COLUMNS = 5;

const inputStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 340,
  height: 34,
  padding: "0 10px",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 8,
  fontFamily: SANS_FONT,
  fontSize: 13,
  color: COLORS.textPrimary,
  outline: "none",
};

/**
 * What the chosen model actually is.
 *
 * Every fact comes from the descriptor through `modelFacts`, so this card and
 * the picker rows cannot disagree about the same model.
 */
function ModelFacts({
  modelId,
  reasoningEffort,
  fastMode,
}: {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
}) {
  const model = getModelById(modelId);
  if (!model) return null;
  const context = formatTokenCount(model.contextWindow);
  return (
    <dl
      data-testid="cto-model-facts"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 110px) minmax(0, 1fr)",
        gap: "7px 16px",
        margin: "14px 0 0",
        paddingTop: 14,
        borderTop: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      <FactRow label="Model" value={model.displayName} />
      <FactRow label="Provider" value={providerLabel(model.family)} />
      {context ? <FactRow label="Context" value={`${context} tokens`} /> : null}
      <FactRow label="Reasoning" value={reasoningEffortLabel(reasoningEffort, model)} />
      <FactRow label="Fast mode" value={fastMode ? "On" : "Off"} />
      <FactRow label="Runs on" value={runsOnLabel(model)} />
    </dl>
  );
}

/**
 * The sentence the confirm has to say out loud.
 *
 * Retiring a thread reads like a delete until someone tells you it is not one,
 * so the confirm step does not ask "are you sure" — it says what survives.
 */
export const CTO_FRESH_SESSION_CONFIRM =
  "Everything the CTO remembers is kept, and this conversation stays in History. Only the live thread starts over.";

/** What the hand-off actually turned out to be, in one line. */
export function describeFreshSessionResult(handoff: CtoStartFreshSessionResult["handoff"]): string {
  if (handoff.thin) {
    return "Fresh session started. The hand-off note was thin, so the old conversation is still in History in full.";
  }
  if (handoff.written && handoff.source === "model") {
    return "Fresh session started. The CTO wrote a hand-off note.";
  }
  if (handoff.written && handoff.source === "deterministic") {
    return "Fresh session started. ADE distilled a hand-off from the transcript.";
  }
  return "Fresh session started. There was no hand-off to write, and the old conversation is still in History.";
}

/**
 * The way out of a thread that has run out of room.
 *
 * It sits under Model rather than Identity because this is a fact about the
 * live thread — the same thing the card above it is talking about when it says
 * switching models keeps the thread — and not about who the CTO is.
 *
 * Two-step confirm on the button, the way Secrets confirms a plaintext export:
 * no dialog, and no `window.confirm`, which an Electron renderer should never
 * reach for.
 */
function FreshSessionCard({
  accent,
  onStartFreshSession,
}: {
  accent: string;
  onStartFreshSession: () => Promise<CtoStartFreshSessionResult>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const next = await onStartFreshSession();
      setResult(describeFreshSessionResult(next.handoff));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a fresh session.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CtoCard
      title="Start a fresh session"
      description="Keeps everything the CTO remembers. Only the conversation starts over."
      accent={accent}
      testId="cto-fresh-session-card"
    >
      {confirming ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p
            data-testid="cto-fresh-session-confirm-text"
            style={{
              margin: 0,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: COLORS.textSecondary,
            }}
          >
            {CTO_FRESH_SESSION_CONFIRM}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              data-testid="cto-fresh-session-confirm"
              onClick={() => void run()}
              style={ctoButtonStyle("primary")}
            >
              Yes, start fresh
            </button>
            <button
              type="button"
              data-testid="cto-fresh-session-cancel"
              onClick={() => setConfirming(false)}
              style={ctoButtonStyle()}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="cto-fresh-session-start"
          disabled={busy}
          onClick={() => setConfirming(true)}
          style={{ ...ctoButtonStyle(), cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Starting a fresh session…" : "Start a fresh session"}
        </button>
      )}

      {result ? (
        <p
          data-testid="cto-fresh-session-result"
          role="status"
          style={{
            margin: "12px 0 0",
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            lineHeight: 1.6,
            color: COLORS.textMuted,
          }}
        >
          {result}
        </p>
      ) : null}

      {error ? (
        <p
          data-testid="cto-fresh-session-error"
          role="status"
          style={{
            margin: "12px 0 0",
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            lineHeight: 1.6,
            color: COLORS.warning,
          }}
        >
          {error}
        </p>
      ) : null}
    </CtoCard>
  );
}

export type CtoSettingsPageProps = {
  identity: CtoIdentity | null;
  sessionLogs: CtoSessionLogEntry[];
  currentModelId: string;
  currentReasoningEffort: string | null;
  currentFastMode: boolean;
  availableModelIds: string[];
  loadingModels: boolean;
  switchingModel: boolean;
  onModelChange: (modelId: string, reasoningEffort: string | null) => void;
  onFastModeChange: (enabled: boolean) => void;
  onOpenProviderSettings: () => void;
  /**
   * Every field on this page is one field of the CTO's identity, voice
   * included, and they all go to `cto.updateIdentity`. Two props pointed at
   * the same handler only made it look as though there were two ways in.
   */
  /**
   * Retire the live thread and open a new one, hand-off and all.
   *
   * A prop rather than a `window.ade` call inside the page, the way every
   * other action here is: `CtoPage` owns the bridge and this page draws.
   */
  onStartFreshSession?: () => Promise<CtoStartFreshSessionResult>;
  onIdentityChange: (patch: {
    name?: string;
    systemPromptExtension?: string;
    voiceName?: string;
    voiceBackchannels?: boolean;
  }) => void;
  onClose: () => void;
};

export function CtoSettingsPage({
  identity,
  sessionLogs,
  currentModelId,
  currentReasoningEffort,
  currentFastMode,
  availableModelIds,
  loadingModels,
  switchingModel,
  onModelChange,
  onFastModeChange,
  onOpenProviderSettings,
  onStartFreshSession,
  onIdentityChange,
  onClose,
}: CtoSettingsPageProps) {
  const [section, setSection] = useState<CtoSectionKey>("model");
  const [name, setName] = useState(identity?.name ?? "");
  const [extra, setExtra] = useState(identity?.systemPromptExtension ?? "");
  const savedRef = useRef({ name: identity?.name ?? "", extra: identity?.systemPromptExtension ?? "" });
  const dirty = name !== savedRef.current.name || extra !== savedRef.current.extra;

  /** A model is actually configured, so there are facts worth printing. */
  const modelReady = !loadingModels && availableModelIds.length > 0;

  const voiceName = identity?.voiceName ?? CTO_VOICE_DEFAULT;
  const backchannels = identity?.voiceBackchannels !== false;
  const accent = CTO_SECTION_COLORS[section];

  const saveIdentity = () => {
    const trimmed = name.trim();
    onIdentityChange({ name: trimmed, systemPromptExtension: extra });
    savedRef.current = { name: trimmed, extra };
    setName(trimmed);
  };

  /**
   * One pane per rail entry, keyed by the same id.
   *
   * A `Record` rather than a chain of six ternaries: the type will not let a
   * section exist in the rail with no pane behind it, and two panes cannot
   * render at once. Building the elements is free — only the selected one is
   * mounted.
   */
  const panes: Record<CtoSectionKey, React.ReactNode> = {
    identity: (
      <div style={{ display: "grid", gap: 16 }}>
        <CtoCard title="Name" description="What the CTO is called everywhere in ADE." accent={accent}>
          <input
            id="cto-name"
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="CTO"
            style={inputStyle}
          />
        </CtoCard>

        <CtoCard
          title="Standing instructions"
          description="The CTO reads this on every turn, on top of ADE's own built-in rules."
          accent={accent}
        >
          <textarea
            id="cto-extra"
            aria-label="Standing instructions"
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
            rows={8}
            spellCheck={false}
            placeholder="We ship on Fridays. Never touch the billing service without telling me first."
            style={{
              width: "100%",
              maxWidth: 720,
              minHeight: 150,
              maxHeight: 360,
              resize: "vertical",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 10,
              padding: 12,
              fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
              fontSize: 12,
              lineHeight: 1.7,
              color: COLORS.textPrimary,
              outline: "none",
            }}
          />
        </CtoCard>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            disabled={!dirty}
            onClick={saveIdentity}
            style={{
              ...ctoButtonStyle(dirty ? "primary" : "quiet"),
              height: 32,
              cursor: dirty ? "pointer" : "default",
              opacity: dirty ? 1 : 0.5,
            }}
          >
            Save
          </button>
          {dirty ? (
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
              Unsaved changes
            </span>
          ) : null}
        </div>
      </div>
    ),

    model: (
      <div style={{ display: "grid", gap: 16 }}>
      <CtoCard
        title="Thinking model"
        description="Switching models keeps the thread and everything the CTO remembers."
        accent={accent}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <ModelPicker
            value={currentModelId}
            availableModelIds={availableModelIds}
            filter={ctoModelSupportsLiveRedirect}
            disabled={switchingModel}
            fastModeActive={currentFastMode}
            onFastModeToggle={onFastModeChange}
            onChange={(modelId) => onModelChange(modelId, currentReasoningEffort)}
            onOpenSignIn={onOpenProviderSettings}
          />
          <ReasoningEffortPicker
            modelId={currentModelId}
            reasoningEffort={currentReasoningEffort}
            onChange={(effort) => onModelChange(currentModelId, effort)}
          />
        </div>

        {modelReady ? (
          <ModelFacts
            modelId={currentModelId}
            reasoningEffort={currentReasoningEffort}
            fastMode={currentFastMode}
          />
        ) : null}

        {loadingModels ? (
          <p style={{ margin: "12px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
            Checking which models are set up…
          </p>
        ) : availableModelIds.length === 0 ? (
          <p
            style={{
              margin: "12px 0 0",
              padding: "10px 12px",
              borderRadius: 10,
              fontFamily: SANS_FONT,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: COLORS.warning,
              background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 26%, transparent)",
            }}
          >
            No model is set up yet. Sign in to Claude, Codex, or Cursor under Settings → AI → Providers.
          </p>
        ) : switchingModel ? (
          <p style={{ margin: "12px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
            Moving the thread to the new model…
          </p>
        ) : null}
      </CtoCard>
      {onStartFreshSession ? (
        <FreshSessionCard accent={accent} onStartFreshSession={onStartFreshSession} />
      ) : null}
      </div>
    ),

    voice: (
      <div style={{ display: "grid", gap: 16 }}>
        <OpenAiKeySection />

        <CtoCard
          title="Voice"
          description="The CTO speaks with this voice on your next call."
          accent={accent}
        >
          <div
            role="radiogroup"
            aria-label="Voice"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${VOICE_GRID_COLUMNS}, minmax(0, 1fr))`,
              gap: 8,
            }}
          >
            {CTO_VOICE_VOICES.map((option) => {
              const selected = voiceName === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onIdentityChange({ voiceName: option })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    textAlign: "left",
                    textTransform: "capitalize",
                    cursor: "pointer",
                    fontFamily: SANS_FONT,
                    fontSize: 12.5,
                    color: selected ? COLORS.textPrimary : COLORS.textSecondary,
                    background: selected ? `color-mix(in srgb, ${accent} 14%, transparent)` : COLORS.recessedBg,
                    border: `1px solid ${selected ? accent : COLORS.borderMuted}`,
                    transition: "background 140ms ease, border-color 140ms ease",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      flexShrink: 0,
                      background: selected ? accent : COLORS.outlineBorder,
                    }}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {option}
                  </span>
                </button>
              );
            })}
          </div>
        </CtoCard>

        <CtoCard
          title="Thinking out loud"
          description={
            backchannels
              ? "The CTO says a word while it looks something up."
              : "The CTO stays quiet until it has your answer."
          }
          accent={accent}
          right={
            <SettingsToggle
              id="cto-backchannels"
              checked={backchannels}
              onChange={(next) => onIdentityChange({ voiceBackchannels: next })}
            />
          }
        />
      </div>
    ),

    memory: <CtoMemoryPanel accent={accent} />,

    prompt: <CtoPromptPreview accent={accent} />,

    history: (
      <CtoCard padded={false} accent={accent}>
        <div style={{ padding: 8 }}>
          <CtoHistoryList sessions={sessionLogs} />
        </div>
      </CtoCard>
    ),
  };

  const activeSection = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0]!;
  const ActiveIcon = activeSection.icon;

  return (
    <div className="flex min-h-0 flex-1" data-testid="cto-settings-page">
      <nav
        aria-label="CTO settings sections"
        style={{
          width: 196,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: `1px solid ${COLORS.borderMuted}`,
          background: "color-mix(in srgb, var(--color-bg) 92%, #000 8%)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "8px 8px 0",
            padding: "8px 10px",
            borderRadius: 8,
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 500,
            color: COLORS.textMuted,
            cursor: "pointer",
          }}
        >
          <ArrowLeft size={13} weight="bold" />
          Back to the thread
        </button>
        <div style={{ height: 1, margin: "8px 12px", background: COLORS.borderMuted }} />
        <div style={{ display: "grid", gap: 2, padding: "0 8px 12px" }}>
          {SECTIONS.map((entry) => {
            const Icon = entry.icon;
            const selected = entry.id === section;
            const entryAccent = CTO_SECTION_COLORS[entry.id];
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSection(entry.id)}
                aria-current={selected ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
                  borderRadius: 8,
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: SANS_FONT,
                  fontSize: 12.5,
                  fontWeight: selected ? 600 : 500,
                  color: selected ? COLORS.textPrimary : COLORS.textMuted,
                  background: selected ? `color-mix(in srgb, ${entryAccent} 13%, transparent)` : "transparent",
                }}
              >
                <Icon
                  size={15}
                  weight={selected ? "fill" : "regular"}
                  style={{ color: selected ? entryAccent : COLORS.textDim, flexShrink: 0 }}
                />
                {entry.label}
                {entry.id === "history" && sessionLogs.length > 0 ? (
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: COLORS.textDim }}>
                    {sessionLogs.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto", background: COLORS.pageBg, padding: 24 }}>
        {/* Same ceiling as a Settings tab: wide enough to use the window, short
            enough that a line of prose stays readable. */}
        <div style={{ maxWidth: 960 }}>
          <SettingsSectionShell
            key={activeSection.id}
            id={`cto-${activeSection.id}`}
            title={activeSection.title}
            description={activeSection.description}
            iconNode={<ActiveIcon size={22} weight="duotone" style={{ color: accent }} />}
            brandColor={accent}
          >
            {panes[section]}
          </SettingsSectionShell>
        </div>
      </div>
    </div>
  );
}
