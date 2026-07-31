/**
 * ChatModelSelectionPendingCard — pending-input slot used when the
 * orchestration lead calls `askUserForModelSelection` (see `goal.md` §10.9,
 * §13). Renders the in-house `ModelPicker` so the user picks a model +
 * fast-mode + reasoning level for a `(role, tag)` pair. Permission tier is
 * forced by the orchestration spawn path (see §12); the picker hides its
 * permission rows for this surface.
 *
 * The resolved selection is shipped back through `agentChat.respondToInput`
 * as `answers.selection = JSON.stringify(modelSelection)` — see how the
 * pane wires `onApproval(decision, responseText, answers)` to the
 * `respondToInput` IPC call.
 */

import { memo, useCallback, useEffect, useState } from "react";
import {
  type ModelSelection,
  type OrchestrationModelSelectionMetadata,
} from "../../../shared/types/orchestration";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import {
  modelSupportsFastMode,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
  type ProviderFamily,
} from "../../../shared/modelRegistry";
import type { AgentChatProvider } from "../../../shared/types";
import type { AuthStatus } from "../shared/ModelPicker/ModelPickerRail";
import { cn } from "../ui/cn";

export type ChatModelSelectionPendingCardProps = {
  metadata: OrchestrationModelSelectionMetadata | null;
  /**
   * Optional id list to scope the picker (from `providerMetadata.availableModels`).
   * When null/undefined the picker shows the lane's full catalog.
   */
  availableModelIds?: string[];
  /** Auth status fan-out for the picker rail. */
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  /** Disable while a response is in flight. */
  responding: boolean;
  onConfirm: (selection: ModelSelection) => void;
  onCancel: () => void;
};

const DEFAULT_SELECTION_PROVIDER: AgentChatProvider = "opencode";
const MODEL_ID_PROVIDER_PREFIXES: Record<string, AgentChatProvider> = {
  anthropic: "claude",
  claude: "claude",
  codex: "codex",
  openai: "codex",
  cursor: "cursor",
  droid: "droid",
  factory: "droid",
  deepseek: "opencode",
  google: "opencode",
  groq: "opencode",
  lmstudio: "opencode",
  mistral: "opencode",
  ollama: "opencode",
  opencode: "opencode",
  openrouter: "opencode",
  together: "opencode",
  xai: "opencode",
};

function resolveSelectionProvider(
  nextModelId: string,
  fallback: AgentChatProvider,
): AgentChatProvider {
  const desc = resolveModelDescriptor(nextModelId);
  if (desc) return resolveProviderGroupForModel(desc);
  const normalized = nextModelId.trim().toLowerCase();
  const prefix = normalized.split(/[/-]/, 1)[0] ?? "";
  if (MODEL_ID_PROVIDER_PREFIXES[prefix]) return MODEL_ID_PROVIDER_PREFIXES[prefix];
  if (/^(opus|sonnet|haiku)\b/.test(normalized)) return "claude";
  if (/^(gpt|o\d|chatgpt)\b/.test(normalized)) return "codex";
  return fallback;
}

export const ChatModelSelectionPendingCard = memo(function ChatModelSelectionPendingCard({
  metadata,
  availableModelIds,
  providerAuthStatus,
  responding,
  onConfirm,
  onCancel,
}: ChatModelSelectionPendingCardProps) {
  // No recommended/suggested model — the user picks from scratch so they can
  // match the model to what this agent actually does (see the briefing below).
  const [modelId, setModelId] = useState<string>("");
  const [provider, setProvider] = useState<AgentChatProvider>(DEFAULT_SELECTION_PROVIDER);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState<boolean>(false);
  const fallbackProvider = metadata?.suggested?.provider ?? DEFAULT_SELECTION_PROVIDER;
  const requestKey = JSON.stringify({
    role: metadata?.role ?? null,
    tag: metadata?.tag ?? null,
    fallbackProvider,
    workDescription: metadata?.workDescription ?? null,
    filesHint: metadata?.filesHint ?? [],
    dependsOn: metadata?.dependsOn ?? [],
  });

  const descriptor = resolveModelDescriptor(modelId);
  const fastModeSupported = modelSupportsFastMode(descriptor);

  useEffect(() => {
    setModelId("");
    setProvider(fallbackProvider);
    setReasoningEffort(null);
    setFastMode(false);
  }, [fallbackProvider, requestKey]);

  // Clear fast mode when the picked model doesn't support it, so a stale toggle
  // can't be submitted after switching to an unsupported model.
  useEffect(() => {
    if (!fastModeSupported && fastMode) setFastMode(false);
  }, [fastModeSupported, fastMode]);

  // When the user picks a different model, infer the new provider from the
  // model registry or runtime-catalog prefix so the dispatched ModelSelection
  // stays internally consistent (provider + modelId always agree).
  const handleModelChange = useCallback((nextModelId: string, options?: { fastMode: boolean }) => {
    setModelId(nextModelId);
    if (options) setFastMode(options.fastMode);
    setProvider(resolveSelectionProvider(nextModelId, fallbackProvider));
  }, [fallbackProvider]);

  const submit = useCallback(() => {
    if (!modelId.trim().length) return;
    const selection: ModelSelection = {
      provider,
      modelId,
      ...(reasoningEffort !== null ? { reasoningEffort } : {}),
      ...(fastMode && fastModeSupported ? { fastMode: true } : {}),
    };
    onConfirm(selection);
  }, [provider, modelId, reasoningEffort, fastMode, fastModeSupported, onConfirm]);

  const filesHint = metadata?.filesHint ?? [];
  const dependsOn = metadata?.dependsOn ?? [];
  const FILE_CHIP_CAP = 6;

  return (
    <div
      data-testid="orchestration-model-selection-pending-card"
      data-pending-kind="model_selection"
      className={cn(
        "rounded-xl border border-violet-300/22 bg-violet-500/[0.06] px-4 py-3.5",
      )}
    >
      {/* Header: sentence-case title + a warm role · tag chip (no all-caps band) */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-sans text-[length:calc(var(--chat-font-size)*13/14)] font-semibold text-fg/90">
          Pick a model
        </span>
        {metadata ? (
          <span
            data-testid="orchestration-model-selection-agent-chip"
            className="inline-flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-violet-300/30 bg-violet-500/12 px-2 py-[2px] font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-violet-100"
          >
            <span>
              {metadata.role}
              {metadata.tag ? ` · ${metadata.tag}` : ""}
            </span>
          </span>
        ) : null}
      </div>

      {/* Agent briefing — what it does, so the user can match a model to the work */}
      {metadata?.workDescription ? (
        <div className="mb-2.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed text-fg/82">
          {metadata.workDescription}
        </div>
      ) : (
        <div className="mb-2.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/55">
          Choose the model for this agent.
        </div>
      )}

      {filesHint.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] uppercase tracking-wide text-fg/40">
            Files it touches
          </span>
          {filesHint.slice(0, FILE_CHIP_CAP).map((path) => (
            <span
              key={path}
              title={path}
              className="inline-flex max-w-[15rem] items-center truncate rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/62"
            >
              <span className="truncate">{path}</span>
            </span>
          ))}
          {filesHint.length > FILE_CHIP_CAP ? (
            <span className="font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/40">
              +{filesHint.length - FILE_CHIP_CAP}
            </span>
          ) : null}
        </div>
      ) : null}

      {dependsOn.length > 0 ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <span className="font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] uppercase tracking-wide text-fg/40">
            Runs after
          </span>
          {dependsOn.slice(0, FILE_CHIP_CAP).map((dep) => (
            <span
              key={dep}
              className="inline-flex items-center rounded-[var(--chat-radius-pill)] border border-white/[0.07] bg-white/[0.02] px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/62"
            >
              {dep}
            </span>
          ))}
          {dependsOn.length > FILE_CHIP_CAP ? (
            <span className="font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/40">
              +{dependsOn.length - FILE_CHIP_CAP}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <ModelPicker
          value={modelId}
          onChange={handleModelChange}
          surfaceKey="orchestration-model-selection-pending"
          {...(availableModelIds ? { availableModelIds } : {})}
          {...(providerAuthStatus ? { providerAuthStatus } : {})}
          disabled={responding}
          hidePermissionRail
          compact
          fastModeActive={fastMode}
          fastModeSupported={fastModeSupported}
          {...(fastModeSupported ? { onFastModeToggle: setFastMode } : {})}
        />
        <ReasoningEffortPicker
          modelId={modelId}
          reasoningEffort={reasoningEffort}
          onChange={setReasoningEffort}
          disabled={responding}
          compact
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/40">
          Permissions are locked automatically.
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={responding}
            className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-fg/55 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="orchestration-model-selection-confirm"
            disabled={responding || !modelId.trim().length}
            className="rounded-[var(--chat-radius-pill)] border border-violet-300/35 bg-violet-500/15 px-3 py-1 font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-semibold text-violet-50 transition-colors hover:bg-violet-500/22 disabled:opacity-40 disabled:pointer-events-none"
            onClick={submit}
          >
            {responding ? "Submitting..." : "Use this model"}
          </button>
        </div>
      </div>
    </div>
  );
});
