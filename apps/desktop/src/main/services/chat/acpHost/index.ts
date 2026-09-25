/**
 * The shared ACP host.
 *
 * One host module speaks the Agent Client Protocol. Four thin dialects describe
 * what each provider does differently. Nothing outside this folder branches on
 * a provider id.
 *
 * ## What W4 calls, and in what order
 *
 * 1. `acpDialectFor(providerId)` — get the descriptor.
 * 2. `dialect.buildSpawnPlan({ binaryPath, cwd, baseEnv, ... })` — build the
 *    spawn plan. Pure. No process starts here.
 * 3. `openAcpSession({ dialect, cwd, spawnPlan, sessionToken, existingSessionId,
 *    adeHasTranscript, requestedModelId, mcpServers, callbacks, logger })` —
 *    acquires a pooled process, runs `initialize`, attaches handlers, and
 *    enters the session with `session/new`, `session/resume`, or
 *    `session/load`. It sends the post-session-new notifications a dialect
 *    asks for.
 * 4. Persist `session.sessionId`. It is how the chat resumes.
 * 5. `session.prompt({ turnId, blocks, isInterrupted })` per turn. Publish
 *    `outcome.events` after the stream, spread `outcome.done` into the turn's
 *    `done` event, and read `outcome.interrupted` rather than
 *    `outcome.stopReason` when deciding the turn status. `isInterrupted` is
 *    the caller's stop flag; it is read once, when the prompt result arrives,
 *    and must be a pure read.
 * 6. `session.cancel(reason)` to stop a turn. It answers every open permission
 *    request before it sends the cancel, and sends none once the agent has
 *    answered the prompt. `session.turnAnswered` is true in that window (from
 *    the prompt result until `prompt()` exits), so the caller's Stop can
 *    leave a finished turn alone as well.
 * 7. `session.close(reason)` when the chat ends. It uses `session/close` where
 *    the dialect has it, and it ends the private process where it does not.
 *
 * The host never writes a provider's config directory. Spawn plans carry argv
 * and environment only; nothing under `$COPILOT_HOME`, `$QWEN_HOME`,
 * `$KIMI_CODE_HOME`, `$GROK_HOME`, or `~/.grok` is modified by ADE.
 *
 * The permission callbacks are not optional. `onPermissionRequested` receives a
 * pending object; the host waits until something calls `select` or `cancel` on
 * it. Nothing else answers the agent.
 */

export * from "./acpProtocolTypes";
export * from "./acpHostTypes";
export {
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_HANDSHAKE_TIMEOUT_MS,
  ACP_TERMINATE_GRACE_MS,
  AcpConnectionClosedError,
  AcpRequestTimeoutError,
  AcpRpcError,
  createAcpConnection,
  initializeAcpConnection,
  readAcpStderrTailFromError,
  type AcpConnection,
  type AcpConnectionExit,
  type AcpStderrCarryingError,
} from "./acpConnection";
export {
  ACP_IDLE_TTL_MS,
  acpSessionPool,
  buildAcpPoolKey,
  createAcpSessionPool,
  hashPoolEnv,
  type AcpPooledConnection,
  type AcpSessionPool,
} from "./acpSessionPool";
export {
  buildUnifiedDiff,
  createAcpEventTranslator,
  usageSampleToEvents,
  type AcpEventTranslator,
  type AcpToolRowKind,
} from "./acpEventTranslator";
export type { AcpDoneTelemetry } from "./acpTurnTelemetry";
export {
  createAcpPermissionBridge,
  normalizePermissionOption,
  pendingPermissionToInputRequest,
  type AcpNormalizedPermissionOption,
  type AcpPendingPermission,
  type AcpPermissionBridge,
} from "./acpPermissionBridge";
export {
  acpSupervisionModeFor,
  acpUnsupervisedNoticeDetail,
  acpUnsupervisedNoticeMessage,
  acpUnverifiedNoticeMessage,
  createAcpSupervisionGuard,
  type AcpSupervisionGuard,
  type AcpSupervisionMode,
} from "./acpSupervisionGuard";
export {
  newAcpTurnId,
  openAcpSession,
  resolveAcpSessionEntry,
  textPromptBlock,
  type AcpPromptArgs,
  type AcpSession,
  type AcpSessionCallbacks,
  type AcpSessionEntryPlan,
  type AcpTurnOutcome,
} from "./acpSession";
export {
  buildAcpPromptBlocks,
  type AcpResolvedAttachment,
  type BuildAcpPromptBlocksArgs,
} from "./acpPromptBlocks";
export {
  acpHasTranscript,
  acpInvocationKey,
  createAcpRuntime,
  resolveAcpConfigValue,
  setAcpReasoningEffort,
  type AcpConfigValueResolution,
  type AcpReasoningEffortUpdateResult,
  type AcpRuntimeCoordinatorCallbacks,
  type AcpRuntimeOwner,
  type AcpRuntimeState,
  type CreateAcpRuntimeArgs,
} from "./acpRuntimeCoordinator";
export * from "./acpDialects";
