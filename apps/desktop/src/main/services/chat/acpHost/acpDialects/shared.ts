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
  AcpSessionConfigBehavior,
} from "../acpHostTypes";
import { ACP_METHOD } from "../acpProtocolTypes";

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
