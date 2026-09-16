import React, { useMemo, useRef, useState } from "react";
import { ArrowLeft, CaretRight, ClockCounterClockwise, Cpu, FileText, IdentificationCard, Microphone, Notebook } from "@phosphor-icons/react";

import type { CtoIdentity, CtoSessionLogEntry } from "../../../shared/types";
import { cn } from "../ui/cn";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { TimelineEntry } from "./shared/TimelineEntry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";
import { OpenAiKeySection } from "../settings/OpenAiKeySection";
import { CTO_VOICE_DEFAULT, CTO_VOICE_VOICES } from "../../../shared/types/ctoVoice";

/**
 * The CTO's settings, as a page rather than a drawer.
 *
 * The drawer was a 440px column with a model picker, a raw markdown editor, a
 * scrolling prompt and a history list stacked in it. Everything competed for
 * the same narrow space, and the things you actually change — the model, the
 * voice key — sat above two blocks you only ever read.
 *
 * So: a left rail of sections, one topic per pane, full width. Reading material
 * (memory, the effective prompt) opens on request instead of occupying the
 * surface by default.
 */

type SectionId = "identity" | "model" | "voice" | "memory" | "prompt" | "history";

const SECTIONS: Array<{ id: SectionId; label: string; hint: string; icon: React.ElementType }> = [
  { id: "identity", label: "Identity", hint: "Name and standing instructions", icon: IdentificationCard },
  { id: "model", label: "Model", hint: "What the CTO thinks with", icon: Cpu },
  { id: "voice", label: "Voice", hint: "Calls, key, and how it sounds", icon: Microphone },
  { id: "memory", label: "Memory", hint: "What it remembers between turns", icon: Notebook },
  { id: "prompt", label: "Prompt", hint: "The effective prompt, in full", icon: FileText },
  { id: "history", label: "History", hint: "Past sessions", icon: ClockCounterClockwise },
];

function Pane({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[720px] px-8 py-7">
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      {subtitle ? <p className="mt-1 text-[12px] leading-[1.6] text-muted-fg/50">{subtitle}</p> : null}
      <div className="mt-6">{children}</div>
    </div>
  );
}

/**
 * A block you read rather than set.
 *
 * Collapsed to one line with its own summary, because a settings page whose
 * first screen is 4,500 tokens of prompt is a page nobody scrolls.
 */
function Disclosure({
  label,
  summary,
  children,
}: {
  label: string;
  summary?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.015]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <CaretRight
          size={12}
          weight="bold"
          className={cn("shrink-0 text-muted-fg/45 transition-transform", open && "rotate-90")}
        />
        <span className="text-[12.5px] font-medium text-fg/85">{label}</span>
        {summary ? <span className="ml-auto text-[11px] text-muted-fg/40">{summary}</span> : null}
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
  // The identity that was last saved, so the Save button can tell a real edit
  // from a re-render.
  const savedRef = useRef({ name: identity?.name ?? "", extra: identity?.systemPromptExtension ?? "" });
  const dirty = name !== savedRef.current.name || extra !== savedRef.current.extra;

  const historyCount = sessionLogs.length;
  const activeSection = useMemo(() => SECTIONS.find((s) => s.id === section) ?? SECTIONS[0], [section]);

  return (
    <div className="flex min-h-0 flex-1" data-testid="cto-settings-page">
      {/* Section rail */}
      <nav
        aria-label="CTO settings sections"
        className="flex w-[228px] shrink-0 flex-col gap-0.5 border-r border-white/[0.06] p-3"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-medium text-muted-fg/60 transition-colors hover:bg-white/[0.04] hover:text-fg"
        >
          <ArrowLeft size={13} weight="bold" />
          Back to the thread
        </button>
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
                "flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                selected ? "bg-white/[0.06] text-fg" : "text-muted-fg/60 hover:bg-white/[0.03] hover:text-fg/85",
              )}
            >
              <Icon size={14} className="mt-[3px] shrink-0" />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  {entry.label}
                  {entry.id === "history" && historyCount > 0 ? (
                    <span className="ml-1.5 font-normal text-muted-fg/35">{historyCount}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-muted-fg/35">{entry.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "identity" ? (
          <Pane title="Identity" subtitle="What the CTO is called, and anything it should always keep in mind.">
            <label className="block text-[11.5px] font-medium text-muted-fg/60" htmlFor="cto-name">Name</label>
            <input
              id="cto-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CTO"
              className="mt-1.5 w-full max-w-[300px] rounded-lg border border-white/[0.09] bg-white/[0.03] px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted-fg/30 focus:border-white/20"
            />

            <label className="mt-6 block text-[11.5px] font-medium text-muted-fg/60" htmlFor="cto-extra">
              Standing instructions
            </label>
            <p className="mt-1 text-[11px] leading-[1.6] text-muted-fg/40">
              Added to every turn. ADE&rsquo;s own doctrine is fixed and is not editable here — this is what
              <em> you </em> want the CTO to keep in mind about this project.
            </p>
            <textarea
              id="cto-extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              rows={7}
              placeholder="e.g. We ship on Fridays. Never touch the billing service without telling me first."
              className="mt-2 w-full resize-y rounded-lg border border-white/[0.09] bg-white/[0.03] px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-fg outline-none placeholder:text-muted-fg/25 focus:border-white/20"
            />

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  onIdentityChange({ name: name.trim(), systemPromptExtension: extra });
                  savedRef.current = { name: name.trim(), extra };
                  setName(name.trim());
                }}
                className="rounded-lg border border-white/[0.12] bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/[0.1] disabled:opacity-35"
              >
                Save
              </button>
              {dirty ? <span className="text-[11px] text-muted-fg/40">Unsaved changes</span> : null}
            </div>
          </Pane>
        ) : null}

        {section === "model" ? (
          <Pane
            title="Model"
            subtitle="Only models that can steer a live turn — the CTO is interrupted constantly."
          >
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
              <div className="mt-3 text-[11.5px] text-muted-fg/40">Checking configured models…</div>
            ) : availableModelIds.length === 0 ? (
              <div className="mt-3 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2.5 text-[11.5px] leading-[1.6] text-amber-200/90">
                No model the CTO can run on is configured yet. Sign in to Claude, Codex, or Cursor under
                Settings → AI → Providers.
              </div>
            ) : switchingModel ? (
              <div className="mt-3 text-[11.5px] text-muted-fg/45">Moving the thread to the new model…</div>
            ) : null}
          </Pane>
        ) : null}

        {section === "voice" ? (
          <Pane
            title="Voice"
            subtitle="Talking to the CTO runs on your own OpenAI key. Its thinking stays on the model above."
          >
            <OpenAiKeySection />

            <div className="mt-8">
              <div className="text-[12px] font-medium text-fg/85">Voice</div>
              <p className="mt-1 text-[11px] leading-[1.6] text-muted-fg/40">
                Applies to the next call. Ten voices ship with GPT Live; they differ in pitch and pace,
                not in what the CTO says.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {CTO_VOICE_VOICES.map((name) => {
                  const selected = (identity?.voiceName ?? CTO_VOICE_DEFAULT) === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onVoiceChange({ voiceName: name })}
                      className={cn(
                        "rounded-lg border px-2.5 py-1.5 text-[11.5px] capitalize transition-colors",
                        selected
                          ? "border-white/25 bg-white/[0.09] text-fg"
                          : "border-white/[0.08] text-muted-fg/55 hover:bg-white/[0.04] hover:text-fg/85",
                      )}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>

              <label className="mt-6 flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={identity?.voiceBackchannels !== false}
                  onChange={(e) => onVoiceChange({ voiceBackchannels: e.target.checked })}
                  className="mt-[3px] h-3.5 w-3.5 accent-white/70"
                />
                <span>
                  <span className="block text-[12px] font-medium text-fg/85">Listening noises</span>
                  <span className="mt-0.5 block text-[11px] leading-[1.6] text-muted-fg/40">
                    Lets the CTO murmur while you talk. Off makes it wait in silence until you finish.
                  </span>
                </span>
              </label>
            </div>
          </Pane>
        ) : null}

        {section === "memory" ? (
          <Pane title="Memory" subtitle="What the CTO carries between turns, model switches and compactions.">
            <CtoMemoryPanel />
          </Pane>
        ) : null}

        {section === "prompt" ? (
          <Pane title="Prompt" subtitle="Everything the CTO is sent, assembled — read-only.">
            <Disclosure label="Preview effective prompt">
              <CtoPromptPreview compact />
            </Disclosure>
          </Pane>
        ) : null}

        {section === "history" ? (
          <Pane title="History" subtitle="Sessions this CTO has run in this project.">
            {historyCount === 0 ? (
              <div className="text-[12px] text-muted-fg/40">No sessions yet.</div>
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
          </Pane>
        ) : null}

        <div className="sr-only" aria-live="polite">{activeSection.label}</div>
      </div>
    </div>
  );
}
