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

export type CursorSdkErrorClassification = {
  kind: CursorSdkErrorKind;
  retryable: boolean;
};

export type CursorSdkPermissionPolicy = {
  chatMode: CursorSdkChatMode;
  approvalPolicy: CursorSdkApprovalPolicy;
  sandbox: CursorSdkSandboxMode;
  force: boolean;
  hardGuards: boolean;
  /**
   * Orchestrator-lead sessions may only ever run read-risk tools. Carried on
   * the policy (rather than derived at the hook) so it reaches the out-of-band
   * hook server in `cursorSdkWorker` through the existing policy plumbing.
   */
  orchestrationLead: boolean;
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

export type CursorSdkUserImage = {
  data: string;
  mimeType: string;
};

export type CursorSdkSendPrompt = {
  promptText: string;
  images?: CursorSdkUserImage[];
  modelSdkId?: string | null;
  modelParams?: CursorSdkModelParameterValue[];
  force?: boolean;
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
};

export type CursorSdkCloudFollowupPayload = {
  apiKey?: string | null;
  agentId: string;
  promptText: string;
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
 * potentially retryable. Matches on substrings so it works against both thrown
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

export function classifyCursorSdkErrorText(
  ...texts: Array<string | null | undefined>
): CursorSdkErrorClassification {
  const joined = texts.filter(Boolean).join("\n").toLowerCase();
  if (!joined) return { kind: "unknown", retryable: false };
  if (
    joined.includes("agent_busy")
    || joined.includes("agent busy")
    || joined.includes("already has an active run")
    || joined.includes("active run in progress")
    || joined.includes("already running another task")
  ) {
    return { kind: "busy", retryable: false };
  }
  if (isCursorSdkBackoffErrorText(joined)) return { kind: "rate_limit", retryable: true };
  if (isCursorSdkTransportErrorText(joined)) return { kind: "network", retryable: true };
  if (
    joined.includes("agent_not_found")
    || joined.includes("agent not found")
    || joined.includes("not found (operation=agent.resume")
  ) {
    return { kind: "not_found", retryable: false };
  }
  if (
    joined.includes("unauthorized")
    || joined.includes("forbidden")
    || joined.includes("authentication")
    || joined.includes("invalid api key")
  ) {
    return { kind: "auth", retryable: false };
  }
  return { kind: "unknown", retryable: false };
}
