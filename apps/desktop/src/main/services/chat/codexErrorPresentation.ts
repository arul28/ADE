import type { ChatErrorPresentation } from "../../../shared/chatErrorPresentation";

/**
 * Card copy for the Codex refusals a person can act on, read from what the
 * app-server sends rather than from its wording.
 *
 * Since 0.166 a thread stays tied to the model provider it was made with:
 * `thread/resume` and the input RPCs answer with a JSON-RPC error whose `data`
 * is a `ModelProviderError` (app-server-protocol `model_provider_error.rs`)
 * when Codex is now configured for another one. Any other `data` is not one of
 * these and keeps the normal failure path.
 */
export type CodexModelProviderError =
  | { type: "modelProviderMismatch"; modelProvider: string; currentModelProvider: string }
  | { type: "modelProviderNotConfigured"; modelProvider: string }
  | { type: "modelProviderPolicyConflict"; modelProvider: string; requiredModelProvider: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

export function readCodexModelProviderError(data: unknown): CodexModelProviderError | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const modelProvider = nonEmptyString(record.modelProvider);
  if (!modelProvider) return null;
  switch (record.type) {
    case "modelProviderMismatch": {
      const currentModelProvider = nonEmptyString(record.currentModelProvider);
      return currentModelProvider ? { type: record.type, modelProvider, currentModelProvider } : null;
    }
    case "modelProviderNotConfigured":
      return { type: record.type, modelProvider };
    case "modelProviderPolicyConflict": {
      const requiredModelProvider = nonEmptyString(record.requiredModelProvider);
      return requiredModelProvider ? { type: record.type, modelProvider, requiredModelProvider } : null;
    }
    default:
      return null;
  }
}

/** `ade` and `ade-proxy` are the provider ids ADE writes into a preset's config. */
const MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  gcp: "Google Cloud Vertex AI",
  ade: "an ADE preset",
  "ade-proxy": "ADE's proxy",
};

function modelProviderLabel(id: string): string {
  return MODEL_PROVIDER_LABELS[id.toLowerCase()] ?? id;
}

export function presentCodexModelProviderError(
  error: CodexModelProviderError,
  technicalDetail: string,
): ChatErrorPresentation {
  const provider = modelProviderLabel(error.modelProvider);
  const detail = technicalDetail.trim() ? { technicalDetail: technicalDetail.trim() } : {};
  switch (error.type) {
    case "modelProviderMismatch":
      return {
        title: "Codex is set to another provider",
        body: `This chat runs on ${provider}, but Codex is now set to ${modelProviderLabel(error.currentModelProvider)}, so Codex won't continue it.`,
        nextAction: `Switch Codex back to ${provider}, or start a new chat.`,
        ...detail,
      };
    case "modelProviderNotConfigured":
      return {
        title: "This chat's provider is gone",
        body: `This chat runs on ${provider}, which is no longer set up in Codex.`,
        nextAction: `Set ${provider} up in Codex again, or start a new chat.`,
        ...detail,
      };
    case "modelProviderPolicyConflict":
      return {
        title: "Blocked by your organization",
        body: error.modelProvider === error.requiredModelProvider
          ? "This chat's provider settings no longer match your organization's Codex requirements."
          : `Your organization requires ${modelProviderLabel(error.requiredModelProvider)} for Codex, but this chat runs on ${provider}.`,
        nextAction: "Start a new chat, or ask your administrator.",
        ...detail,
      };
  }
}

/** A failed turn's card when `codexErrorInfo` names a cause with a clear next step. */
export function presentCodexTurnError(args: {
  errorInfo: unknown;
  message: string;
  detail?: string;
  model?: string | null;
}): ChatErrorPresentation | null {
  const technicalDetail = [args.message.trim(), args.detail?.trim()].filter(Boolean).join("\n");
  const detail = technicalDetail ? { technicalDetail } : {};
  const model = args.model?.trim();
  switch (args.errorInfo) {
    case "modelNotFound":
      return {
        title: "Model not available",
        body: `Codex can't find ${model || "this model"}, or this account doesn't have access to it.`,
        nextAction: "Choose another model, then retry.",
        ...detail,
      };
    case "policyCapacityUnavailable":
      return {
        title: "No capacity available",
        body: "OpenAI's policy limits which servers can run this request, and none of them has room right now.",
        nextAction: "Retry in a few minutes, or choose another model.",
        ...detail,
      };
    default:
      return null;
  }
}
