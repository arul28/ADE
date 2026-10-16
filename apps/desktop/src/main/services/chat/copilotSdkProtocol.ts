import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";

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
  reasoningEffort?: string | null;
  systemMessage?: string;
  skillDirectories?: string[];
  mcpServers?: Record<string, unknown>;
  disabledMcpServers?: string[];
  permissionMode?: string;
  utility?: boolean;
};

export type CopilotSdkWorkerRequest =
  | { type: "init"; requestId: string; payload: CopilotSdkWorkerInit }
  | { type: "auth" | "models" | "dispose"; requestId: string }
  | { type: "create" | "resume"; requestId: string; payload: CopilotSdkSessionConfig }
  | { type: "send"; requestId: string; payload: { chatId: string; prompt: string; attachments?: CopilotSdkAttachment[]; mode?: "enqueue" | "immediate" } }
  | { type: "set_model"; requestId: string; payload: { chatId: string; model: string; reasoningEffort?: string | null } }
  | { type: "abort" | "disconnect"; requestId: string; payload: { chatId: string } }
  | { type: "respond_permission"; requestId: string; payload: { waiterId: string; result: PermissionRequestResult } }
  | { type: "respond_user_input"; requestId: string; payload: { waiterId: string; response: { answer: string; wasFreeform: boolean } } }
  | { type: "respond_mcp_auth"; requestId: string; payload: { waiterId: string; result: { kind: "cancelled" } | { kind: "token"; accessToken: string; expiresIn: number } } }
  | { type: "utility"; requestId: string; payload: { cwd: string; prompt: string; model?: string; systemMessage?: string } };

export type CopilotSdkWorkerResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "event"; chatId: string; event: unknown }
  | { type: "permission_request"; chatId: string; waiterId: string; request: PermissionRequest }
  | { type: "user_input_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "mcp_auth_request"; chatId: string; waiterId: string; request: unknown }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };

