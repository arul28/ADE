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

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type ModelSelection,
  type OrchestrationModelSelectionMetadata,
} from "../../../shared/types/orchestration";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { getModelById, modelSupportsFastMode, type ProviderFamily } from "../../../shared/modelRegistry";
import type { AgentChatProvider } from "../../../shared/types";
import type { AuthStatus } from "../shared/ModelPicker/ModelPickerRail";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { cn } from "../ui/cn";

export type ChatModelSelectionPendingCardProps = {
  metadata: OrchestrationModelSelectionMetadata | null;
  /** Initial selection — taken from `providerMetadata.suggested`. */
  suggested?: ModelSelection | null;
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

function inferProviderFamily(provider: AgentChatProvider): ProviderFamily | null {
  switch (provider) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "cursor":
      return "cursor";
    case "droid":
      return "factory";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

export const ChatModelSelectionPendingCard = memo(function ChatModelSelectionPendingCard({
  metadata,
  suggested,
  availableModelIds,
  providerAuthStatus,
  responding,
  onConfirm,
  onCancel,
}: ChatModelSelectionPendingCardProps) {
  const initialProvider: AgentChatProvider = suggested?.provider ?? "claude";
  const initialModelId = suggested?.modelId ?? "";
  const [modelId, setModelId] = useState<string>(initialModelId);
  const [provider, setProvider] = useState<AgentChatProvider>(initialProvider);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(
    suggested?.reasoningEffort ?? null,
  );
  const [fastMode, setFastMode] = useState<boolean>(
    Boolean(suggested?.fastMode),
  );

  const descriptor = getModelById(modelId);
  const fastModeSupported = modelSupportsFastMode(descriptor);

  // Clear fast mode when the picked model doesn't support it, so a stale toggle
  // can't be submitted after switching to an unsupported model.
  useEffect(() => {
    if (!fastModeSupported && fastMode) setFastMode(false);
  }, [fastModeSupported, fastMode]);

  // When the user picks a different model, infer the new provider from the
  // model registry so the dispatched ModelSelection stays internally
  // consistent (provider + modelId always agree).
  const handleModelChange = useCallback((nextModelId: string) => {
    setModelId(nextModelId);
    const desc = getModelById(nextModelId);
    if (desc?.family === "anthropic") setProvider("claude");
    else if (desc?.family === "openai") setProvider("codex");
    else if (desc?.family === "cursor") setProvider("cursor");
    else if (desc?.family === "factory") setProvider("droid");
    else if (desc?.family === "opencode") setProvider("opencode");
    // For local / other families we keep the previous provider — the lead
    // resolves provider-family routing server-side.
  }, []);

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

  const headerLabel = useMemo(() => {
    if (!metadata) return "Pick a model";
    const friendlyRole = metadata.role;
    if (metadata.tag) return `Pick a model for the "${metadata.tag}" ${friendlyRole}`;
    return `Pick a model for the ${friendlyRole}`;
  }, [metadata]);

  // TODO: pass inferProviderFamily(initialProvider) to the picker rail so it
  // highlights the right column once ModelPicker supports an initialFamily prop.

  return (
    <div
      data-testid="orchestration-model-selection-pending-card"
      data-pending-kind="model_selection"
      className={cn(
        "rounded-xl border border-violet-300/22 bg-violet-500/5 px-4 py-3",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-violet-300/30 bg-violet-500/15">
          <ChatStatusGlyph status="waiting" size={11} />
        </span>
        <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest text-violet-200">
          {headerLabel}
        </span>
      </div>
      <div className="mb-3 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/68">
        {metadata?.workDescription
          ? metadata.workDescription
          : `Choose the model${metadata?.tag ? ` for the "${metadata.tag}" agent` : ""}. Permissions are locked automatically.`}
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={responding}
          className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-fg/45 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="orchestration-model-selection-confirm"
          disabled={responding || !modelId.trim().length}
          className="rounded-[var(--chat-radius-pill)] border border-violet-300/35 bg-violet-500/15 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-violet-50 transition-colors hover:bg-violet-500/22 disabled:opacity-40 disabled:pointer-events-none"
          onClick={submit}
        >
          {responding ? "Submitting…" : "Confirm"}
        </button>
      </div>
    </div>
  );
});
