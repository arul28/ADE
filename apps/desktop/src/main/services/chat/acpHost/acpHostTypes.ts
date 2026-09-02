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
 * 2. The style fields that pair with a capability (`usageSource`, `closeStyle`,
 *    `loadPolicy`) are discriminants of contract unions. A dialect that says
 *    `closeStyle: "close_request"` must supply `closeSession.behavior`. A
 *    dialect that says `closeStyle: "kill_process"` must not.
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
 * Grok, and Copilot 1.0.82, answer a `session/cancel` REQUEST with -32601.
 * They accept the same call as a notification. Qwen and Kimi accept the
 * request form.
 */
export type AcpCancelStyle = "request" | "notification";

/**
 * How to end a session.
 *
 * `kill_process` means the agent has no `session/close`. Qwen 0.22.3 is in
 * that group: it does not advertise close and answers -32601. Each such chat
 * owns its own process and the host ends the chat by ending the process.
 * Kimi 0.39.1 advertises close and implements it, so it is `close_request`.
 */
export type AcpCloseStyle = "close_request" | "kill_process";

/** Where token and context numbers come from, when they come at all. */
export type AcpUsageSource = "usage_update" | "prompt_result_meta" | "none";

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

/**
 * Normalized usage sample. `null` means the payload carried nothing usable, and
 * the host emits no usage event for it.
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
};

export type AcpUsageBehavior = (input: {
  /** Present when the source is `usage_update`. */
  usageUpdate?: AcpUsageUpdate;
  /** Present when the source is `prompt_result_meta`. */
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

/** A usage source other than `none` demands a reader for it. */
export type AcpUsageContract =
  | { readonly usageSource: "none"; readonly usage: AcpAbsentCapability }
  | {
      readonly usageSource: "usage_update" | "prompt_result_meta";
      readonly usage: AcpPresentCapability<AcpUsageBehavior>;
    };

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
   * Extension notifications the host must receive and ignore. Grok sends a
   * spinner hint that looks like a permission request. Naming it here keeps it
   * out of the "unhandled notification" log and out of the permission bridge.
   */
  readonly ignoredNotificationMethods: readonly string[];

  readonly sessionIdPersistence: AcpSessionIdPersistence;

  readonly authProbe: AcpAuthProbe;

  /**
   * One line per known hole, for the first-use degradation note. Keep each line
   * short, factual, and about behavior the user can see.
   */
  readonly degradationNotes: readonly string[];

  /** Optional capabilities. Present ones carry their behavior. */
  readonly sessionConfig: AcpCapability<AcpSessionConfigBehavior>;
  readonly mcpInjection: AcpCapability<AcpMcpInjectionBehavior>;
  readonly imagePrompts: AcpCapability<AcpImagePromptBehavior>;

  /** Session config option ids this dialect can set, for the settings page. */
  readonly configOptionIds: readonly string[];
};

export type AcpDialect = AcpDialectBase & AcpUsageContract & AcpCloseContract & AcpLoadContract;

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
