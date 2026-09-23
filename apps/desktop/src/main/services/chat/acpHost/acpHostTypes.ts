/**
 * Dialect descriptors for the shared ACP host.
 *
 * One host speaks the protocol. Each provider supplies a descriptor that names
 * its spawn plan, its quirks, and its capabilities. The host never branches on
 * a provider id. It reads the descriptor.
 *
 * ## The requiresBehavior invariant
 *
 * A capability that a dialect declares must carry the function that performs
 * it. The type system enforces this in two ways.
 *
 * 1. `AcpCapability<T>` is a union. The present branch demands `behavior`. The
 *    absent branch forbids it. You cannot write `{ declared: true }` alone.
 * 2. The style fields that pair with a capability (`closeStyle`, `loadPolicy`)
 *    are discriminants of contract unions. A dialect that says
 *    `closeStyle: "close_request"` must supply `closeSession.behavior`. A
 *    dialect that says `closeStyle: "kill_process"` must not. Every dialect
 *    reads usage, so `usage` always carries its reader.
 *
 * A wrong pairing is a compile error, not a runtime surprise.
 */

import type {
  AcpAvailableCommand,
  AcpContentBlock,
  AcpMcpServer,
  AcpPromptResponse,
  AcpPromptUsage,
  AcpSessionConfigOption,
  AcpSessionId,
  AcpUsageUpdate,
} from "./acpProtocolTypes";
import type { AcpProviderId } from "../../../../shared/acpProviderMetadata";
import type { AgentChatPlanUsage, AgentChatUsageAccount } from "../../../../shared/types";
export { ACP_PROVIDER_IDS, type AcpProviderId } from "../../../../shared/acpProviderMetadata";

/** Settings shows a preview label. Pickers show every provider the same way. */
export type AcpProviderTier = "first_class" | "preview";

// ── Capability declarations ──────────────────────────────────────────────────

export type AcpAbsentCapability = { readonly declared: false };
export type AcpPresentCapability<TBehavior> = {
  readonly declared: true;
  readonly behavior: TBehavior;
};

/**
 * A capability is either absent, or present with the behavior that performs it.
 * There is no third shape.
 */
export type AcpCapability<TBehavior> = AcpAbsentCapability | AcpPresentCapability<TBehavior>;

/** The single absent value. It is assignable to any `AcpCapability<T>`. */
export const capabilityAbsent: AcpAbsentCapability = { declared: false };

/** Declare a capability together with the behavior that performs it. */
export function capability<TBehavior>(behavior: TBehavior): AcpPresentCapability<TBehavior> {
  return { declared: true, behavior };
}

/** Read the behavior of a capability, or `null` when the dialect omits it. */
export function behaviorOf<TBehavior>(entry: AcpCapability<TBehavior>): TBehavior | null {
  return entry.declared ? entry.behavior : null;
}

// ── Style enumerations ───────────────────────────────────────────────────────

/**
 * How to stop a running turn.
 *
 * Grok and Copilot's ACP server answer a `session/cancel` REQUEST with -32601
 * on the compatibility baseline. They accept the same call as a notification.
 * Qwen and Kimi accept the request form.
 */
export type AcpCancelStyle = "request" | "notification";

/**
 * How to end a session.
 *
 * `kill_process` means the agent has no `session/close`. Qwen 0.24.0 is in
 * that group: it does not advertise close and answers -32601. Each such chat
 * owns its own process and the host ends the chat by ending the process.
 * Kimi's 0.39.1 compatibility baseline and 2.0.0 reference both advertise
 * close and implement it, so it is `close_request`.
 */
export type AcpCloseStyle = "close_request" | "kill_process";

/**
 * How to rejoin an existing agent session.
 *
 * `resume_preferred` — try `session/resume` first, then `session/load`.
 * `load_only`        — only `session/load` exists.
 * `never`            — start a new agent session every time.
 */
export type AcpLoadPolicy = "resume_preferred" | "load_only" | "never";

// ── Behavior signatures ──────────────────────────────────────────────────────

export type AcpSpawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
};

export type AcpSpawnContext = {
  /** Absolute path of the agent binary or shim that the detector resolved. */
  binaryPath: string;
  /** Lane worktree. Becomes both the process cwd and the session cwd. */
  cwd: string;
  /** Environment to build on. Usually `process.env`. */
  baseEnv: NodeJS.ProcessEnv;
  /** Provider-native model token, when the user picked one. */
  modelId?: string | null;
  /** Provider-native reasoning effort token, when the provider takes one. */
  reasoningEffort?: string | null;
  /** ADE abstract permission mode, already mapped by the caller. */
  permissionMode?: string | null;
  /** Config home directory to export, when the provider honors one. */
  configHome?: string | null;
  /**
   * An ADE-OWNED settings file to point the provider at, so it discovers ADE's
   * bundled agent skills natively.
   *
   * Never the provider's own config home — ADE does not write those (see
   * `docs/features/agents/README.md`). The caller writes the file and hands its
   * path here; a dialect whose agent has no such hook ignores it.
   */
  adeSkillDefaultsPath?: string | null;
};

export type AcpResumeBehavior = (args: {
  sessionId: AcpSessionId;
  cwd: string;
  mcpServers: AcpMcpServer[];
}) => { method: string; params: Record<string, unknown> };

export type AcpLoadBehavior = (args: {
  sessionId: AcpSessionId;
  cwd: string;
  mcpServers: AcpMcpServer[];
}) => { method: string; params: Record<string, unknown> };

export type AcpCloseBehavior = (args: {
  sessionId: AcpSessionId;
}) => { method: string; params: Record<string, unknown> };

export type AcpSessionConfigBehavior = (args: {
  sessionId: AcpSessionId;
  configId: string;
  value: string | boolean;
}) => { method: string; params: Record<string, unknown> };

/** Provider-native model selection when it is not a config option. */
export type AcpModelSelectionBehavior = (args: {
  sessionId: AcpSessionId;
  modelId: string;
}) => { method: string; params: Record<string, unknown> };

/**
 * How ADE's reasoning effort reaches an open session, for an agent that takes
 * it as a session config option.
 */
export type AcpReasoningEffortOption = {
  /** The config option id that carries the effort. */
  readonly configId: string;
  /**
   * Turn an effort the user picked into the agent's value. `null` out means
   * the agent has no such level, and ADE sends nothing.
   */
  readonly toAgentValue: (effort: string) => string | null;
  /**
   * The agent's own value that clears a session-scoped effort (Qwen's
   * `default`). ADE sends it for every clear, also when the session does not
   * list it. When this is absent, a clear puts back the value that the
   * session reported when it opened, if the session still offers it.
   */
  readonly resetValue?: string;
  /**
   * Send the value even when the session advertises no choices for the
   * option. Off by default: Kimi hides `thinking` for a model without
   * thinking control, and a value sent anyway can fail the session start.
   */
  readonly sendWhenUnadvertised?: boolean;
  /**
   * True when a failed set (not an invalid-params rejection) must stop the
   * session start and invalidate the runtime (Qwen). Otherwise ADE logs the
   * failure, and the session keeps its own value.
   */
  readonly failClosed?: boolean;
  /**
   * The spawn flag that carries the same effort for a build whose session
   * does not advertise the option (Grok before 1.0.40). A change to this
   * flag alone does not restart a session that advertises the option: the
   * config option already moved that session.
   */
  readonly spawnFlag?: string;
};

/**
 * Normalized usage sample. `null` means the payload carried nothing usable, and
 * the host emits no usage event for it.
 *
 * `inputTokens` is the UNCACHED input. Cache reads and cache writes are their
 * own fields and are never inside `inputTokens`, so `input + cacheRead +
 * cacheWrite` is the whole input side. Copilot, Grok's turn totals, and Qwen
 * report an inclusive input count; their readers subtract the cache first.
 */
export type AcpUsageSample = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Context tokens already occupied. */
  contextUsedTokens?: number;
  /** Context window size. */
  contextWindowTokens?: number;
  costUsd?: number;
  /** Model requests the payload covers, when the provider counts them. */
  requestCount?: number;
  /** Model that produced these tokens, when the payload names it. */
  servedModel?: string;
};

// ── Telemetry signals ────────────────────────────────────────────────────────

/** Token split for one subagent. `inputTokens` is uncached, as above. */
export type AcpSubagentUsage = Omit<AcpUsageSample, "contextUsedTokens" | "contextWindowTokens" | "servedModel"> & {
  toolUses?: number;
  durationMs?: number;
};

/**
 * A provider fact the host folds into chat events and the turn's `done`
 * telemetry. Dialects turn their extension notifications into these, so the
 * host never parses a provider's private payload itself.
 */
export type AcpTelemetrySignal =
  /** One model request finished. `usage.contextUsedTokens` is its input side. */
  | { kind: "request_usage"; usage: AcpUsageSample }
  /** The provider's own totals for the whole turn. */
  | { kind: "turn_usage"; usage: AcpUsageSample }
  /**
   * The model the agent was asked to run, and the context window of each model
   * it knows. `currentModelId` is the requested model, not a served one.
   */
  | { kind: "model_catalog"; currentModelId: string | null; contextWindows: Record<string, number> }
  /** The model the agent reports it is running now. */
  | { kind: "current_model"; modelId: string }
  | {
      kind: "subagent_started";
      agentId: string;
      agentType?: string;
      model?: string;
      description?: string;
    }
  | {
      kind: "subagent_finished";
      agentId: string;
      status: "completed" | "failed" | "stopped";
      summary?: string;
      model?: string;
      usage: AcpSubagentUsage;
    }
  | {
      kind: "compaction";
      state: "started" | "completed" | "failed";
      /** Provider id of the compaction, when it gives one. */
      compactionId?: string;
      preTokens?: number;
      postTokens?: number;
      failReason?: "interrupted";
    };

/**
 * Read one extension notification. `sessionId` is the protocol session the
 * payload names, or `null` when it is process-wide (Grok's model catalog). The
 * host drops a payload that names another session on a pooled process.
 */
export type AcpExtensionNotificationReader = (params: unknown) => {
  sessionId: string | null;
  signals: AcpTelemetrySignal[];
};

/** What a provider's local usage store says about one finished turn. */
export type AcpLocalTurnUsage = {
  /** Main-agent totals for the turn, read back from the store. */
  usage?: AcpUsageSample;
  requestCount?: number;
  servedModel?: string;
  planUsage?: AgentChatPlanUsage[];
  /** Account facts the store rows carry, when they beat the config read. */
  account?: AgentChatUsageAccount;
  /**
   * Compactions the store recorded during the turn. Copilot runs its
   * compaction as a model request (`initiator = "compaction"`) and never sends
   * an ACP compaction update, so the ledger is the only provider signal.
   * `preTokens` is the context that was summarised. There is no post figure:
   * the request's output is the summary alone, not the context that follows.
   */
  compactions?: Array<{ preTokens?: number }>;
  subagents: Array<{
    agentId: string;
    /** Display name, when the store names the helper (Qwen `source`). */
    label?: string;
    parentToolCallId?: string;
    model?: string;
    usage: AcpSubagentUsage;
  }>;
};

/**
 * Per-session reader for a provider's own on-disk usage ledger (Copilot's
 * `session-store.db`, Qwen's `token-usage-*.jsonl`). Read-only, always.
 */
export type AcpLocalUsageReader = {
  /**
   * Called right before `session/prompt`. Marks where this turn's rows start.
   * It sits in front of the prompt, so it must never wait on a lock or a
   * database: a timestamp or one file-size stat, nothing more.
   */
  beginTurn(): void;
  /**
   * Called after the prompt result. Reads the rows this turn wrote. Never
   * throws, never blocks the event loop waiting on a lock, and resolves `null`
   * when the store is missing, locked, or empty.
   */
  finishTurn(): Promise<AcpLocalTurnUsage | null>;
};

export type AcpLocalUsageBehavior = (args: {
  /** The agent's protocol session id. Both ledgers key on it. */
  sessionId: AcpSessionId;
  /** The spawn plan's environment, so config homes resolve like the spawn. */
  env: NodeJS.ProcessEnv;
}) => AcpLocalUsageReader;

/**
 * Read who pays for this provider's turns from local, non-secret config. Never
 * a network call and never a token value; unknown fields stay out.
 */
export type AcpAccountReader = (args: { env: NodeJS.ProcessEnv }) => AgentChatUsageAccount;

/**
 * Read one usage payload. The host calls it with a `usage_update` as each one
 * arrives, and with the `session/prompt` result when the turn ends; a reader
 * returns `null` for the payload its agent does not use (Grok has no
 * `usage_update`).
 */
export type AcpUsageBehavior = (input: {
  /** A `session/update` `usage_update`. */
  usageUpdate?: AcpUsageUpdate;
  /** The `session/prompt` result. */
  promptResponse?: AcpPromptResponse;
  /** Convenience alias of `promptResponse.usage`. */
  promptUsage?: AcpPromptUsage | null;
}) => AcpUsageSample | null;

/**
 * Filter and rewrite the MCP servers ADE would inject.
 *
 * Return an empty array to inject nothing. The host NEVER offers the
 * Codex-signed computer-use server to an ACP provider, so a dialect only sees
 * servers that are already safe to consider.
 */
export type AcpMcpInjectionBehavior = (args: {
  servers: AcpMcpServer[];
  agentSupportsHttp: boolean;
  agentSupportsSse: boolean;
}) => AcpMcpServer[];

/** Turn an ADE image attachment into a prompt content block. */
export type AcpImagePromptBehavior = (args: {
  base64Data: string;
  mimeType: string;
  uri?: string | null;
}) => AcpContentBlock;

// ── Contract unions ──────────────────────────────────────────────────────────

/** `close_request` demands a close builder. `kill_process` forbids one. */
export type AcpCloseContract =
  | {
      readonly closeStyle: "close_request";
      readonly closeSession: AcpPresentCapability<AcpCloseBehavior>;
    }
  | { readonly closeStyle: "kill_process"; readonly closeSession: AcpAbsentCapability };

/** The load policy decides which of the two rejoin builders must exist. */
export type AcpLoadContract =
  | {
      readonly loadPolicy: "never";
      readonly resumeSession: AcpAbsentCapability;
      readonly loadSession: AcpAbsentCapability;
    }
  | {
      readonly loadPolicy: "load_only";
      readonly resumeSession: AcpAbsentCapability;
      readonly loadSession: AcpPresentCapability<AcpLoadBehavior>;
    }
  | {
      readonly loadPolicy: "resume_preferred";
      readonly resumeSession: AcpPresentCapability<AcpResumeBehavior>;
      readonly loadSession: AcpPresentCapability<AcpLoadBehavior>;
    };

// ── Session id persistence ───────────────────────────────────────────────────

export type AcpSessionIdPersistence = {
  /**
   * True when the launcher can choose the session id. Kimi cannot: the host
   * must read the id the agent reports and store it.
   */
  assignableAtLaunch: boolean;
  /**
   * Directory that holds the provider's own session files, relative to the
   * config home. W4 uses it for the disk-adopt capture that Kimi needs.
   * `null` means the provider reports its id on the wire and needs no capture.
   */
  sessionsDirName: string | null;
  /** Shape of the ids the provider mints. Diagnostics only. */
  idShape: "uuid" | "ulid" | "opaque";
};

// ── Outbound setup notifications ─────────────────────────────────────────────

export type AcpOutboundNotification = { method: string; params: Record<string, unknown> };

// ── Auth probe ───────────────────────────────────────────────────────────────

export type AcpAuthProbe = {
  /**
   * `authenticate` method id to send. `null` means "use the first method the
   * agent advertised in its `initialize` response".
   */
  methodId: string | null;
  /** Command to print when the probe fails. */
  loginCommand: string;
  /** Environment keys that also authenticate the provider. */
  apiKeyEnvVars: readonly string[];
};

// ── The descriptor ───────────────────────────────────────────────────────────

export type AcpDialectBase = {
  readonly providerId: AcpProviderId;
  readonly displayName: string;
  readonly tier: AcpProviderTier;

  /** Executable names to look for, in order of preference. */
  readonly binaryNames: readonly string[];

  /** Build the process spawn plan. Pure: no file system reads, no spawns. */
  readonly buildSpawnPlan: (context: AcpSpawnContext) => AcpSpawnPlan;

  /** Map ADE's abstract mode to the provider's native config value. */
  readonly nativeModeValue?: (mode: string) => string;

  /** Map ADE's requested mode to the posture the supervision guard should enforce. */
  readonly supervisionPermissionMode?: (mode: string | null | undefined) => string | null | undefined;

  /** Whether failure to apply the native mode must abort runtime setup. */
  readonly modeSetupRequired?: boolean;

  readonly cancelStyle: AcpCancelStyle;

  /**
   * Environment keys that must match before two chats share one process. Add a
   * key here only when a different value changes how the agent behaves. Adding
   * a per-chat key would defeat pooling completely.
   */
  readonly poolEnvKeys: readonly string[];

  /**
   * True when a session may not share a process with another session. The host
   * gives such a dialect a private pool key, so eviction never crosses chats.
   */
  readonly oneProcessPerSession: boolean;

  /**
   * Never advertise `fs` unless this is true. Grok proxies binary reads through
   * the text file system and corrupts assets, so it stays false there. It is
   * false for every dialect today; the flag exists so a future dialect can opt
   * in explicitly rather than by omission.
   */
  readonly advertiseFsCapability: boolean;

  /** Advertise the `terminal` client capability at `initialize`. */
  readonly advertiseTerminalCapability: boolean;

  /** Extra `_meta` to stamp on the `initialize` request. */
  readonly initializeMeta: Readonly<Record<string, unknown>> | null;

  /** Identity ADE reports as the client. */
  readonly clientInfo: { name: string; title: string; version: string };

  /**
   * Notifications to send right after `session/new` succeeds. Grok needs one
   * here to switch off the auto-approve mode it reads from the user's Claude
   * settings file.
   */
  readonly postSessionNewNotifications: (args: {
    sessionId: AcpSessionId;
  }) => AcpOutboundNotification[];

  /**
   * Return true to show a slash command in ADE's picker. Some agents advertise
   * commands that only their own terminal UI can run. Those commands reach the
   * model as plain text if a user picks them, so they are filtered out here.
   */
  readonly includeSlashCommand: (command: AcpAvailableCommand) => boolean;

  /**
   * Extension notifications that carry telemetry, keyed by the exact method
   * name. Grok's usage, model catalog, subagents, and compaction all ride
   * these. A reader returns no signals for a payload it does not recognize,
   * which is how Grok's spinner hint on the same method stays silent.
   */
  readonly extensionNotifications: Readonly<Record<string, AcpExtensionNotificationReader>>;

  /** Reads `usage_update` and the prompt result. Every dialect reads usage. */
  readonly usage: AcpPresentCapability<AcpUsageBehavior>;

  /** Reader for the provider's own on-disk usage ledger, when it keeps one. */
  readonly localUsage: AcpCapability<AcpLocalUsageBehavior>;

  /** Who pays for this provider's turns, from local non-secret config. */
  readonly readAccount: AcpAccountReader;

  /**
   * True when the agent reports context size but never reports a compaction.
   * The host then infers one from a sharp drop in `usage_update.used`.
   */
  readonly inferCompaction: boolean;

  /**
   * True when the agent sends its `usage_update` only after the turn settles,
   * after the `session/prompt` result. The host waits briefly for it so the
   * turn's context figure is this turn's, not the last one's.
   */
  readonly usageUpdateAfterTurn: boolean;

  /**
   * Turn a model id the agent reports (config option, extension notification)
   * into the plain model name. Absent means the id is already plain.
   */
  readonly modelIdFromAgent?: (raw: string) => string;

  /**
   * One short line that explains why this agent can serve a model other than
   * the one ADE asked for. It follows the served-model notice.
   */
  readonly servedModelMismatchNote?: string;

  /** Absent when the agent takes no reasoning effort through a config option. */
  readonly reasoningEffortOption?: AcpReasoningEffortOption;

  readonly sessionIdPersistence: AcpSessionIdPersistence;

  readonly authProbe: AcpAuthProbe;

  /**
   * One line per known hole, for the first-use degradation note. Keep each line
   * short, factual, and about behavior the user can see.
   */
  readonly degradationNotes: readonly string[];

  /** Optional mode-specific degradation note, emitted only for that mode. */
  readonly degradationNoteForMode?: (permissionMode: string | null | undefined) => string | null;

  /** Optional capabilities. Present ones carry their behavior. */
  readonly sessionConfig: AcpCapability<AcpSessionConfigBehavior>;
  readonly modelSelection: AcpCapability<AcpModelSelectionBehavior>;
  readonly mcpInjection: AcpCapability<AcpMcpInjectionBehavior>;
  readonly imagePrompts: AcpCapability<AcpImagePromptBehavior>;

  /**
   * Session config option ids this dialect sets. When `mode` is in the list,
   * the agent takes ADE's permission posture through that option. Grok lists
   * only `model` and `reasoning_effort`, because its posture rides spawn flags.
   */
  readonly configOptionIds: readonly string[];
};

export type AcpDialect = AcpDialectBase & AcpCloseContract & AcpLoadContract;

/**
 * Identity helper that pins a descriptor to the `AcpDialect` contract at its
 * definition site. Without it a dialect file only fails to typecheck where it
 * is consumed, which hides the error from the file that caused it.
 */
export function defineAcpDialect<const T extends AcpDialect>(dialect: T): T {
  return dialect;
}

// ── Host-facing callbacks ────────────────────────────────────────────────────

export type AcpSlashCommand = {
  name: string;
  description: string;
  /** Hint text the agent supplies for a command that takes an argument. */
  inputHint: string | null;
};

export type AcpConfigOptionSnapshot = {
  options: AcpSessionConfigOption[];
  currentModeId: string | null;
  availableModeIds: string[];
};

/** Exhaustiveness guard. Replaces a switch default. */
export function assertNever(value: never, label: string): never {
  throw new Error(`${label}: unexpected value ${JSON.stringify(value)}`);
}
