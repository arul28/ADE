import type { DroidToolCategory } from "../../../shared/orchestrationRuntimePolicy";

export type { DroidToolCategory };

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
  /**
   * Droid tool categories to withhold from the model, resolved to concrete
   * `disabledToolIds` in the worker (tool ids are build-specific, categories
   * are not). Set for orchestrator-lead sessions so Droid's own editor and
   * terminal tools are dropped alongside ADE's.
   */
  disabledToolCategories?: readonly DroidToolCategory[] | null;
};

/**
 * Reduces a `session.listTools()` result to the ids ADE must disable.
 *
 * Droid's built-in tool ids vary by build and model (`edit_file`,
 * `apply-patch-cli`, `create-cli`, …), so ADE selects by the category Droid
 * itself reports rather than pinning a brittle id list.
 */
export function droidDisabledToolIdsForCategories(
  tools: ReadonlyArray<{ id?: unknown; category?: unknown }>,
  categories: readonly DroidToolCategory[],
): string[] {
  const denied = new Set<string>(categories);
  const ids: string[] = [];
  for (const tool of tools) {
    const id = typeof tool?.id === "string" ? tool.id.trim() : "";
    const category = typeof tool?.category === "string" ? tool.category : "";
    if (!id || !denied.has(category as DroidToolCategory)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Selects the live Droid MCP tools a lead must disable. MCP tools are not part
 * of `listTools()`'s native exec catalog; Droid exposes their per-session
 * enable switch through the low-level `toggleMcpTool` RPC instead.
 */
export function droidMcpToolsToDisable(
  tools: ReadonlyArray<{ serverName?: unknown; name?: unknown; isEnabled?: unknown }>,
  allowedServerNames: readonly string[],
): Array<{ serverName: string; toolName: string }> {
  const allowed = new Set(allowedServerNames.map((name) => name.trim()).filter(Boolean));
  const disabled: Array<{ serverName: string; toolName: string }> = [];
  for (const tool of tools) {
    const serverName = typeof tool?.serverName === "string" ? tool.serverName.trim() : "";
    const toolName = typeof tool?.name === "string" ? tool.name.trim() : "";
    // Unknown state is unsafe for a lead: disable anything that is not
    // explicitly reported as already disabled.
    if (!serverName || !toolName || allowed.has(serverName) || tool.isEnabled === false) continue;
    disabled.push({ serverName, toolName });
  }
  return disabled;
}

export type DroidSdkWorkerInit = {
  sessionId: string;
  laneRoot: string;
  droidPath: string;
  resumeSessionId?: string | null;
  settings: DroidSdkSessionSettings;
  mcpServers?: unknown[];
  /** MCP server names ADE owns and a lead may retain; all other tools are disabled per session. */
  allowedMcpServerNames?: string[];
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
