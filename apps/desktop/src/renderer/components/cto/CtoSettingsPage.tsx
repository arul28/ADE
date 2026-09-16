import React, { useRef, useState } from "react";
import {
  ArrowLeft,
  CaretRight,
  ClockCounterClockwise,
  Cpu,
  FileText,
  IdentificationCard,
  Microphone,
  Notebook,
} from "@phosphor-icons/react";

import type { CtoIdentity, CtoSessionLogEntry } from "../../../shared/types";
import { CTO_VOICE_DEFAULT, CTO_VOICE_VOICES } from "../../../shared/types/ctoVoice";
import { cn } from "../ui/cn";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { TimelineEntry } from "./shared/TimelineEntry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";
import { OpenAiKeySection } from "../settings/OpenAiKeySection";

/**
 * The CTO's settings.
 *
 * Three rules this surface is built on, each one a thing the first attempt got
 * wrong:
 *
 *  - The rail carries LABELS, not descriptions. A one-line hint under every
 *    entry truncated at "What it remembers between tur…", which is worse than
 *    saying nothing. The explanation belongs in the pane, where there is room.
 *  - Content is left-aligned against the rail. Centring it left a hand-width
 *    of dead space between the two and made the page read as floating.
 *  - One column width for every control. A 300px name field above a
 *    full-bleed textarea is two designs on one screen.
 */

const ACCENT = "#22D3EE";
const ACCENT_RGB = "34, 211, 238";

type SectionId = "identity" | "model" | "voice" | "memory" | "prompt" | "history";

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ElementType }> = [
  { id: "identity", label: "Identity", icon: IdentificationCard },
  { id: "model", label: "Model", icon: Cpu },
  { id: "voice", label: "Voice", icon: Microphone },
  { id: "memory", label: "Memory", icon: Notebook },
  { id: "prompt", label: "Prompt", icon: FileText },
  { id: "history", label: "History", icon: ClockCounterClockwise },
];

/** One column width, so nothing on the page disagrees about where it ends. */
const COLUMN = "w-full max-w-[560px]";

function Pane({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <div className="px-9 py-8">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
      <p className={cn("mt-1.5 text-[12.5px] leading-[1.65] text-muted-fg/55", COLUMN)}>{lede}</p>
      <div className="mt-7">{children}</div>
    </div>
  );
}

/** Label, optional explanation, then the control — in that order, every time. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mb-7 last:mb-0", COLUMN)}>
      <label htmlFor={htmlFor} className="block text-[12.5px] font-medium text-fg/90">
        {label}
      </label>
      {hint ? <p className="mt-1 text-[11.5px] leading-[1.6] text-muted-fg/45">{hint}</p> : null}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/[0.09] bg-white/[0.025] px-3 py-2 text-[13px] text-fg outline-none transition-colors placeholder:text-muted-fg/25 focus:border-white/[0.22] focus:bg-white/[0.04]";

/** A block you read rather than set, so it stays shut until it is asked for. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.015]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        <CaretRight
          size={12}
          weight="bold"
          className={cn("shrink-0 text-muted-fg/45 transition-transform", open && "rotate-90")}
        />
        <span className="text-[12.5px] font-medium text-fg/85">{label}</span>
      </button>
      {open ? <div className="border-t border-white/[0.06] px-4 py-4">{children}</div> : null}
    </div>
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
  onIdentityChange: (patch: { name?: string; systemPromptExtension?: string }) => void;
  onVoiceChange: (patch: { voiceName?: string; voiceBackchannels?: boolean }) => void;
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
  onIdentityChange,
  onVoiceChange,
  onClose,
}: CtoSettingsPageProps) {
  const [section, setSection] = useState<SectionId>("identity");
  const [name, setName] = useState(identity?.name ?? "");
  const [extra, setExtra] = useState(identity?.systemPromptExtension ?? "");
  const savedRef = useRef({ name: identity?.name ?? "", extra: identity?.systemPromptExtension ?? "" });
  const dirty = name !== savedRef.current.name || extra !== savedRef.current.extra;

  const voiceName = identity?.voiceName ?? CTO_VOICE_DEFAULT;
  const backchannels = identity?.voiceBackchannels !== false;

  return (
    <div className="flex min-h-0 flex-1" data-testid="cto-settings-page">
      <nav
        aria-label="CTO settings sections"
        className="flex w-[196px] shrink-0 flex-col border-r border-white/[0.06] bg-black/[0.18]"
      >
        <button
          type="button"
          onClick={onClose}
          className="mx-2 mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium text-muted-fg/55 transition-colors hover:bg-white/[0.04] hover:text-fg"
        >
          <ArrowLeft size={13} weight="bold" />
          Back to the thread
        </button>
        <div className="mx-3 my-2 h-px bg-white/[0.07]" />
        <div className="flex flex-col gap-px px-2 pb-3">
          {SECTIONS.map((entry) => {
            const Icon = entry.icon;
            const selected = entry.id === section;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSection(entry.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-lg py-[7px] pl-3 pr-2.5 text-left text-[12.5px] transition-colors",
                  selected
                    ? "font-medium text-fg"
                    : "text-muted-fg/60 hover:bg-white/[0.035] hover:text-fg/85",
                )}
                style={selected ? { background: `rgba(${ACCENT_RGB},0.10)` } : undefined}
              >
                {selected ? (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-[15px] w-[2px] -translate-y-1/2 rounded-r"
                    style={{ background: ACCENT }}
                  />
                ) : null}
                <Icon size={15} style={selected ? { color: ACCENT } : undefined} className="shrink-0" />
                {entry.label}
                {entry.id === "history" && sessionLogs.length > 0 ? (
                  <span className="ml-auto text-[10.5px] tabular-nums text-muted-fg/35">
                    {sessionLogs.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "identity" ? (
          <Pane title="Identity" lede="What the CTO is called, and anything it should always keep in mind.">
            <Field label="Name" htmlFor="cto-name">
              <input
                id="cto-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CTO"
                className={inputCls}
              />
            </Field>

            <Field
              label="Standing instructions"
              htmlFor="cto-extra"
              hint="Added to every turn, on top of ADE's own doctrine — which is fixed and not editable here."
            >
              <textarea
                id="cto-extra"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                rows={8}
                placeholder="We ship on Fridays. Never touch the billing service without telling me first."
                className={cn(inputCls, "resize-y font-mono text-[12px] leading-[1.65]")}
              />
            </Field>

            <div className={cn("flex items-center gap-3", COLUMN)}>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  const trimmed = name.trim();
                  onIdentityChange({ name: trimmed, systemPromptExtension: extra });
                  savedRef.current = { name: trimmed, extra };
                  setName(trimmed);
                }}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-all",
                  dirty
                    ? "text-black"
                    : "cursor-default border border-white/[0.08] text-muted-fg/35",
                )}
                style={dirty ? { background: ACCENT } : undefined}
              >
                Save
              </button>
              {dirty ? <span className="text-[11.5px] text-muted-fg/45">Unsaved changes</span> : null}
            </div>
          </Pane>
        ) : null}

        {section === "model" ? (
          <Pane
            title="Model"
            lede="Only models that can steer a live turn — the CTO is interrupted constantly."
          >
            <Field label="Thinks with">
              <div className="flex flex-wrap items-center gap-2">
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
              {loadingModels ? (
                <p className="mt-3 text-[11.5px] text-muted-fg/40">Checking configured models…</p>
              ) : availableModelIds.length === 0 ? (
                <p className="mt-3 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2.5 text-[11.5px] leading-[1.6] text-amber-200/90">
                  No model the CTO can run on is configured yet. Sign in to Claude, Codex, or Cursor under
                  Settings → AI → Providers.
                </p>
              ) : switchingModel ? (
                <p className="mt-3 text-[11.5px] text-muted-fg/45">Moving the thread to the new model…</p>
              ) : null}
            </Field>
          </Pane>
        ) : null}

        {section === "voice" ? (
          <Pane
            title="Voice"
            lede="Talking to the CTO runs on your own OpenAI key. Its thinking stays on the model you picked."
          >
            <div className={cn("mb-7", COLUMN)}>
              <OpenAiKeySection />
            </div>

            <Field
              label="How it sounds"
              hint="Ten voices ship with GPT Live. They differ in pitch and pace, not in what the CTO says. Applies to the next call."
            >
              <div className="flex flex-wrap gap-1.5">
                {CTO_VOICE_VOICES.map((option) => {
                  const selected = voiceName === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onVoiceChange({ voiceName: option })}
                      className={cn(
                        "rounded-full border px-3 py-1 text-[11.5px] capitalize transition-colors",
                        selected
                          ? "text-black"
                          : "border-white/[0.09] text-muted-fg/60 hover:bg-white/[0.04] hover:text-fg/85",
                      )}
                      style={selected ? { background: ACCENT, borderColor: ACCENT } : undefined}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Listening noises">
              <button
                type="button"
                role="switch"
                aria-checked={backchannels}
                onClick={() => onVoiceChange({ voiceBackchannels: !backchannels })}
                className="flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.015] px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
              >
                <span
                  aria-hidden
                  className={cn(
                    "relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors",
                    backchannels ? "" : "bg-white/[0.12]",
                  )}
                  style={backchannels ? { background: ACCENT } : undefined}
                >
                  <span
                    className={cn(
                      "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all",
                      backchannels ? "left-[16px]" : "left-[2px]",
                    )}
                  />
                </span>
                <span className="text-[11.5px] leading-[1.6] text-muted-fg/60">
                  {backchannels
                    ? "The CTO murmurs while you talk, the way a person does."
                    : "The CTO waits in silence until you have finished."}
                </span>
              </button>
            </Field>
          </Pane>
        ) : null}

        {section === "memory" ? (
          <Pane title="Memory" lede="What the CTO carries between turns, model switches and compactions.">
            <div className={COLUMN}>
              <CtoMemoryPanel />
            </div>
          </Pane>
        ) : null}

        {section === "prompt" ? (
          <Pane title="Prompt" lede="Everything the CTO is sent, assembled. Read-only.">
            <div className={COLUMN}>
              <Disclosure label="Preview effective prompt">
                <CtoPromptPreview compact />
              </Disclosure>
            </div>
          </Pane>
        ) : null}

        {section === "history" ? (
          <Pane title="History" lede="Sessions this CTO has run in this project.">
            <div className={COLUMN}>
              {sessionLogs.length === 0 ? (
                <p className="text-[12px] text-muted-fg/40">No sessions yet.</p>
              ) : (
                <div className="space-y-1" data-testid="session-history-list">
                  {sessionLogs.map((session) => (
                    <TimelineEntry
                      key={session.id}
                      timestamp={session.createdAt}
                      title={session.summary}
                      status={session.capabilityMode}
                      statusVariant={session.capabilityMode === "full_tooling" ? "success" : "muted"}
                    />
                  ))}
                </div>
              )}
            </div>
          </Pane>
        ) : null}
      </div>
    </div>
  );
}
