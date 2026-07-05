import React, { useState } from "react";
import { ArrowCounterClockwise, CaretRight } from "@phosphor-icons/react";
import type { CtoIdentity, CtoSessionLogEntry } from "../../../shared/types";
import { cn } from "../ui/cn";
import { IdentityEditor } from "./IdentityEditor";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { TimelineEntry } from "./shared/TimelineEntry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { resolveModelSelection } from "./useCtoModelOptions";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-white/[0.06] px-5 py-5 first:border-t-0">
      <div className="text-[13px] font-semibold text-fg">{title}</div>
      {subtitle ? <div className="mt-0.5 text-[11.5px] leading-4 text-muted-fg/45">{subtitle}</div> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function CtoSettingsPanel({
  identity,
  sessionLogs,
  currentModelId,
  currentReasoningEffort,
  availableModelIds,
  loadingModels,
  switchingModel,
  onSaveIdentity,
  onModelChange,
  onOpenProviderSettings,
  onResetOnboarding,
}: {
  identity: CtoIdentity | null;
  sessionLogs: CtoSessionLogEntry[];
  currentModelId: string;
  currentReasoningEffort: string | null;
  availableModelIds: string[];
  loadingModels: boolean;
  switchingModel: boolean;
  onSaveIdentity: (patch: Record<string, unknown>) => Promise<void>;
  onModelChange: (modelId: string, reasoningEffort: string | null) => void;
  onOpenProviderSettings: () => void;
  onResetOnboarding?: () => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Identity" subtitle="How the CTO shows up and how it works with you.">
        {identity ? (
          <IdentityEditor identity={identity} onSave={onSaveIdentity} />
        ) : (
          <div className="text-[12px] text-muted-fg/45">Loading…</div>
        )}
      </Section>

      <Section title="Model" subtitle="Switch any time — the thread and memory carry over.">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            value={currentModelId}
            availableModelIds={availableModelIds}
            surfaceKey="cto-settings"
            disabled={switchingModel}
            onChange={(modelId) => {
              const selection = resolveModelSelection(modelId, currentReasoningEffort);
              onModelChange(modelId, selection?.reasoningEffort ?? null);
            }}
            onOpenSignIn={onOpenProviderSettings}
          />
          <ReasoningEffortPicker
            modelId={currentModelId}
            reasoningEffort={currentReasoningEffort}
            onChange={(effort) => onModelChange(currentModelId, effort)}
          />
        </div>
        {loadingModels ? (
          <div className="mt-2 text-[11px] text-muted-fg/40">Checking configured models…</div>
        ) : availableModelIds.length === 0 ? (
          <div className="mt-2 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-4 text-amber-200/90">
            No models configured yet. Add API keys or sign in to a CLI under Settings → AI → Providers.
          </div>
        ) : switchingModel ? (
          <div className="mt-2 text-[11px] text-muted-fg/45">Moving the thread to the new model…</div>
        ) : null}
      </Section>

      <Section title="Memory">
        <CtoMemoryPanel />
      </Section>

      <Section title="Prompt">
        <button
          type="button"
          onClick={() => setPromptOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg/80 transition-colors hover:text-fg"
        >
          <CaretRight
            size={12}
            weight="bold"
            className={cn("text-muted-fg/50 transition-transform", promptOpen && "rotate-90")}
          />
          Preview effective prompt
        </button>
        {promptOpen && (
          <div className="mt-3">
            <CtoPromptPreview compact />
          </div>
        )}
      </Section>

      <Section title="Setup">
        <div className="space-y-3">
          {onResetOnboarding && (
            <button
              type="button"
              onClick={onResetOnboarding}
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-white/[0.08] px-3 text-[12px] font-medium text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
            >
              <ArrowCounterClockwise size={13} />
              Re-run setup
            </button>
          )}
          <div>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg/80 transition-colors hover:text-fg"
            >
              <CaretRight
                size={12}
                weight="bold"
                className={cn("text-muted-fg/50 transition-transform", historyOpen && "rotate-90")}
              />
              Session history
              {sessionLogs.length > 0 && (
                <span className="font-normal text-muted-fg/40">· {sessionLogs.length}</span>
              )}
            </button>
            {historyOpen && (
              <div className="mt-2 space-y-1" data-testid="session-history-list">
                {sessionLogs.length === 0 ? (
                  <div className="py-1 text-[11px] text-muted-fg/40">No sessions yet.</div>
                ) : (
                  sessionLogs.map((session) => (
                    <TimelineEntry
                      key={session.id}
                      timestamp={session.createdAt}
                      title={session.summary}
                      status={session.capabilityMode}
                      statusVariant={session.capabilityMode === "full_tooling" ? "success" : "muted"}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
