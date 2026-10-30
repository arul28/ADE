import type {
  AutoModeSwitchResponse,
  ElicitationResult,
  ExitPlanModeRequest,
  ExitPlanModeResult,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
} from "@github/copilot-sdk";
import type { AgentChatCopilotAutoTier, AgentChatCopilotContextTier } from "../../../shared/types/chat";

export type CopilotSdkWorkerInit = {
  cliPath: string;
  baseDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
};

export type CopilotSdkAttachment =
  | { type: "file"; path: string; displayName?: string }
  | { type: "blob"; data: string; mimeType: string; displayName?: string };

export type CopilotSdkSessionConfig = {
  chatId: string;
  sessionId?: string;
  cwd: string;
  model?: string;
  /** ADE's effort string; the worker passes on only the values Copilot accepts. */
  reasoningEffort?: string | null;
  contextTier?: AgentChatCopilotContextTier;
  autoTier?: AgentChatCopilotAutoTier | null;
  systemMessage?: string;
  skillDirectories?: string[];
  mcpServers?: SessionConfig["mcpServers"];
  disabledMcpServers?: string[];
  permissionMode?: string;
  /** Context use (0–1) at which Copilot starts compacting in the background; its default otherwise. */
  backgroundCompactionThreshold?: number;
  utility?: boolean;
};

/** The mode a sent message runs in; a plan prompt from `/plan` runs in `plan`. */
export type CopilotSdkAgentMode = "interactive" | "plan" | "autopilot";

/**
 * One of Copilot's slash commands, as `session.rpc.commands.list()` reports it
 * (the SDK does not export its `SlashCommandInfo`). Names carry no slash.
 */
export type CopilotSlashCommandInfo = {
  name: string;
  aliases?: string[];
  description: string;
  kind: string;
  allowDuringAgentExecution: boolean;
  input?: { hint?: string; required?: boolean } | null;
};

/** What `session.rpc.commands.invoke()` answers, by `kind` (the SDK's `SlashCommandInvocationResult`). */
export type CopilotSlashCommandResult =
  | { kind: "text"; text: string; markdown?: boolean }
  | { kind: "agent-prompt"; prompt: string; displayPrompt: string; mode?: string; notice?: string }
  | { kind: "completed"; message?: string; mode?: string }
  | { kind: "select-subcommand"; command: string; title: string; options: Array<{ name: string; description: string }> }
  | { kind: "add-timeline-entry"; entry: { type: string; text: string; url?: string }; prefillInput?: string }
  | { kind: "show-dialog"; dialog?: unknown }
  | { kind: "set-model"; model: string; warning?: string }
  | { kind: "set-plan-model"; planModel?: string; message: string };

export type CopilotSdkWorkerRequest =
  | { type: "init"; requestId: string; payload: CopilotSdkWorkerInit }
  | { type: "auth" | "models" | "account_quota" | "dispose"; requestId: string; payload?: { gitHubToken?: string } }
  | { type: "create" | "resume"; requestId: string; payload: CopilotSdkSessionConfig }
  | { type: "send"; requestId: string; payload: { chatId: string; prompt: string; attachments?: CopilotSdkAttachment[]; mode?: "enqueue" | "immediate"; agentMode?: CopilotSdkAgentMode; displayPrompt?: string } }
  | { type: "commands"; requestId: string; payload: { chatId: string } }
  | { type: "command"; requestId: string; payload: { chatId: string; name: string; input?: string } }
  | { type: "set_model"; requestId: string; payload: { chatId: string; model: string; reasoningEffort?: string | null; contextTier?: AgentChatCopilotContextTier; autoTier?: AgentChatCopilotAutoTier | null } }
  | { type: "set_auto_tier"; requestId: string; payload: { chatId: string; autoTier: AgentChatCopilotAutoTier | null } }
  | { type: "set_permission_mode"; requestId: string; payload: { chatId: string; permissionMode: string } }
  | { type: "fork_session"; requestId: string; payload: { chatId: string; sessionId: string; throughEventId?: string; throughMessageText?: string; throughMessageOrdinal?: number } }
  | { type: "rewind"; requestId: string; payload: { chatId: string; action: "list" | "preview" | "apply"; eventId?: string } }
  | { type: "usage_metrics"; requestId: string; payload: { chatId: string } }
  | { type: "abort" | "disconnect"; requestId: string; payload: { chatId: string } }
  | { type: "respond_permission"; requestId: string; payload: { waiterId: string; result: PermissionRequestResult } }
  | { type: "respond_exit_plan"; requestId: string; payload: { waiterId: string; result: ExitPlanModeResult } }
  | { type: "respond_user_input"; requestId: string; payload: { waiterId: string; response: { answer: string; wasFreeform: boolean } } }
  | { type: "respond_mcp_auth"; requestId: string; payload: { waiterId: string; result: { kind: "cancelled" } | { kind: "token"; accessToken: string; expiresIn: number } } }
  | { type: "respond_auto_mode_switch"; requestId: string; payload: { waiterId: string; result: AutoModeSwitchResponse } }
  | { type: "respond_elicitation"; requestId: string; payload: { waiterId: string; result: ElicitationResult } }
  | { type: "utility"; requestId: string; payload: { cwd: string; prompt: string; model?: string; systemMessage?: string } };

export type CopilotSdkWorkerResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "event"; chatId: string; event: unknown }
  | { type: "permission_request"; chatId: string; waiterId: string; request: PermissionRequest }
  | { type: "exit_plan_request"; chatId: string; waiterId: string; request: ExitPlanModeRequest }
  | { type: "user_input_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "mcp_auth_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "auto_mode_switch_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "elicitation_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };

export type CopilotSdkWaiterType = "permission_request" | "exit_plan_request" | "user_input_request" | "mcp_auth_request" | "auto_mode_switch_request" | "elicitation_request";

/**
 * Per waiter: the request that carries ADE's answer back to the worker, and the
 * answer used when nobody can give one (the chat stopped, a handler failed).
 * A fallback never approves anything.
 */
export const COPILOT_SDK_WAITERS = {
  permission_request: { respondType: "respond_permission", payloadKey: "result", fallback: { kind: "reject" } },
  exit_plan_request: { respondType: "respond_exit_plan", payloadKey: "result", fallback: { approved: false, feedback: "ADE could not review this plan; the chat was interrupted or closed." } },
  user_input_request: { respondType: "respond_user_input", payloadKey: "response", fallback: { answer: "", wasFreeform: true } },
  mcp_auth_request: { respondType: "respond_mcp_auth", payloadKey: "result", fallback: { kind: "cancelled" } },
  auto_mode_switch_request: { respondType: "respond_auto_mode_switch", payloadKey: "result", fallback: "no" },
  elicitation_request: { respondType: "respond_elicitation", payloadKey: "result", fallback: { action: "cancel" } },
} as const satisfies Record<
  CopilotSdkWaiterType,
  { respondType: CopilotSdkWorkerRequest["type"]; payloadKey: "result" | "response"; fallback: unknown }
>;

/** Worker answers to the `rewind` request, one per action. */
export type CopilotRewindListing = {
  fileChangeTrackingEnabled: boolean;
  unavailableReason?: string;
  points: Array<{ eventId: string; userMessage: string; canRestoreFiles: boolean; linesAdded: number; linesRemoved: number; isAutopilotContinuation?: boolean }>;
};
export type CopilotRewindPreview = { available: boolean; reason?: string; files: Array<{ path: string; linesAdded: number; linesRemoved: number }> };
export type CopilotRewindResult = { outcome: string; restoredFiles: string[]; skippedFiles: Array<{ path: string; reason: string }>; error?: string };
