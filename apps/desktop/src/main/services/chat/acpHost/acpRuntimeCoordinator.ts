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
import { getErrorMessage } from "../../shared/utils";
import type { ChatRuntimeBudget } from "../chatRuntimeBudget";
import { AcpRpcError } from "./acpConnection";
import {
  openAcpSession,
  type AcpSession,
  type AcpSessionCallbacks,
  type OpenAcpSessionArgs,
} from "./acpSession";
import type { AcpPendingPermission } from "./acpPermissionBridge";
import type { AcpSessionConfigOption } from "./acpProtocolTypes";
import { behaviorOf, type AcpDialect, type AcpSlashCommand, type AcpSpawnPlan } from "./acpHostTypes";

export type AcpRuntimeState<TSteer = unknown> = {
  kind: "acp";
  provider: AcpChatProvider;
  dialect: AcpDialect;
  session: AcpSession;
  /** Permission posture latched into this provider runtime. */
  permissionMode: AgentChatAcpPermissionMode;
  /** Identity of the spawn this session was opened on. A change forces a restart. */
  invocationKey: string;
  /**
   * The same identity without the dialect's effort spawn flag, or `null` when
   * the dialect has none. See `AcpReasoningEffortOption.spawnFlag`.
   */
  invocationKeyWithoutEffortFlag: string | null;
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
  /** Remove a runtime whose required mode setup failed before readiness. */
  onRuntimeSetupFailed?: (runtime: AcpRuntimeState<TSteer>, error: unknown) => void;
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
  /** Provider-native reasoning value, when the dialect advertises one. */
  reasoningEffort: string | null;
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

/** The invocation key without `flag` and its value, or `null` when there is no flag. */
function acpInvocationKeyWithout(plan: Pick<AcpSpawnPlan, "command" | "args">, flag: string | undefined): string | null {
  if (!flag) return null;
  const args: string[] = [];
  for (let index = 0; index < plan.args.length; index += 1) {
    if (plan.args[index] === flag) {
      index += 1;
      continue;
    }
    args.push(plan.args[index]!);
  }
  return acpInvocationKey({ command: plan.command, args });
}

/** True when the session lists choices for the dialect's effort option. */
function acpSessionAdvertisesEffort<TSteer>(runtime: AcpRuntimeState<TSteer>): boolean {
  const configId = runtime.dialect.reasoningEffortOption?.configId;
  return Boolean(configId)
    && runtime.configOptions.some((option) => option.id === configId && (option.options?.length ?? 0) > 0);
}

/**
 * True when an open runtime can serve `plan` although the invocation keys
 * differ. That is so only when the effort spawn flag is the difference and the
 * session advertises the effort option: the config option already moved the
 * session's effort, so a restart would buy nothing. A build that does not
 * advertise the option (Grok before 1.0.40) takes the effort only from the
 * flag, so it restarts.
 */
function acpEffortFlagChangeOnly<TSteer>(
  existing: AcpRuntimeState<TSteer>,
  plan: Pick<AcpSpawnPlan, "command" | "args">,
): boolean {
  const withoutFlag = acpInvocationKeyWithout(plan, existing.dialect.reasoningEffortOption?.spawnFlag);
  return withoutFlag !== null
    && withoutFlag === existing.invocationKeyWithoutEffortFlag
    && acpSessionAdvertisesEffort(existing);
}

/** True when ADE already has a transcript and must suppress `session/load` replay. */
export function acpHasTranscript(owner: Pick<AcpRuntimeOwner, "eventSequence" | "transcriptBytesWritten">): boolean {
  return owner.eventSequence > 0 || owner.transcriptBytesWritten > 0;
}

/** The chat service's word for "no effort picked". Qwen also uses it on the wire. */
const ADE_DEFAULT_REASONING_EFFORT = "default";

export type AcpConfigValueResolution =
  /** The agent offers this value. `current` is true when the session already has it. */
  | { kind: "advertised"; value: string; current: boolean }
  /** The agent listed no choices for the option. It judges the value itself. */
  | { kind: "unadvertised"; value: string }
  /** The agent listed choices, and the requested value is not one of them. */
  | { kind: "not_offered"; offered: string[] };

/**
 * Match a requested value against the choices the agent advertised for one
 * session config option.
 *
 * An exact choice wins. Otherwise `plain` (the dialect's `modelIdFromAgent`)
 * maps each choice to its plain id: Qwen offers `gpt-5.5(openai)` for the
 * model ADE calls `gpt-5.5`. When several choices share that plain id, the
 * session's current value wins, so a model pick never moves Qwen to another
 * auth type. A value the agent does not offer is never sent: Grok's `-m`
 * silently swapped an unknown id for its default, so ADE checks first.
 */
export function resolveAcpConfigValue(
  options: readonly AcpSessionConfigOption[],
  configId: string,
  requested: string,
  plain?: (raw: string) => string,
): AcpConfigValueResolution {
  const option = options.find((entry) => entry.id === configId);
  const offered = (option?.options ?? []).map((entry) => entry.id);
  if (!offered.length) return { kind: "unadvertised", value: requested };
  const current = typeof option?.value === "string" ? option.value : null;
  const pick = (value: string): AcpConfigValueResolution => ({ kind: "advertised", value, current: value === current });
  if (offered.includes(requested)) return pick(requested);
  if (plain) {
    const target = plain(requested);
    const matches = offered.filter((id) => plain(id) === target);
    if (matches.length) return pick(current && matches.includes(current) ? current : matches[0]!);
  }
  return { kind: "not_offered", offered };
}

/**
 * Keep the option set an agent reported back from a config change. An agent
 * that accepted the change and reported no options (Kimi, Copilot's
 * `session/set_model`) runs the value ADE sent, so the local option takes it.
 * Otherwise a later call would skip a value as current when it is not.
 */
function recordConfigChange<TSteer>(
  runtime: AcpRuntimeState<TSteer>,
  configId: string,
  value: string,
  reported: AcpSessionConfigOption[] | undefined,
): void {
  if (Array.isArray(reported) && reported.length) {
    runtime.configOptions = reported;
    return;
  }
  runtime.configOptions = runtime.configOptions.map((option) => (option.id === configId ? { ...option, value } : option));
}

export type AcpReasoningEffortUpdateResult = "applied" | "unchanged" | "rejected" | "transient_failure";

/**
 * The value a clear sends: the agent's own reset value (Qwen's `default`), or
 * else the effort that the session reported when it opened. `null` when the
 * session reported none, so there is nothing to put back.
 */
function acpClearedEffortValue<TSteer>(
  runtime: AcpRuntimeState<TSteer>,
  option: NonNullable<AcpDialect["reasoningEffortOption"]>,
): string | null {
  if (option.resetValue !== undefined) return option.resetValue;
  const opened = runtime.session.initialConfigOptions.find((entry) => entry.id === option.configId)?.value;
  return typeof opened === "string" && opened.length ? opened : null;
}

/**
 * Apply ADE's reasoning effort to an already-open ACP session.
 *
 * `effort` is ADE's value; `null` and `default` both mean "no effort picked",
 * which clears the effort ADE set:
 * - Qwen sends its `resetValue` (`default`), also when the session does not
 *   list it.
 * - Grok and Kimi send the effort that the session reported when it opened,
 *   when the session still offers it.
 *
 * A picked value that the agent does not offer is logged and not sent. A
 * failed set is `transient_failure` only for a `failClosed` dialect (Qwen);
 * for the others it is logged and `rejected`, and the session keeps running.
 */
export async function setAcpReasoningEffort<TSteer>(
  runtime: AcpRuntimeState<TSteer>,
  effort: string | null,
  args: { sessionId: string; logger: Logger },
): Promise<AcpReasoningEffortUpdateResult> {
  const option = runtime.dialect.reasoningEffortOption;
  if (!option || !runtime.dialect.sessionConfig.declared) return "rejected";
  const picked = effort?.trim();
  const cleared = !picked || picked === ADE_DEFAULT_REASONING_EFFORT;
  const value = cleared ? acpClearedEffortValue(runtime, option) : option.toAgentValue(picked);
  if (value === null) return "unchanged";

  // The agent's own reset value goes out whether or not the session lists it.
  const sendAnyway = cleared && option.resetValue !== undefined;
  const resolution = resolveAcpConfigValue(runtime.configOptions, option.configId, value);
  let wireValue: string;
  if (resolution.kind === "advertised") {
    if (resolution.current) return "unchanged";
    wireValue = resolution.value;
  } else if (resolution.kind === "unadvertised") {
    if (!option.sendWhenUnadvertised && !sendAnyway) return "unchanged";
    wireValue = resolution.value;
  } else if (sendAnyway) {
    wireValue = value;
  } else {
    args.logger.warn("agent_chat.acp_reasoning_effort_not_offered", {
      sessionId: args.sessionId,
      provider: runtime.provider,
      reasoningEffort: value,
      offered: resolution.offered,
    });
    return "rejected";
  }

  try {
    recordConfigChange(
      runtime,
      option.configId,
      wireValue,
      await runtime.session.setConfigOption({ configId: option.configId, value: wireValue }),
    );
    return "applied";
  } catch (error) {
    // Qwen and Grok report an unsupported value as invalid params, which is
    // always a non-fatal rejection. Any other failure (transport, server, the
    // request deadline) is fatal only for a `failClosed` dialect: Qwen keeps
    // the effort on the session, so ADE must not claim a value Qwen never saw.
    // Grok and Kimi keep running on their own effort.
    const invalid = error instanceof AcpRpcError && (error.code === -32602 || error.isMethodNotFound);
    const result = invalid || !option.failClosed ? "rejected" : "transient_failure";
    args.logger.warn("agent_chat.acp_set_reasoning_effort_failed", {
      sessionId: args.sessionId,
      provider: runtime.provider,
      reasoningEffort: wireValue,
      result,
      error: getErrorMessage(error),
    });
    return result;
  }
}

/**
 * Put the chat's model on an open session.
 *
 * Copilot takes it through `session/set_model`; Grok, Qwen, and Kimi take it
 * through the `model` config option. A resumed session comes back on the model
 * it last ran, whatever the spawn flag says (Grok 1.0.40), so this runs after
 * every entry, not only after `session/new`. A model the agent does not offer
 * is logged and the session keeps its own model; the turn still runs, and the
 * served-model notice tells the user which model answered. A model the agent
 * accepted becomes the session's current model, so a turn whose provider
 * names no served model does not fall back to the model the entry reported.
 */
async function applyAcpModel<TSteer>(
  runtime: AcpRuntimeState<TSteer>,
  modelToken: string,
  args: { sessionId: string; logger: Logger },
): Promise<void> {
  const { dialect, session } = runtime;
  const modelBehavior = behaviorOf(dialect.modelSelection);
  const viaConfigOption = !modelBehavior
    && dialect.sessionConfig.declared
    && dialect.configOptionIds.includes("model");
  if (!modelBehavior && !viaConfigOption) return;

  const resolution = resolveAcpConfigValue(runtime.configOptions, "model", modelToken, dialect.modelIdFromAgent);
  if (resolution.kind === "not_offered") {
    args.logger.warn("agent_chat.acp_model_not_offered", {
      sessionId: args.sessionId,
      provider: runtime.provider,
      model: modelToken,
      offered: resolution.offered,
    });
    return;
  }
  if (resolution.kind === "advertised" && resolution.current) return;

  try {
    let reported: AcpSessionConfigOption[] | undefined;
    if (modelBehavior) {
      const call = modelBehavior({ sessionId: session.sessionId, modelId: resolution.value });
      await session.connection.request(call.method, call.params);
    } else {
      reported = await session.setConfigOption({ configId: "model", value: resolution.value });
    }
    recordConfigChange(runtime, "model", resolution.value, reported);
    const current = runtime.configOptions.find((option) => option.id === "model")?.value;
    session.noteCurrentModel(typeof current === "string" && current.length ? current : resolution.value);
  } catch (error) {
    args.logger.warn("agent_chat.acp_set_model_failed", {
      sessionId: args.sessionId,
      provider: runtime.provider,
      model: resolution.value,
      error: getErrorMessage(error),
    });
  }
}

export async function createAcpRuntime<TSteer>(
  args: CreateAcpRuntimeArgs<TSteer>,
): Promise<AcpRuntimeState<TSteer>> {
  const existing = args.existingRuntime;
  if (
    existing
    && existing.provider === args.provider
    && (existing.invocationKey === args.invocationKey || acpEffortFlagChangeOnly(existing, args.spawnPlan))
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
      requestedModelId: args.modelToken,
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
    invocationKeyWithoutEffortFlag: acpInvocationKeyWithout(args.spawnPlan, args.dialect.reasoningEffortOption?.spawnFlag),
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
  const createdRuntime = runtime as AcpRuntimeState<TSteer>;

  // Grok declares session config for model and effort only. Its permission
  // posture rides spawn flags, so it gets no `mode` call.
  if (args.dialect.sessionConfig.declared && args.dialect.configOptionIds.includes("mode")) {
    const nativeModeValue = args.dialect.nativeModeValue?.(args.nativeModeValue) ?? args.nativeModeValue;
    try {
      recordConfigChange(
        runtime,
        "mode",
        nativeModeValue,
        await session.setConfigOption({ configId: "mode", value: nativeModeValue }),
      );
    } catch (error) {
      args.logger.warn("agent_chat.acp_set_mode_failed", {
        sessionId: args.owner.session.id,
        provider: args.provider,
        error: getErrorMessage(error),
      });
      if (args.dialect.modeSetupRequired) {
        // A failed mode setup must never fall through to onReady: the agent may
        // now be running with a broader posture than the user selected.
        try {
          await session.close("mode setup failed");
        } finally {
          args.callbacks.onRuntimeSetupFailed?.(createdRuntime, error);
          args.callbacks.onOpenFailed(error);
        }
        throw error;
      }
    }
  }
  if (args.modelToken) {
    await applyAcpModel(runtime, args.modelToken, { sessionId: args.owner.session.id, logger: args.logger });
  }

  if (args.dialect.reasoningEffortOption && args.dialect.sessionConfig.declared) {
    // Qwen, Grok, and Kimi store this value on the ACP session, so a resumed
    // session brings back the value it last ran with. See
    // `setAcpReasoningEffort` for what a clear sends. Only Qwen fails closed:
    // Grok and Kimi log a failed set and run on their own effort.
    const result = await setAcpReasoningEffort(runtime, args.reasoningEffort, {
      sessionId: args.owner.session.id,
      logger: args.logger,
    });
    if (result === "transient_failure") {
      // Do not mark a fail-closed runtime ready after a transport or server
      // failure: the first turn would run with stale provider state. Teardown
      // invalidates the persisted ACP pointer so the next send opens a clean
      // session and retries the selected effort.
      args.teardownExistingRuntime();
      throw new Error(
        `${args.dialect.displayName} ACP could not apply reasoning effort '${args.reasoningEffort?.trim() || ADE_DEFAULT_REASONING_EFFORT}'.`,
      );
    }
  }

  // The options as they stand after the mode, model, and effort calls above,
  // not as `session/new` reported them: the entry call's snapshot would put
  // the old model back in the chat's config snapshot.
  if (runtime.configOptions.length || runtime.currentModeId) {
    args.callbacks.onConfigOptions(runtime, {
      options: runtime.configOptions,
      currentModeId: runtime.currentModeId,
    });
  }

  await args.callbacks.onReady(runtime);
  args.setResumeCommand(`chat:${args.provider}:${args.owner.session.id}`);
  args.logger.info("agent_chat.acp_runtime_ready", {
    sessionId: args.owner.session.id,
    provider: args.provider,
    acpSessionId: session.sessionId,
    agentVersion: session.connection.initializeResult?.agentInfo?.version ?? null,
    advertisedSessionCapabilities: session.connection.initializeResult?.agentCapabilities?.sessionCapabilities ?? null,
    entryMode: session.entryPlan.mode,
    entryReason: session.entryPlan.reason,
    binarySource: args.binarySource,
  });
  return runtime;
}
