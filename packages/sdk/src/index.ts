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

export { createAdeChat, ADE_CLIENT_EVENTS } from "./client.js";
export type {
  AdeChatClient,
  AdeClientEvent,
  AdeClientEventMap,
  CreateAdeChatOptions,
  ThreadOpenOptions,
  ThreadRefreshOptions,
  ThreadResumeOptions,
} from "./client.js";

export type {
  AdeThread,
  HistoryPageOptions,
  SendOptions,
  SetModelResult,
  SteerOptions,
  ThreadEventChannel,
  SetModelOptions,
  ThreadModelSelection,
  ThreadUpdate,
  ThreadUpdateOptions,
  ThreadUpdateResult,
  ThreadRerunResult,
  EditLastOptions,
} from "./thread.js";
export { SUPPORTED_RUNTIME_RANGE, checkRuntimeCompatibility } from "./compatibility.js";
export { parseToolIdentity, type ToolIdentity } from "./toolIdentity.js";
export { inferAttachmentType } from "./attachments.js";
export type { McpHeadersResolver } from "./mcpHeaders.js";
export {
  resolvePackagedRuntime,
  type PackagedRuntime,
  type ResolvePackagedRuntimeOptions,
} from "./packagedRuntime.js";
export { AdeError, type AdeErrorCode } from "./errors.js";
export { SDK_VERSION } from "./version.js";
export type { PermissionPreset, ThreadPermissionPolicy } from "./permissions.js";
export { SUPPORTED_PROVIDERS, isSupportedProvider } from "./permissions.js";
export { pickDefaultModel, type DefaultModelOptions } from "./providers.js";

export { APPROVAL_DECISIONS, isApprovalShaped } from "./approvals.js";
export type { ApprovalDecision, ApprovalRequest } from "./approvals.js";

export { checkAttachmentRoot, filterAttachmentRoots, MAX_ATTACHMENT_ROOTS } from "./hostConfig.js";
export type {
  AttachmentRootCheck,
  AttachmentRootFilterResult,
  HostConfigCapability,
  InstructionsCapability,
  PermissionCapability,
  SettingSourcesCapability,
  ThreadInstructions,
} from "./hostConfig.js";

export {
  resolveRuntimeSocketPath,
  isNamedPipePath,
  endpointComparisonKey,
} from "./socketPath.js";

export {
  resolveBundledRuntime,
  bundledRuntimePackageName,
  type BundledRuntime,
  type ResolveBundledRuntimeOptions,
} from "./bundledRuntime.js";
export {
  probeRuntimeSignature,
  type RuntimeSignature,
  type ProbeRuntimeSignatureOptions,
} from "./runtimeSignature.js";
export type { ResolvedBinarySource } from "./binary.js";

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
  AgentChatCodexCollaborationMode,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatHostConfigLevel,
  AgentChatInstructions,
  AgentChatSessionStatus,
  AgentChatSessionSummary,
  AgentChatSettingSources,
  CapabilitiesChangedEvent,
  DoctorReport,
  KnownAgentChatEvent,
  McpCapabilityReport,
  McpServerConfig,
  ModelCatalogEntry,
  PendingInputKind,
  PendingInputOption,
  PendingInputQuestion,
  PendingInputRequest,
  PendingInputSource,
  ProviderStatus,
  ProviderStatusProbeRecord,
  ProviderStatusRpcResult,
  RuntimeCompatibility,
  SyntheticRuntimeLostStatusEvent,
  ThreadCapabilities,
  ThreadHistoryPage,
  ThreadSummary,
  Unsubscribe,
} from "./types.js";
