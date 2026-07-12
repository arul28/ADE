export type DroidSdkAutonomyLevel = "off" | "low" | "medium" | "high";
// `agi` puts Droid in orchestrator mode: it decomposes a mission into features
// and spawns worker sub-sessions (surfaced to ADE as subagents) while keeping
// read-only tools at the top level.
export type DroidSdkInteractionMode = "auto" | "spec" | "agi";
export type DroidSdkReasoningEffort =
  | "none"
  | "dynamic"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type DroidSdkSessionSettings = {
  modelId: string;
  autonomyLevel: DroidSdkAutonomyLevel;
  interactionMode: DroidSdkInteractionMode;
  reasoningEffort?: DroidSdkReasoningEffort | null;
  specModeModelId?: string | null;
  specModeReasoningEffort?: DroidSdkReasoningEffort | null;
};

export type DroidSdkWorkerInit = {
  sessionId: string;
  laneRoot: string;
  droidPath: string;
  resumeSessionId?: string | null;
  settings: DroidSdkSessionSettings;
  mcpServers?: unknown[];
};

export type DroidSdkUserImage = {
  data: string;
  mimeType: string;
};

export type DroidSdkSendPrompt = {
  promptText: string;
  images?: DroidSdkUserImage[];
  settings: DroidSdkSessionSettings;
};

export type DroidSdkReady = {
  sessionId: string;
  currentModelId: string | null;
  availableModels: Array<{
    id: string;
    modelId?: string | null;
    displayName?: string | null;
    shortDisplayName?: string | null;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
    isCustom?: boolean;
  }>;
};

export type DroidSdkPermissionRequest = {
  id: string;
  title: string;
  summary: string;
  toolName: string;
  toolInput?: unknown;
  toolUseIds: string[];
  options: Array<{
    label: string;
    value: string;
  }>;
  raw: unknown;
};

export type DroidSdkPermissionDecision = {
  selectedOption: string;
  comment?: string;
};

// Mirrors the Droid SDK `AskUserQuestion` shape (@factory/droid-sdk
// `AskUserRequestParamsSchema`). The SDK exposes exactly `topic`, `question`,
// and `options: string[]` per question — there is no per-option description,
// no multiSelect/allowMultiple flag, and no default-value field, so options are
// surfaced as bare choices and the topic becomes the question header. Display
// labels may be trimmed, but values preserve Droid's original option strings.
// This is the full ceiling of the Droid ask-user contract.
export type DroidSdkAskUserRequest = {
  id: string;
  toolCallId: string;
  title: string;
  questions: Array<{
    id: string;
    /** Droid's per-question `topic` (short label), surfaced as the card header. */
    header?: string;
    question: string;
    /** Droid options are plain strings; value preserves the exact SDK string. */
    options?: Array<{ label: string; value: string }>;
  }>;
  raw: unknown;
};

export type DroidSdkAskUserResponse = {
  cancelled: boolean;
  answers: Array<{
    index: number;
    question: string;
    answer: string;
  }>;
};

export type DroidSdkRunResult = {
  sessionId: string;
  tokenUsage?: unknown;
  success: boolean;
  error?: unknown;
};

export type DroidSdkWorkerRequest =
  | { type: "init"; requestId: string; payload: DroidSdkWorkerInit }
  | { type: "send"; requestId: string; payload: DroidSdkSendPrompt }
  | { type: "settings_update"; requestId: string; payload: DroidSdkSessionSettings }
  | { type: "cancel"; requestId: string }
  | { type: "dispose"; requestId: string }
  | { type: "kill_worker"; requestId: string; payload: { workerSessionId: string } }
  | { type: "fork_session"; requestId: string }
  | { type: "permission_response"; requestId: string; payload: DroidSdkPermissionDecision }
  | { type: "ask_user_response"; requestId: string; payload: DroidSdkAskUserResponse };

export type DroidSdkWorkerResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "ready"; ready: DroidSdkReady }
  | { type: "sdk_event"; event: unknown }
  | { type: "permission_request"; requestId: string; request: DroidSdkPermissionRequest }
  | { type: "ask_user_request"; requestId: string; request: DroidSdkAskUserRequest }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };
