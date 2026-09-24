/**
 * Pieces every ACP dialect reuses.
 *
 * Keep provider-specific rules out of this file. A value here must be true for
 * all four providers, or it belongs in the dialect that needs it.
 */

import type {
  AcpImagePromptBehavior,
  AcpLoadBehavior,
  AcpMcpInjectionBehavior,
  AcpResumeBehavior,
  AcpCloseBehavior,
  AcpModelSelectionBehavior,
  AcpSessionConfigBehavior,
  AcpUsageBehavior,
  AcpUsageSample,
  AcpExtensionNotificationReader,
} from "../acpHostTypes";
import { ACP_METHOD, type AcpPromptUsage } from "../acpProtocolTypes";
import { readFiniteNumber } from "../acpTelemetryReaders";
import { uncachedInputTokens } from "../../../usage/tokenSplit";
import { asRecord } from "../../../shared/utils";

/** ADE's identity at `initialize`. */
export const ADE_CLIENT_INFO = {
  name: "ade",
  title: "ADE",
  version: "1",
} as const;

/** Standard `session/resume`. */
export const standardResume: AcpResumeBehavior = ({ sessionId, cwd, mcpServers }) => ({
  method: ACP_METHOD.sessionResume,
  params: { sessionId, cwd, mcpServers },
});

/** Standard `session/load`. */
export const standardLoad: AcpLoadBehavior = ({ sessionId, cwd, mcpServers }) => ({
  method: ACP_METHOD.sessionLoad,
  params: { sessionId, cwd, mcpServers },
});

/** Standard `session/close`. */
export const standardClose: AcpCloseBehavior = ({ sessionId }) => ({
  method: ACP_METHOD.sessionClose,
  params: { sessionId },
});

/** Standard `session/set_config_option`. */
export const standardSetConfigOption: AcpSessionConfigBehavior = ({ sessionId, configId, value }) => ({
  method: ACP_METHOD.sessionSetConfigOption,
  params:
    typeof value === "boolean"
      ? { sessionId, configId, type: "boolean", value }
      : { sessionId, configId, value },
});

/** Copilot's model setter is a provider-native ACP method, not a config option. */
export const standardSetModel: AcpModelSelectionBehavior = ({ sessionId, modelId }) => ({
  method: ACP_METHOD.sessionSetModel,
  params: { sessionId, modelId },
});

/**
 * Keep only the MCP transports the agent said it supports.
 *
 * A stdio server needs no capability flag; it is the protocol baseline. HTTP
 * and SSE servers are dropped when the agent did not advertise them, because
 * an agent that cannot reach the transport will fail the whole session rather
 * than skip one server.
 */
export const transportGatedMcpInjection: AcpMcpInjectionBehavior = ({
  servers,
  agentSupportsHttp,
  agentSupportsSse,
}) =>
  servers.filter((server) => {
    if (server.type === "http") return agentSupportsHttp;
    if (server.type === "sse") return agentSupportsSse;
    return true;
  });

/** Inline base64 image prompt block. */
export const inlineImagePrompt: AcpImagePromptBehavior = ({ base64Data, mimeType, uri }) => ({
  type: "image",
  data: base64Data,
  mimeType,
  ...(uri ? { uri } : {}),
});

/**
 * Set an environment variable only when the value exists.
 *
 * An empty string is a real value to most CLIs, and it usually means "no
 * config home". Omitting the key lets the provider use its own default.
 */
export function withOptionalEnv(
  base: NodeJS.ProcessEnv,
  entries: Record<string, string | null | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.length) env[key] = value;
  }
  return env;
}

/**
 * Read the ACP `session/prompt` result `usage` (the unstable Usage schema that
 * Copilot and Kimi both implement). `inputTokens` there counts the cache, so
 * the sample carries the uncached share.
 */
export function readAcpPromptUsage(promptUsage: AcpPromptUsage | null | undefined): AcpUsageSample | null {
  if (!promptUsage) return null;
  const input = readFiniteNumber(promptUsage.inputTokens);
  const output = readFiniteNumber(promptUsage.outputTokens);
  const total = readFiniteNumber(promptUsage.totalTokens);
  const cacheRead = readFiniteNumber(promptUsage.cachedReadTokens);
  const cacheWrite = readFiniteNumber(promptUsage.cachedWriteTokens);
  const reasoning = readFiniteNumber(promptUsage.thoughtTokens);
  const sample: AcpUsageSample = {
    ...(input !== undefined ? { inputTokens: uncachedInputTokens(input, cacheRead, cacheWrite) } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
  return Object.keys(sample).length ? sample : null;
}

/**
 * The standard ACP usage reader: `usage_update` is context occupancy, and the
 * prompt result `usage` is the turn's token counts. Either may be absent;
 * absence stays absence.
 */
export const standardAcpUsage: AcpUsageBehavior = ({ usageUpdate, promptUsage }) => {
  if (usageUpdate) {
    return {
      contextUsedTokens: usageUpdate.used,
      contextWindowTokens: usageUpdate.size,
      ...(usageUpdate.cost && usageUpdate.cost.currency.toUpperCase() === "USD"
        ? { costUsd: usageUpdate.cost.amount }
        : {}),
    };
  }
  return readAcpPromptUsage(promptUsage);
};

/**
 * Register an extension reader under both spellings of its method. The ACP
 * SDK a provider ships decides whether extension methods carry the leading
 * underscore (Grok 1.0.13 sent `x.ai/...`, 1.0.40 sends `_x.ai/...`).
 */
export function extensionMethodVariants(
  method: string,
  reader: AcpExtensionNotificationReader,
): Record<string, AcpExtensionNotificationReader> {
  const bare = method.replace(/^_/, "");
  return { [bare]: reader, [`_${bare}`]: reader };
}

/** Session id an extension payload names, or `null` for a process-wide one. */
export function extensionSessionId(params: unknown): string | null {
  const sessionId = asRecord(params)?.sessionId;
  return typeof sessionId === "string" && sessionId.length ? sessionId : null;
}
