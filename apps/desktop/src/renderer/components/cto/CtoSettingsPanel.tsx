import React, { useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { CtoSessionLogEntry } from "../../../shared/types";
import { cn } from "../ui/cn";
import { CtoMemoryPanel } from "./CtoMemoryPanel";
import { CtoPromptPreview } from "./CtoPromptPreview";
import { TimelineEntry } from "./shared/TimelineEntry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ctoModelSupportsLiveRedirect } from "./useCtoModelOptions";

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
}: {
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
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Model" subtitle="Only models that can steer a live turn — the CTO is interrupted constantly.">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            value={currentModelId}
            availableModelIds={availableModelIds}
            filter={ctoModelSupportsLiveRedirect}
            disabled={switchingModel}
            fastModeActive={currentFastMode}
            onFastModeToggle={onFastModeChange}
            onChange={(modelId) => {
              onModelChange(modelId, currentReasoningEffort);
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
            No model the CTO can run on is configured yet. Sign in to Claude, Codex, or Cursor under Settings → AI → Providers.
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

      <Section title="History">
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
      </Section>
    </div>
  );
}
