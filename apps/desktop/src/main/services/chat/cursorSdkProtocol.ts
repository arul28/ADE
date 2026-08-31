export type CursorSdkChatMode = "agent" | "ask" | "plan";
export type CursorSdkApprovalPolicy = "on-request" | "read-only" | "never";
export type CursorSdkSandboxMode = "ade" | "cursor-native" | "off";
export type CursorSdkAgentMode = "agent" | "plan";

export type CursorSdkErrorDetail = {
  message?: string;
  code?: string;
  status?: number;
  isRetryable?: boolean;
  requestId?: string;
  operation?: string;
  endpoint?: string;
  name?: string;
};

export type CursorSdkErrorKind = "auth" | "rate_limit" | "network" | "busy" | "not_found" | "unknown";

export type CursorSdkPermissionPolicy = {
  chatMode: CursorSdkChatMode;
  approvalPolicy: CursorSdkApprovalPolicy;
  sandbox: CursorSdkSandboxMode;
  /**
   * The session runs under ADE's `full-auto` permission mode. This is a
   * permission-mode marker only: it separates full-auto sessions into their own
   * worker pool and labels logs. It deliberately does NOT map onto the Cursor
   * SDK's `local.force` — that option expires an active run, which is a
   * recovery action, not a permission level. See `forceExpireActiveRun`.
   */
  fullAuto: boolean;
  hardGuards: boolean;
  /**
   * Orchestrator-lead sessions may only ever run read-risk tools. Carried on
   * the policy (rather than derived at the hook) so it reaches the out-of-band
   * hook server in `cursorSdkWorker` through the existing policy plumbing.
   */
  orchestrationLead: boolean;
  /**
   * An external embedder asked to withhold the user's own MCP configuration
   * from this chat. Cursor has no "managed servers only" switch, so this rides
   * the same trimmed `local.settingSources` an orchestrator lead uses. Optional
   * so every existing policy literal stays valid and unchanged.
   */
  strictMcpConfig?: boolean;
  /**
   * Cursor Auto-review for local tool calls (`local.autoReview`). Backs ADE's
   * middle-trust `agent` mode. This is a boolean on `local`, not an SDK `mode`
   * value — never pass `"auto"` as `AgentOptions.mode` (only `"agent"` | `"plan"`).
   */
  autoReview: boolean;
  /**
   * Local-only built-in tool allowlist (`AgentOptions.tools`). Omitted means
   * the SDK default toolset. The SDK does not persist this: pass it again on
   * every `resumeAgent`. Combining `tools` with `cloud` throws
   * `ConfigurationError` — never set this on cloud create.
   */
  tools?: readonly string[];
  /**
   * Local-only built-in tool denylist (`AgentOptions.disallowedTools`). Deny
   * wins when combined with `tools`. Same local-only / resume / no-cloud rules
   * as `tools`.
   */
  disallowedTools?: readonly string[];
};

export type CursorSdkModelParameterValue = {
  id: string;
  value: string;
};

export type CursorSdkHookDecision =
  | {
      permission: "allow";
    }
  | {
      permission: "deny";
      user_message: string;
      agent_message: string;
    };

export type CursorSdkHookRequest = {
  id: string;
  toolName: string;
  title: string;
  summary: string;
  cwd: string;
  raw: unknown;
  toolInput?: unknown;
  risk: "read" | "write" | "shell" | "network" | "task" | "unknown";
  reason?: string | null;
};

export type CursorSdkWorkerInit = {
  sessionId: string;
  laneRoot: string;
  userHomeDir: string;
  stateRoot: string;
  socketPath: string;
  modelSdkId: string;
  modelParams?: CursorSdkModelParameterValue[];
  apiKey?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  policy: CursorSdkPermissionPolicy;
  mcpServers?: Record<string, unknown>;
};

/**
 * Worker-IPC image reference. Prefer `path` or `url` — never put multi-megabyte
 * screenshot bytes on this object. The worker materializes `{ data, mimeType }`
 * for `@cursor/sdk` locally. `data` remains for tests and tiny inline cases.
 * Path images include `rootPath` so the worker re-opens through the same
 * attachment sandbox the main process used to use.
 */
export type CursorSdkUserImage =
  | { path: string; mimeType: string; rootPath: string }
  | { data: string; mimeType: string }
  | { url: string };

export type CursorSdkSendPrompt = {
  promptText: string;
  images?: CursorSdkUserImage[];
  modelSdkId?: string | null;
  modelParams?: CursorSdkModelParameterValue[];
  /**
   * Maps to the SDK's `local.force` ("expire the currently active persisted
   * run before starting this message as a new follow-up run"). Set only on
   * ADE's automatic recovery re-send, where the previous run may still be
   * registered as active on a thread that stopped answering. Normal sends must
   * never set it — expiring a genuinely running turn would drop its output.
   */
  forceExpireActiveRun?: boolean;
  idempotencyKey?: string | null;
  mode?: CursorSdkAgentMode;
};

export type CursorSdkCloudRepoOverride = {
  url: string;
  startingRef?: string | null;
  prUrl?: string | null;
};

export type CursorSdkCloudSendStreamPayload = {
  apiKey?: string | null;
  promptText: string;
  images?: CursorSdkUserImage[];
  modelSdkId?: string | null;
  modelParams?: CursorSdkModelParameterValue[];
  idempotencyKey?: string | null;
  mode?: CursorSdkAgentMode;
  agentName?: string | null;
  repoUrl: string;
  startingRef?: string | null;
  prUrl?: string | null;
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  envType?: "cloud" | "pool" | "machine" | null;
  envName?: string | null;
  sessionId?: string | null;
  laneId?: string | null;
  projectId?: string | null;
  linearIssueId?: string | null;
  envVars?: Record<string, string> | null;
};

export type CursorSdkCloudFollowupPayload = {
  apiKey?: string | null;
  agentId: string;
  promptText: string;
  images?: CursorSdkUserImage[];
  modelSdkId?: string | null;
  modelParams?: CursorSdkModelParameterValue[];
  idempotencyKey?: string | null;
  mode?: CursorSdkAgentMode;
};

export type CursorSdkCloudRunCancelPayload = {
  apiKey?: string | null;
  agentId: string;
  runId: string;
};

export type CursorSdkCloudArtifactDescriptor = {
  path: string;
  sizeBytes: number;
  updatedAt: string;
};

export type CursorSdkCloudArtifactDownloadResult = {
  path: string;
  contents: string;
  mimeType: string | null;
  sizeBytes: number;
};

export type CursorSdkCloudRunStartedResult = {
  agentId: string;
  runId: string;
  agentName?: string | null;
  modelSdkId?: string | null;
  status?: string;
};

export type CursorSdkWorkerRequest =
  | { type: "init"; requestId: string; payload: CursorSdkWorkerInit }
  | { type: "send"; requestId: string; payload: CursorSdkSendPrompt }
  | { type: "policy_update"; requestId: string; payload: CursorSdkPermissionPolicy }
  | { type: "cancel"; requestId: string }
  | { type: "dispose"; requestId: string }
  | { type: "catalog.models"; requestId: string; payload: { apiKey?: string | null } }
  | { type: "catalog.repositories"; requestId: string; payload: { apiKey?: string | null } }
  | {
      type: "cloud.agents.list";
      requestId: string;
      payload: { apiKey?: string | null; includeArchived?: boolean; limit?: number; cursor?: string | null };
    }
  | {
      type: "cloud.runs.list";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; limit?: number; cursor?: string | null };
    }
  | {
      type: "cloud.run.get";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; runId: string };
    }
  | {
      type: "cloud.agent.get";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string };
    }
  | {
      type: "cloud.agent.archive";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string };
    }
  | {
      type: "cloud.agent.unarchive";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string };
    }
  | {
      type: "cloud.agent.delete";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string };
    }
  | {
      type: "cloud.send.stream";
      requestId: string;
      payload: CursorSdkCloudSendStreamPayload;
    }
  | {
      type: "cloud.followup";
      requestId: string;
      payload: CursorSdkCloudFollowupPayload;
    }
  | {
      type: "cloud.run.cancel";
      requestId: string;
      payload: CursorSdkCloudRunCancelPayload;
    }
  | {
      type: "cloud.run.attach";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; runId: string };
    }
  | {
      type: "cloud.run.conversation";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; runId: string };
    }
  | {
      type: "cloud.artifacts.list";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string };
    }
  | {
      type: "cloud.artifacts.download";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; path: string };
    }
  | {
      type: "agent.getUsage";
      requestId: string;
      payload: { apiKey?: string | null; agentId: string; runId?: string | null };
    }
  | { type: "hook_response"; requestId: string; payload: CursorSdkHookDecision };

export type CursorSdkRuntime = "local" | "cloud";

export type CursorSdkWorkerResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: string;
      errorCode?: string;
      errorDetail?: CursorSdkErrorDetail;
    }
  | { type: "ready"; agentId: string; modelSdkId: string; transport: "sdk" }
  | {
      type: "run_started";
      agentId: string;
      runId: string;
      modelSdkId?: string | null;
      modelParams?: CursorSdkModelParameterValue[];
      runtime?: CursorSdkRuntime;
      requestId?: string;
      sdkRequestId?: string;
    }
  | {
      type: "sdk_event";
      event: unknown;
      runtime?: CursorSdkRuntime;
      runId?: string;
      agentId?: string;
      requestId?: string;
      sdkRequestId?: string;
      errorDetail?: CursorSdkErrorDetail;
    }
  | {
      type: "run_result";
      result: unknown;
      runtime?: CursorSdkRuntime;
      runId?: string;
      agentId?: string;
      requestId?: string;
      sdkRequestId?: string;
      /**
       * Terminal run error detail read from the SDK run/result/store when a run
       * ends in ERROR. Cursor stream status events often carry no reason, so the
       * worker surfaces it here for logging + classification.
       */
      errorCode?: string;
      errorDetail?: CursorSdkErrorDetail;
    }
  | {
      type: "run_status";
      runtime: CursorSdkRuntime;
      agentId: string;
      runId: string;
      status: string;
      requestId?: string;
      sdkRequestId?: string;
    }
  | { type: "hook_request"; requestId: string; request: CursorSdkHookRequest }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };

/**
 * True when an error string looks like a transport/network failure (HTTP/2
 * stream resets, dropped sockets, connection refused/timeouts) rather than a
 * model- or policy-level error. Callers use this to mark an error as
 * a transport failure. Matches on substrings so it works against both thrown
 * Error messages and the SDK run store's `errorCode` text (e.g.
 * "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR").
 */
export function isCursorSdkTransportErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes("nghttp2")
    || lower.includes("http/2")
    || lower.includes("econnreset")
    || lower.includes("econnrefused")
    || lower.includes("etimedout")
    // `[internal] write ECANCELED` / `EPIPE` / `write after end` are the
    // socket-side cousins of an NGHTTP2 reset: the SDK's write to the agent
    // stream was cancelled or the pipe was torn down under it. They poison the
    // server-side agent thread the same way, so they must classify as
    // transport failures rather than leaking raw internals into chat.
    || lower.includes("ecanceled")
    || lower.includes("epipe")
    || lower.includes("write after end")
    || lower.includes("socket hang up")
    || lower.includes("stream closed with error");
}

export function isCursorSdkBackoffErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes("resource_exhausted")
    || lower.includes("resource exhausted")
    || lower.includes("rate_limited")
    || lower.includes("rate limited")
    || lower.includes("rate limit")
    || lower.includes("too many requests")
    || lower.includes("enhance_your_calm")
    || lower.includes("enhance your calm")
    || lower.includes("usage limits exceeded")
    || lower.includes("quota exceeded")
    || lower.includes("slow down")
    || lower.includes("back off")
    || lower.includes("429");
}

/**
 * The exact text the Cursor SDK surfaces for an expired short-lived access
 * token. Kept here so the matcher, the bridge's fallback and the terminal
 * copy all read one greppable literal.
 */
export const CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT =
  "Authentication error If you are logged in, try logging out and back in.";

/**
 * The two halves of that sentence, split around the clause the SDK sometimes
 * reflows and stripped of the trailing period — matching both independently is
 * what keeps the check robust to the request-id suffix and to casing, without
 * widening it to "authentication error" alone.
 */
const STALE_ACCESS_TOKEN_FRAGMENTS = CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT
  .toLowerCase()
  .replace(/\.$/, "")
  .split(" if you are ");

/**
 * True for the one auth failure ADE can fix on its own: the SDK's short-lived
 * access token (exchanged once per executor from the user API key) expired
 * mid-session, and the SDK only re-exchanges on a Connect `Unauthenticated`
 * fault — never on this in-stream shape. Every later send on the same worker
 * then fails instantly with the identical text until the worker is replaced.
 *
 * Deliberately narrow: it must not match a genuinely bad API key ("Invalid API
 * key", 401/403), where retrying on a fresh worker would fail the same way.
 * The SDK spells this one exactly, as the error message and often again as the
 * structured `code`:
 *   "Authentication error If you are logged in, try logging out and back in."
 */
export function isCursorSdkStaleAccessTokenText(
  ...texts: Array<string | null | undefined>
): boolean {
  const joined = texts.filter(Boolean).join("\n").toLowerCase();
  if (!joined) return false;
  return STALE_ACCESS_TOKEN_FRAGMENTS.every((fragment) => joined.includes(fragment));
}

/** One turn's suppressed stale-token failure, kept so it can be re-thrown. */
export type CursorSdkStaleTokenFailure = {
  turnId: string;
  message: string;
  code?: string;
  requestId?: string;
};

/**
 * Reads the worker's synthetic terminal `status: ERROR` event as a stale-token
 * failure, or returns null when it is any other error. One pass over
 * `adeErrorCode` / `adeErrorDetail` yields both the decision and the payload,
 * so the caller never re-reads the same four fields to build one.
 */
export function readCursorSdkStaleTokenFailure(
  event: unknown,
  turnId: string,
): CursorSdkStaleTokenFailure | null {
  const record = (event && typeof event === "object" ? event : null) as Record<string, unknown> | null;
  if (!record) return null;
  const detail = (record.adeErrorDetail && typeof record.adeErrorDetail === "object"
    ? record.adeErrorDetail
    : null) as Record<string, unknown> | null;
  const readString = (value: unknown): string | null => (
    typeof value === "string" && value.trim().length ? value.trim() : null
  );
  const errorCode = readString(record.adeErrorCode);
  const eventMessage = readString(record.message);
  const detailMessage = readString(detail?.message);
  const detailCode = readString(detail?.code);
  const requestId = readString(detail?.requestId);
  if (!isCursorSdkStaleAccessTokenText(errorCode, eventMessage, detailMessage, detailCode)) {
    return null;
  }
  return {
    turnId,
    message: detailMessage ?? errorCode ?? CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT,
    ...(detailCode ? { code: detailCode } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function classifyCursorSdkErrorText(
  ...texts: Array<string | null | undefined>
): CursorSdkErrorKind {
  const joined = texts.filter(Boolean).join("\n").toLowerCase();
  if (!joined) return "unknown";
  if (
    joined.includes("agent_busy")
    || joined.includes("agent busy")
    || joined.includes("already has an active run")
    || joined.includes("active run in progress")
    || joined.includes("already running another task")
  ) {
    return "busy";
  }
  if (isCursorSdkBackoffErrorText(joined)) return "rate_limit";
  if (isCursorSdkTransportErrorText(joined)) return "network";
  if (
    joined.includes("agent_not_found")
    || joined.includes("agent not found")
    || joined.includes("not found (operation=agent.resume")
  ) {
    return "not_found";
  }
  if (
    joined.includes("unauthorized")
    || joined.includes("forbidden")
    || joined.includes("authentication")
    || joined.includes("invalid api key")
  ) {
    return "auth";
  }
  return "unknown";
}
