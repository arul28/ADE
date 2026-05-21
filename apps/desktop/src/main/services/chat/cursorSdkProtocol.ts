export type CursorSdkChatMode = "agent" | "ask" | "plan";
export type CursorSdkApprovalPolicy = "on-request" | "read-only" | "never";
export type CursorSdkSandboxMode = "ade" | "cursor-native" | "off";

export type CursorSdkPermissionPolicy = {
  chatMode: CursorSdkChatMode;
  approvalPolicy: CursorSdkApprovalPolicy;
  sandbox: CursorSdkSandboxMode;
  force: boolean;
  hardGuards: boolean;
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
  | { type: "response"; requestId: string; ok: false; error: string; errorCode?: string }
  | { type: "ready"; agentId: string; modelSdkId: string; transport: "sdk" }
  | {
      type: "run_started";
      agentId: string;
      runId: string;
      modelSdkId?: string | null;
      runtime?: CursorSdkRuntime;
      requestId?: string;
    }
  | {
      type: "sdk_event";
      event: unknown;
      runtime?: CursorSdkRuntime;
      runId?: string;
      agentId?: string;
      requestId?: string;
    }
  | {
      type: "run_result";
      result: unknown;
      runtime?: CursorSdkRuntime;
      runId?: string;
      agentId?: string;
      requestId?: string;
    }
  | {
      type: "run_status";
      runtime: CursorSdkRuntime;
      agentId: string;
      runId: string;
      status: string;
      requestId?: string;
    }
  | { type: "hook_request"; requestId: string; request: CursorSdkHookRequest }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };
