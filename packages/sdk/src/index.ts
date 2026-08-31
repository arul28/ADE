/**
 * `@ade-dev/sdk` — a typed Node/Electron-main client that spawns and owns a slim
 * ADE runtime and exposes chat as durable named threads.
 *
 *   const ade = await createAdeChat({ home: app.getPath("userData") + "/ade" });
 *   const thread = await ade.threads.open("support", {
 *     provider: "claude",
 *     model: "claude-sonnet-4-5",
 *     permissions: "always-allow",
 *   });
 *   thread.on("event", (envelope) => render(envelope));
 *   await thread.send("summarise today's incidents");
 *
 * The runtime is a child process: it dies with `dispose()` and with the host.
 * Thread keys are stable across restarts — reopening `"support"` resumes the
 * same conversation.
 *
 * ONE CAVEAT WORTH READING BEFORE YOU SHIP. `loadUserMcpServers: false` (the
 * default) is a real guarantee only on Claude. On Codex, Cursor, Droid and
 * OpenCode it is best-effort — the gap is in those providers' own SDKs, not in
 * ADE — and Pi has no MCP surface at all, so it refuses injected servers rather
 * than opening a tool-less thread. Every thread that requested MCP reports what
 * it actually got:
 *
 *   const thread = await ade.threads.open("k", { provider, model, mcpServers });
 *   if (thread.mcpCapability?.level !== "enforced") {
 *     warnUser(thread.mcpCapability?.residual);
 *   }
 *
 * Do not tell your users "only your tools are loaded" without checking that.
 * See `ThreadOpenOptions.loadUserMcpServers` for the per-provider table, whose
 * source of truth is `CALLER_MCP_SUPPORT` in ADE itself
 * (`apps/desktop/src/shared/callerMcpServers.ts`).
 */

export { createAdeChat } from "./client.js";
export type {
  AdeChatClient,
  CreateAdeChatOptions,
  ThreadOpenOptions,
  ThreadResumeOptions,
} from "./client.js";

export type {
  AdeThread,
  SendOptions,
  ThreadEventChannel,
  SetModelOptions,
  ThreadModelSelection,
} from "./thread.js";
export { AdeError, type AdeErrorCode } from "./errors.js";
export type { PermissionPreset } from "./permissions.js";
export { SUPPORTED_PROVIDERS } from "./permissions.js";

export {
  resolveRuntimeSocketPath,
  isNamedPipePath,
  endpointComparisonKey,
} from "./socketPath.js";

export {
  assetUrl,
  parseChecksums,
  resolveRuntimeTarget,
  runtimeSpawnEnv,
  DEFAULT_RELEASE_REPO,
  type DownloadRequest,
  type DownloadResult,
  type RuntimeDownloader,
  type RuntimeTarget,
} from "./download.js";

export type {
  AdeProvider,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatSessionStatus,
  AgentChatSessionSummary,
  DoctorReport,
  KnownAgentChatEvent,
  McpCapabilityReport,
  McpServerConfig,
  ModelCatalogEntry,
  ProviderStatus,
  ThreadSummary,
  Unsubscribe,
} from "./types.js";
