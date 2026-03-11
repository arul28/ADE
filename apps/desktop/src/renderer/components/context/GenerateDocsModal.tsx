import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { getModelById } from "../../../shared/modelRegistry";
import type { ContextGenerateDocsResult, ContextRefreshEvents } from "../../../shared/types";

type Phase = "configure" | "running" | "done";

type EventToggle = {
  key: keyof ContextRefreshEvents;
  label: string;
  help: string;
};

const EVENT_TOGGLES: EventToggle[] = [
  { key: "onSessionEnd", label: "On session end", help: "Regen when a terminal/agent session ends." },
  { key: "onCommit", label: "On commit", help: "Regen when a commit is created." },
  { key: "onPrCreate", label: "On PR create", help: "Regen when a pull request is created or updated." },
  { key: "onPrLand", label: "On PR land", help: "Regen when a pull request is landed/merged." },
  { key: "onMissionStart", label: "On mission start", help: "Regen when a mission launches." },
  { key: "onMissionEnd", label: "On mission end", help: "Regen when a mission completes." },
  { key: "onLaneCreate", label: "On lane create", help: "Regen when a new lane is created." },
];

const DEFAULT_EVENTS: ContextRefreshEvents = { onPrCreate: true, onMissionStart: true };

const STORAGE_MODEL_KEY = "ade.contextDocs.modelId";
const STORAGE_EFFORT_KEY = "ade.contextDocs.reasoningEffort";
const STORAGE_EVENTS_KEY = "ade.contextDocs.refreshEvents";

function readStoredString(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredString(key: string, value: string | null): void {
  try {
    if (!value || value.trim().length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // ignore persistence errors
  }
}

export function GenerateDocsModal({
  open,
  onOpenChange,
  onCompleted
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}) {
  const [phase, setPhase] = React.useState<Phase>("configure");
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);
  const [modelId, setModelId] = React.useState<string>("claude-sonnet-4-6");
  const [reasoningEffort, setReasoningEffort] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<ContextRefreshEvents>({ ...DEFAULT_EVENTS });
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [result, setResult] = React.useState<ContextGenerateDocsResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reasoningTiers = getModelById(modelId)?.reasoningTiers ?? [];

  React.useEffect(() => {
    if (!open) return;
    const storedModel = readStoredString(STORAGE_MODEL_KEY);
    const storedEffort = readStoredString(STORAGE_EFFORT_KEY);
    const storedEventsRaw = readStoredString(STORAGE_EVENTS_KEY);
    if (storedModel) setModelId(storedModel);
    if (storedEffort) setReasoningEffort(storedEffort);
    if (storedEventsRaw) {
      try {
        const parsed = JSON.parse(storedEventsRaw) as ContextRefreshEvents;
        if (typeof parsed === "object" && parsed !== null) {
          setEvents(parsed);
        }
      } catch {
        // ignore bad stored JSON
      }
    }

    let cancelled = false;
    setLoadingModels(true);
    window.ade.agentChat.models({ provider: "unified" })
      .then((models) => {
        if (cancelled) return;
        const ids = models
          .map((entry) => String(entry.modelId ?? entry.id ?? "").trim())
          .filter((entry) => entry.length > 0);
        const unique = [...new Set(ids)];
        setAvailableModelIds(unique);
        if (unique.length > 0 && !unique.includes(storedModel ?? modelId)) {
          setModelId(unique[0]!);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableModelIds([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    if (reasoningEffort && reasoningTiers.length > 0 && !reasoningTiers.includes(reasoningEffort)) {
      setReasoningEffort(reasoningTiers[0] ?? null);
    }
  }, [open, reasoningEffort, reasoningTiers]);

  const toggleEvent = (key: keyof ContextRefreshEvents) => {
    setEvents((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleRun = async () => {
    setPhase("running");
    setError(null);
    setResult(null);

    writeStoredString(STORAGE_MODEL_KEY, modelId);
    writeStoredString(STORAGE_EFFORT_KEY, reasoningEffort);
    writeStoredString(STORAGE_EVENTS_KEY, JSON.stringify(events));

    try {
      const next = await window.ade.context.generateDocs({
        provider: "unified",
        modelId,
        reasoningEffort,
        events
      });
      setResult(next);
      setPhase("done");
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("done");
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Background-safe: closing does not cancel generation.
      setError(null);
      setResult(null);
      setPhase("configure");
    }
    onOpenChange(next);
  };

  const canRun = modelId.trim().length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-[8%] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded bg-card border border-border/40 p-4 shadow-float focus:outline-none"
        >
          <Dialog.Title className="text-sm font-semibold text-fg">Generate Context Docs</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            Choose a configured model and run doc generation in the background.
          </Dialog.Description>

          {phase === "configure" ? (
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Model</label>
                <UnifiedModelSelector
                  value={modelId}
                  onChange={setModelId}
                  availableModelIds={availableModelIds.length > 0 ? availableModelIds : undefined}
                  showReasoning
                  reasoningEffort={reasoningEffort}
                  onReasoningEffortChange={setReasoningEffort}
                  className="w-full"
                />
                {loadingModels ? (
                  <div className="mt-1 text-[11px] text-muted-fg">Detecting configured models...</div>
                ) : null}
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-fg">Auto Refresh Events</label>
                <p className="mb-2 text-[11px] text-muted-fg">
                  Toggle which events trigger automatic context doc regeneration. Min-interval throttling applies.
                </p>
                <div className="space-y-1.5">
                  {EVENT_TOGGLES.map((toggle) => (
                    <label key={toggle.key} className="flex items-start gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={!!events[toggle.key]}
                        onChange={() => toggleEvent(toggle.key)}
                        className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-fg">{toggle.label}</span>
                        <p className="text-[11px] text-muted-fg leading-tight">{toggle.help}</p>
                      </div>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-muted-fg">
                  Higher frequency can increase token usage and cost. Use lightweight models for aggressive cadences.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Cancel</Button>
                </Dialog.Close>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canRun}
                  onClick={() => void handleRun()}
                >
                  Run In Background
                </Button>
              </div>
            </div>
          ) : null}

          {phase === "running" ? (
            <div className="mt-4 rounded border border-border/60 bg-card/60 px-3 py-3 text-xs text-muted-fg">
              Generating PRD + architecture docs with <code>{modelId}</code>.
              <div className="mt-1">You can close this modal now; generation continues in the background.</div>
              <div className="mt-3 flex justify-end">
                <Dialog.Close asChild>
                  <Button size="sm" variant="outline">Close</Button>
                </Dialog.Close>
              </div>
            </div>
          ) : null}

          {phase === "done" ? (
            <div className="mt-4 space-y-2">
              {error ? (
                <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                  {error}
                </div>
              ) : (
                <div className="rounded border border-green-500/30 bg-green-500/5 px-3 py-2 text-xs text-green-700">
                  Context docs updated successfully.
                </div>
              )}
              {result ? (
                <div className="rounded border border-border/50 bg-card/60 px-3 py-2 text-[11px] text-muted-fg">
                  <div>Provider: {result.provider}</div>
                  <div>Generated: {new Date(result.generatedAt).toLocaleString()}</div>
                  <div>PRD: {result.prdPath}</div>
                  <div>Architecture: {result.architecturePath}</div>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Dialog.Close asChild>
                  <Button size="sm" variant="primary">Done</Button>
                </Dialog.Close>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
