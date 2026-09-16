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
import { getModelById } from "../../../shared/modelRegistry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import {
  formatTokenCount,
  providerLabel,
  reasoningEffortLabel,
  runsOnLabel,
} from "../shared/ModelPicker/modelFacts";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";
import { OpenAiKeySection } from "../settings/OpenAiKeySection";

/**
 * The CTO's settings. Three rules hold this surface together:
 *
 *  - The rail carries LABELS, not descriptions. A hint under a rail entry has
 *    nowhere to wrap and truncates; the explanation belongs in the pane.
 *  - Content is left-aligned against the rail, not centred in the pane.
 *  - One column width for every control, so a short field and a full-width
 *    textarea end at the same place.
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

/**
 * What the chosen model actually is.
 *
 * Every fact comes from the descriptor through `modelFacts`, so this card and
 * the picker rows cannot disagree about the same model.
 */
function ModelFactsCard({
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
  const rows: Array<{ label: string; value: string }> = [
    { label: "Provider", value: providerLabel(model.family) },
    ...(context ? [{ label: "Context", value: `${context} tokens` }] : []),
    { label: "Reasoning", value: reasoningEffortLabel(reasoningEffort, model) },
    { label: "Fast mode", value: fastMode ? "On" : "Off" },
    { label: "Runs on", value: runsOnLabel(model) },
  ];
  return (
    <div
      data-testid="cto-model-facts"
      className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.015] px-4 py-3.5"
    >
      <div className="truncate text-[12.5px] font-medium text-fg/90" title={model.displayName}>
        {model.displayName}
      </div>
      {/* One label column, so every value starts at the same x. */}
      <dl className="mt-2.5 grid grid-cols-[92px_minmax(0,1fr)] gap-x-4 gap-y-[7px]">
        {rows.map((row) => (
          <React.Fragment key={row.label}>
            <dt className="text-[11.5px] leading-[1.5] text-muted-fg/45">{row.label}</dt>
            <dd className="truncate text-[11.5px] leading-[1.5] text-fg/80" title={row.value}>
              {row.value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

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
  /**
   * Every field on this page is one field of the CTO's identity, voice
   * included, and they all go to `cto.updateIdentity`. Two props pointed at
   * the same handler only made it look as though there were two ways in.
   */
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
  onIdentityChange,
  onClose,
}: CtoSettingsPageProps) {
  const [section, setSection] = useState<SectionId>("model");
  const [name, setName] = useState(identity?.name ?? "");
  const [extra, setExtra] = useState(identity?.systemPromptExtension ?? "");
  const savedRef = useRef({ name: identity?.name ?? "", extra: identity?.systemPromptExtension ?? "" });
  const dirty = name !== savedRef.current.name || extra !== savedRef.current.extra;

  /** A model is actually configured, so there are facts worth printing. */
  const modelReady = !loadingModels && availableModelIds.length > 0;

  const voiceName = identity?.voiceName ?? CTO_VOICE_DEFAULT;
  const backchannels = identity?.voiceBackchannels !== false;

  /**
   * One pane per rail entry, keyed by the same id.
   *
   * A `Record` rather than a chain of six ternaries: the type will not let a
   * section exist in the rail with no pane behind it, and two panes cannot
   * render at once. Building the elements is free — only the selected one is
   * mounted.
   */
  const panes: Record<SectionId, React.ReactNode> = {
    identity: (
      <Pane title="Identity" lede="Set what the CTO is called and what it should always keep in mind.">
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
          hint="The CTO reads this on every turn, on top of ADE's own built-in rules."
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
    ),

    model: (
      <Pane
        title="Model"
        lede="The CTO thinks with this model, and only models that handle interruptions are listed."
      >
        {/* One control, and the pane is already titled "Model" — a field
            label here would print the same word twice down one column. */}
        <div className={COLUMN}>
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
          {modelReady ? (
            <ModelFactsCard
              modelId={currentModelId}
              reasoningEffort={currentReasoningEffort}
              fastMode={currentFastMode}
            />
          ) : null}
          {loadingModels ? (
            <p className="mt-3 text-[11.5px] text-muted-fg/40">Checking which models are set up…</p>
          ) : availableModelIds.length === 0 ? (
            <p className="mt-3 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2.5 text-[11.5px] leading-[1.6] text-amber-200/90">
              No model is set up yet. Sign in to Claude, Codex, or Cursor under Settings → AI →
              Providers.
            </p>
          ) : switchingModel ? (
            <p className="mt-3 text-[11.5px] text-muted-fg/45">Moving the thread to the new model…</p>
          ) : null}
        </div>
      </Pane>
    ),

    voice: (
      <Pane
        title="Voice calls"
        lede="Calls use your own OpenAI key, and the CTO still thinks with the model you picked."
      >
        <div className={cn("mb-7", COLUMN)}>
          <OpenAiKeySection />
        </div>

        <Field label="Voice" hint="The CTO speaks with this voice on your next call.">
          <div
            role="radiogroup"
            aria-label="Voice"
            // Two columns, not a wrapping row: ten voices divide evenly, so
            // no tile is ever left alone on a line of its own. A voice count
            // that stops being even needs this number revisited — the test
            // next to `CTO_VOICE_VOICES` is what says so.
            className="grid grid-cols-2 gap-1.5"
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
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12px] capitalize transition-colors",
                    selected
                      ? "text-fg"
                      : "border-white/[0.08] text-muted-fg/65 hover:bg-white/[0.04] hover:text-fg/85",
                  )}
                  style={
                    selected
                      ? { borderColor: ACCENT, background: `rgba(${ACCENT_RGB},0.10)` }
                      : undefined
                  }
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-[7px] w-[7px] shrink-0 rounded-full",
                      selected ? "" : "bg-white/[0.16]",
                    )}
                    style={selected ? { background: ACCENT } : undefined}
                  />
                  <span className="truncate">{option}</span>
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
            onClick={() => onIdentityChange({ voiceBackchannels: !backchannels })}
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
                ? "The CTO makes small sounds while you talk."
                : "The CTO stays quiet until you finish talking."}
            </span>
          </button>
        </Field>
      </Pane>
    ),

    memory: (
      <Pane title="Memory" lede="The CTO keeps these notes between turns and after you switch models.">
        <div className={COLUMN}>
          <CtoMemoryPanel />
        </div>
      </Pane>
    ),

    prompt: (
      <Pane title="Prompt" lede="Read everything the CTO is sent, assembled into one prompt.">
        <div className={COLUMN}>
          <Disclosure label="Show the full prompt">
            <CtoPromptPreview compact />
          </Disclosure>
        </div>
      </Pane>
    ),

    history: (
      <Pane title="History" lede="Every session this CTO has run in this project.">
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
    ),
  };


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
        {panes[section]}
      </div>
    </div>
  );
}
