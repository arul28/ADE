/**
 * ACP runtime/session coordinator.
 *
 * The chat service owns ADE policy (which model, permission mode, and lane),
 * while this module owns the protocol lifecycle: reuse-or-rebuild, pooled
 * session opening, callback wiring, session config, and the runtime state that
 * surrounds an open ACP session. Keeping that boundary here prevents a new
 * provider quirk from growing the already-large provider-independent chat
 * service.
 */

import type {
  AgentChatAcpPermissionMode,
  AgentChatEvent,
  AgentChatSession,
  AcpChatProvider,
} from "../../../../shared/types";
import type { Logger } from "../../logging/logger";
import type { ChatRuntimeBudget } from "../chatRuntimeBudget";
import {
  openAcpSession,
  type AcpSession,
  type AcpSessionCallbacks,
  type OpenAcpSessionArgs,
} from "./acpSession";
import type { AcpPendingPermission } from "./acpPermissionBridge";
import type { AcpSessionConfigOption } from "./acpProtocolTypes";
import type { AcpDialect, AcpSlashCommand, AcpSpawnPlan } from "./acpHostTypes";

export type AcpRuntimeState<TSteer = unknown> = {
  kind: "acp";
  provider: AcpChatProvider;
  dialect: AcpDialect;
  session: AcpSession;
  /** Permission posture latched into this provider runtime. */
  permissionMode: AgentChatAcpPermissionMode;
  /** Identity of the spawn this session was opened on. A change forces a restart. */
  invocationKey: string;
  activeTurnId: string | null;
  busy: boolean;
  /** True when ADE asked for the stop. Never read from the agent's stopReason. */
  interrupted: boolean;
  /** Set when the agent process died underneath a live turn. */
  processFailed: boolean;
  pendingSteers: TSteer[];
  /** Slash commands the agent last advertised, already dialect-filtered. */
  slashCommands: AcpSlashCommand[];
  /** Config options the agent last reported, folded into the session snapshot. */
  configOptions: AcpSessionConfigOption[];
  currentModeId: string | null;
  /** Permission request ids ADE raised as cards for the running turn. */
  openPermissionIds: Set<string>;
};

export type AcpRuntimeOwner = {
  session: AgentChatSession;
  laneWorktreePath: string;
  eventSequence: number;
  transcriptBytesWritten: number;
};

export type AcpRuntimeCoordinatorCallbacks<TSteer> = {
  onEvents: (runtime: AcpRuntimeState<TSteer> | null, events: AgentChatEvent[]) => void;
  onPermissionRequested: (runtime: AcpRuntimeState<TSteer> | null, pending: AcpPendingPermission) => void;
  onPermissionSettled: (runtime: AcpRuntimeState<TSteer> | null, requestId: string) => void;
  onSlashCommands: (runtime: AcpRuntimeState<TSteer> | null, commands: AcpSlashCommand[]) => void;
  onConfigOptions: (
    runtime: AcpRuntimeState<TSteer> | null,
    snapshot: { options: AcpSessionConfigOption[]; currentModeId: string | null },
  ) => void;
  onSessionInfo: (
    runtime: AcpRuntimeState<TSteer> | null,
    info: { title: string | null; updatedAt: string | null },
  ) => void;
  onProcessExit: (
    runtime: AcpRuntimeState<TSteer> | null,
    detail: { code: number | null; signal: string | null; stderrTail: string },
  ) => void;
  /** Assign the runtime to the owning chat before session config is applied. */
  onRuntimeCreated: (runtime: AcpRuntimeState<TSteer>) => void;
  /** Record an open failure before it is returned to the chat service. */
  onOpenFailed: (error: unknown) => void;
  /** Persist and publish the provider-ready state after the session is ready. */
  onReady: (runtime: AcpRuntimeState<TSteer>) => void | Promise<void>;
};

export type CreateAcpRuntimeArgs<TSteer> = {
  owner: AcpRuntimeOwner;
  provider: AcpChatProvider;
  dialect: AcpDialect;
  spawnPlan: AcpSpawnPlan;
  invocationKey: string;
  permissionMode: AgentChatAcpPermissionMode;
  modelToken: string | null;
  existingSessionId: string | null;
  supervisionPreflight: { ok: boolean; detail?: string } | null;
  supervisionAlreadyNotified: boolean;
  mcpServers?: OpenAcpSessionArgs["mcpServers"];
  logger: Logger;
  runtimeBudget: Pick<ChatRuntimeBudget, "enforce">;
  existingRuntime: AcpRuntimeState<TSteer> | null;
  runtimeInvalidated: boolean;
  hasExistingRuntime: boolean;
  /** Close/release a non-reusable runtime owned by the chat service. */
  teardownExistingRuntime: () => void;
  /** Provider-specific value for its declared mode config option. */
  nativeModeValue: string;
  setResumeCommand: (command: string) => void;
  spawnOverride?: OpenAcpSessionArgs["spawnOverride"];
  pool?: OpenAcpSessionArgs["pool"];
  binarySource: string;
  callbacks: AcpRuntimeCoordinatorCallbacks<TSteer>;
};

/** Identity used to decide whether a process-global model/effort changed. */
export function acpInvocationKey(plan: Pick<AcpSpawnPlan, "command" | "args">): string {
  return JSON.stringify([plan.command, plan.args]);
}

/** True when ADE already has a transcript and must suppress `session/load` replay. */
export function acpHasTranscript(owner: Pick<AcpRuntimeOwner, "eventSequence" | "transcriptBytesWritten">): boolean {
  return owner.eventSequence > 0 || owner.transcriptBytesWritten > 0;
}

export async function createAcpRuntime<TSteer>(
  args: CreateAcpRuntimeArgs<TSteer>,
): Promise<AcpRuntimeState<TSteer>> {
  const existing = args.existingRuntime;
  if (
    existing
    && existing.provider === args.provider
    && existing.invocationKey === args.invocationKey
    && existing.permissionMode === args.permissionMode
    && !args.runtimeInvalidated
    && !existing.processFailed
    && existing.session.connection.isAlive()
  ) {
    return existing;
  }
  if (args.hasExistingRuntime) args.teardownExistingRuntime();
  args.runtimeBudget.enforce(args.owner.session.id);

  let runtime: AcpRuntimeState<TSteer> | null = null;
  let session: AcpSession;
  try {
    session = await openAcpSession({
      dialect: args.dialect,
      cwd: args.owner.laneWorktreePath,
      spawnPlan: args.spawnPlan,
      sessionToken: args.owner.session.id,
      existingSessionId: args.existingSessionId,
      adeHasTranscript: acpHasTranscript(args.owner),
      permissionMode: args.permissionMode,
      supervisionPreflight: args.supervisionPreflight,
      supervisionAlreadyNotified: args.supervisionAlreadyNotified,
      mcpServers: args.mcpServers ?? [],
      logger: args.logger,
      ...(args.spawnOverride ? { spawnOverride: args.spawnOverride } : {}),
      ...(args.pool ? { pool: args.pool } : {}),
      callbacks: {
        onEvents: (events) => args.callbacks.onEvents(runtime, events),
        onPermissionRequested: (pending) => args.callbacks.onPermissionRequested(runtime, pending),
        onPermissionSettled: (requestId) => args.callbacks.onPermissionSettled(runtime, requestId),
        onSlashCommands: (commands) => args.callbacks.onSlashCommands(runtime, commands),
        onConfigOptions: (snapshot) => args.callbacks.onConfigOptions(runtime, snapshot),
        onSessionInfo: (info) => args.callbacks.onSessionInfo(runtime, info),
        onProcessExit: (detail) => args.callbacks.onProcessExit(runtime, detail),
      } satisfies AcpSessionCallbacks,
    });
  } catch (error) {
    args.callbacks.onOpenFailed(error);
    throw error;
  }

  runtime = {
    kind: "acp",
    provider: args.provider,
    dialect: args.dialect,
    session,
    permissionMode: args.permissionMode,
    invocationKey: args.invocationKey,
    activeTurnId: null,
    busy: false,
    interrupted: false,
    processFailed: false,
    pendingSteers: [],
    slashCommands: [],
    configOptions: session.initialConfigOptions,
    currentModeId: session.initialModeId,
    openPermissionIds: new Set<string>(),
  };
  args.callbacks.onRuntimeCreated(runtime);

  if (args.dialect.sessionConfig.declared) {
    await session.setConfigOption({ configId: "mode", value: args.nativeModeValue }).catch((error) => {
      args.logger.warn("agent_chat.acp_set_mode_failed", {
        sessionId: args.owner.session.id,
        provider: args.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (args.modelToken) {
      await session.setConfigOption({ configId: "model", value: args.modelToken }).catch((error) => {
        args.logger.warn("agent_chat.acp_set_model_failed", {
          sessionId: args.owner.session.id,
          provider: args.provider,
          model: args.modelToken,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  if (session.initialConfigOptions.length || session.initialModeId) {
    args.callbacks.onConfigOptions(runtime, {
      options: session.initialConfigOptions,
      currentModeId: session.initialModeId,
    });
  }

  await args.callbacks.onReady(runtime);
  args.setResumeCommand(`chat:${args.provider}:${args.owner.session.id}`);
  args.logger.info("agent_chat.acp_runtime_ready", {
    sessionId: args.owner.session.id,
    provider: args.provider,
    acpSessionId: session.sessionId,
    entryMode: session.entryPlan.mode,
    entryReason: session.entryPlan.reason,
    binarySource: args.binarySource,
  });
  return runtime;
}
