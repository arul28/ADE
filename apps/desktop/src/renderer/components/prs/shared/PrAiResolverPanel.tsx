import React from "react";
import { CaretDown, CaretRight, CircleNotch, Sparkle, X } from "@phosphor-icons/react";
import type {
  PrAiResolutionContext,
  PrAiResolutionEventPayload,
  PrAiResolutionStartResult,
} from "../../../../shared/types";
import { AgentChatPane } from "../../chat/AgentChatPane";
import { UnifiedModelSelector } from "../../shared/UnifiedModelSelector";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { deriveConfiguredModelIds } from "../../../lib/modelOptions";

type PrAiResolverCompletion = {
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  message: string | null;
  context: PrAiResolutionContext;
};

type PrAiResolverPanelProps = {
  title: string;
  description: string;
  context: PrAiResolutionContext | null;
  modelId: string;
  reasoningEffort: string;
  onModelChange: (modelId: string, reasoningEffort: string) => void;
  onStarted?: (result: PrAiResolutionStartResult) => void;
  onCompleted?: (result: PrAiResolverCompletion) => void;
  onDismiss?: () => void;
  className?: string;
  startLabel?: string;
  defaultExpanded?: boolean;
  sessionShellClassName?: string;
};

function normalizeReasoning(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function defaultLaneId(context: PrAiResolutionContext | null): string | null {
  if (!context) return null;
  return context.laneId ?? context.integrationLaneId ?? context.sourceLaneId ?? context.targetLaneId ?? null;
}

export function PrAiResolverPanel({
  title,
  description,
  context,
  modelId,
  reasoningEffort,
  onModelChange,
  onStarted,
  onCompleted,
  onDismiss,
  className,
  startLabel = "Start AI Resolver",
  defaultExpanded = true,
  sessionShellClassName,
}: PrAiResolverPanelProps) {
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);
  const [launching, setLaunching] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionLaneId, setSessionLaneId] = React.useState<string | null>(defaultLaneId(context));
  const [status, setStatus] = React.useState<"idle" | "starting" | "running" | "completed" | "failed" | "cancelled">("idle");
  const [message, setMessage] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const terminalStatusRef = React.useRef<PrAiResolverCompletion["status"] | null>(null);

  React.useEffect(() => {
    setSessionLaneId(defaultLaneId(context));
  }, [context]);

  React.useEffect(() => {
    let cancelled = false;
    void window.ade.ai.getStatus()
      .then((status) => {
        if (!cancelled) {
          setAvailableModelIds(deriveConfiguredModelIds(status));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableModelIds([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const unsubscribe = window.ade.prs.onAiResolutionEvent((event: PrAiResolutionEventPayload) => {
      if (!sessionId || event.sessionId !== sessionId) return;
      setMessage(event.message ?? null);
      if (event.status === "running") {
        setStatus("running");
        return;
      }
      setStatus(event.status);
      if (terminalStatusRef.current === event.status || !context) return;
      terminalStatusRef.current = event.status;
      onCompleted?.({
        sessionId,
        status: event.status,
        message: event.message ?? null,
        context,
      });
    });
    return unsubscribe;
  }, [context, onCompleted, sessionId]);

  const handleStart = React.useCallback(async () => {
    if (!context || launching || !modelId.trim()) return;
    setLaunching(true);
    setMessage(null);
    setStatus("starting");
    terminalStatusRef.current = null;
    try {
      const result = await window.ade.prs.aiResolutionStart({
        model: modelId,
        reasoning: normalizeReasoning(reasoningEffort),
        permissionMode: "guarded_edit",
        context,
      });
      if (result.status !== "started") {
        setStatus("failed");
        setMessage(result.error ?? "Unable to start AI resolution.");
        return;
      }
      setSessionId(result.sessionId);
      setSessionLaneId(defaultLaneId(result.context));
      setStatus("running");
      onStarted?.(result);
    } catch (error) {
      setStatus("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
    }
  }, [context, launching, modelId, onStarted, reasoningEffort]);

  const canStart = Boolean(context && modelId.trim().length) && !launching && !sessionId;

  return (
    <div className={cn("overflow-hidden border border-border/15 bg-card/70", className)}>
      <div className="flex items-start justify-between gap-4 border-b border-border/10 px-4 py-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg/65">{title}</div>
          <div className="mt-1 flex items-start gap-2">
            {expanded ? (
              <CaretDown size={12} weight="bold" className="mt-0.5 flex-shrink-0 text-fg/35" />
            ) : (
              <CaretRight size={12} weight="bold" className="mt-0.5 flex-shrink-0 text-fg/35" />
            )}
            <p className="font-mono text-[11px] leading-relaxed text-fg/45">{description}</p>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.16em]",
              status === "running" || status === "starting"
                ? "border-violet-400/30 bg-violet-500/10 text-violet-200"
                : status === "completed"
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                  : status === "failed" || status === "cancelled"
                    ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
                    : "border-border/20 bg-bg/40 text-fg/40",
            )}
          >
            {status}
          </span>
          {onDismiss ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center border border-border/15 text-fg/45 transition-colors hover:border-border/30 hover:text-fg/75"
              onClick={onDismiss}
              aria-label="Hide AI resolver"
            >
              <X size={14} weight="bold" />
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (!sessionId ? (
        <div className="space-y-4 px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <UnifiedModelSelector
              value={modelId}
              onChange={(nextModelId) => onModelChange(nextModelId, reasoningEffort)}
              availableModelIds={availableModelIds}
              showReasoning
              reasoningEffort={normalizeReasoning(reasoningEffort)}
              onReasoningEffortChange={(nextReasoning) => onModelChange(modelId, nextReasoning ?? "")}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!canStart}
              onClick={() => {
                void handleStart();
              }}
            >
              {launching ? <CircleNotch size={14} className="mr-1 animate-spin" /> : <Sparkle size={14} className="mr-1" />}
              {startLabel}
            </Button>
          </div>
          {message ? (
            <div className="border border-amber-400/20 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-amber-100">
              {message}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={cn("flex h-[620px] min-h-[540px] max-h-[70vh] flex-col", sessionShellClassName)}>
          {message ? (
            <div className="border-b border-border/10 px-4 py-2 font-mono text-[10px] text-fg/55">
              {message}
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <AgentChatPane
              laneId={sessionLaneId}
              lockSessionId={sessionId}
              hideSessionTabs
              availableModelIdsOverride={[modelId]}
              modelSelectionLocked
              compactResolverView
            />
          </div>
        </div>
      )) : null}
    </div>
  );
}
