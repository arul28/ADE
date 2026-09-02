import {
  policyAllowedMcpServers,
  policyToolLevelMcpServers,
} from "./permissionPolicy";
import type {
  AgentChatHostConfigLevel,
  AgentChatHostInstructions,
  AgentChatInstructionsCapability,
  AgentChatPermissionCapability,
  AgentChatPermissionPolicy,
  AgentChatProvider,
  AgentChatSettingSources,
  AgentChatSettingSourcesCapability,
  HostSessionConfigFields,
} from "./types/chat";
import type { ShippedProvider } from "./providers";

/**
 * Host session configuration: instructions, setting sources, permission policy.
 *
 * An external embedder (the ADE SDK) asks for three things at chat creation
 * that no provider honors the same way: its own instructions text, which
 * on-disk configuration layers the provider loads, and a structured permission
 * policy. This module owns what each provider can honestly do with each
 * request, and the pure functions that turn "what did the caller ask for" plus
 * "what can this provider do" into the report the embedder reads.
 *
 * It is the same shape, and for the same reason, as `CALLER_MCP_SUPPORT` in
 * `callerMcpServers.ts`: one table per feature, one `hasOwnProperty`-guarded
 * accessor, and an unknown provider reported as ignored/unsupported with an
 * explicit message rather than guessed at. A provider added without a decision
 * here is a compile error, not a silent default.
 *
 * These tables are the source of truth the `@ade-dev/sdk` docs summarize
 * (`sdk/threads.mdx`, `sdk/permissions.mdx`). Changing a row's `level` changes
 * those pages too.
 */

export type InstructionsSupport = {
  /**
   * "applied" — the provider has a real instruction channel and the host text
   *   reaches the model through it.
   * "best-effort" — ADE has no provider-level channel, so the text rides the
   *   mechanism ADE already uses for its own personal-chat prompt. `detail`
   *   names that mechanism.
   * "ignored" — the text does not reach the model at all.
   */
  level: AgentChatHostConfigLevel;
  /** The channel the text travels on. Reported verbatim to the embedder. */
  mechanism: string;
  /** Non-null when the level is not "applied": what the embedder should know. */
  detail: string | null;
};

export type SettingSourcesSupport = {
  /** Per requested value, because a provider can honor one value and not another. */
  levelFor: Readonly<Record<AgentChatSettingSources, AgentChatHostConfigLevel>>;
  mechanism: string;
  detail: string | null;
};

export type PermissionPolicySupport = {
  /**
   * "enforced" — every clause of the policy is applied by a real provider gate.
   * "best-effort" — ADE applies the strongest containment the provider exposes
   *   and some clauses do not apply. `residual` says which.
   * "unsupported" — the provider has no structured gate ADE can drive.
   */
  level: AgentChatPermissionCapability["level"];
  mechanism: string;
  residual: string | null;
};

/**
 * Which Claude Agent SDK setting layers each `settingSources` value maps to.
 *
 * Set explicitly in all four cases. `settingSources: []` and an omitted field
 * are not documented to be identical in the Agent SDK, so the behavior of an
 * ADE personal chat is a property of ADE rather than of a dependency default.
 */
export const CLAUDE_SETTING_SOURCE_MAP = {
  none: [],
  project: ["project"],
  user: ["user"],
  all: ["user", "project", "local"],
} as const satisfies Record<AgentChatSettingSources, readonly string[]>;

/**
 * Every accepted `settingSources` value, derived from the map above rather than
 * restated. The map is already `satisfies Record<AgentChatSettingSources, …>`,
 * so its keys ARE the union — writing them out a second time was a third
 * spelling of a four-member enum, and one a new value could be added without.
 */
export const HOST_SETTING_SOURCES_VALUES = Object.keys(
  CLAUDE_SETTING_SOURCE_MAP,
) as readonly AgentChatSettingSources[];

export const INSTRUCTIONS_SUPPORT = {
  claude: {
    level: "applied",
    mechanism: "Agent SDK option systemPrompt (string)",
    detail: null,
  },
  codex: {
    level: "applied",
    mechanism: "app-server thread/start param developerInstructions",
    detail: null,
  },
  opencode: {
    level: "applied",
    mechanism: "OpenCode prompt field `system` (first-class on the wire)",
    detail: null,
  },
  pi: {
    level: "applied",
    mechanism: "Pi SDK systemPromptOverride",
    detail: null,
  },
  cursor: {
    level: "best-effort",
    mechanism: "merged into the system text ADE prefixes into the first user prompt",
    detail:
      "The Cursor SDK's AgentOptions carries no system-prompt field, so ADE already prefixes its "
      + "own personal-chat text into the first user prompt. The host text joins that same text — "
      + "after it for append, instead of it for replace. It is therefore part of the prompt the "
      + "model sees rather than a separate system channel, and it does not persist across a "
      + "provider-side session rebuild the way a real system prompt would.",
  },
  droid: {
    level: "best-effort",
    mechanism: "merged into the harness prompt ADE prefixes onto every turn",
    detail:
      "The Factory SDK's session settings carry no instruction field, so ADE already prefixes a "
      + "harness prompt onto each user turn. The host text joins that prompt — after it for "
      + "append, instead of it for replace. It is repeated every turn rather than pinned as a "
      + "system prompt, so it competes with the turn's own text.",
  },
} as const satisfies Record<ShippedProvider, InstructionsSupport>;

export const SETTING_SOURCES_SUPPORT = {
  claude: {
    levelFor: { none: "applied", project: "applied", user: "applied", all: "applied" },
    mechanism: "Agent SDK option settingSources, set explicitly for all four values",
    detail: null,
  },
  codex: {
    levelFor: { none: "ignored", project: "best-effort", user: "ignored", all: "best-effort" },
    mechanism: "Codex reads AGENTS.md from the thread cwd; there is no switch to turn that off",
    detail:
      "Codex always discovers AGENTS.md in the thread's cwd and always loads ~/.codex/AGENTS.md, "
      + "and the app-server exposes no switch for either. 'project' and 'all' therefore describe "
      + "what Codex already does rather than something ADE turns on, and 'none' and 'user' cannot "
      + "be honored at all.",
  },
  cursor: {
    levelFor: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    mechanism: "none — ADE pins the Cursor SDK's own settingSources from the session permission policy",
    detail:
      "The Cursor SDK's settingSources is derived from ADE's permission policy, because dropping "
      + "the user layer would also drop ADE's own tool-gate hook. A host value would contradict "
      + "that and is not applied.",
  },
  droid: {
    levelFor: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    mechanism: "none — the Factory SDK exposes no configuration-layer switch",
    detail: "Droid resolves ~/.factory/settings.json itself and offers no per-session override.",
  },
  opencode: {
    levelFor: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    mechanism: "none — ADE authors the OpenCode server config itself",
    detail:
      "ADE runs a dedicated OpenCode server with an ADE-authored config and "
      + "OPENCODE_DISABLE_PROJECT_CONFIG=1. There is no per-session switch to re-enable layers.",
  },
  pi: {
    levelFor: { none: "ignored", project: "ignored", user: "ignored", all: "ignored" },
    mechanism: "none — the Pi SDK exposes no configuration-layer switch",
    detail: null,
  },
} as const satisfies Record<ShippedProvider, SettingSourcesSupport>;

/**
 * What Claude's answer depends on that no other provider's does: the fallback.
 *
 * Measured against Agent SDK 0.3.258 — `allowedTools` and `disallowedTools` are
 * enforced, because the CLI removes a denied tool from the model's catalog, but
 * `canUseTool` did not fire on any permission mode tried. So the two lists are
 * the enforceable surface and the prompt path is not.
 *
 * `fallback: "deny"` is therefore expressible entirely in the lists and is
 * reported as enforced. `fallback: "ask"` needs the prompt to run and is
 * reported as best-effort, with this residual naming why.
 */
const CLAUDE_ASK_FALLBACK_RESIDUAL =
  "the ask verdict depends on the Agent SDK permission prompt; a user-level Claude setting such "
  + "as permissions.defaultMode: auto can pre-approve an unlisted tool before ADE's gate runs. "
  + "deniedTools/allowedTools are enforced either way.";

export const PERMISSION_POLICY_SUPPORT = {
  // Claude's row is the floor, not the answer: its level depends on the
  // policy's `fallback`, so `resolvePermissionCapability` decides it there.
  // A deny fallback is expressible in the tool lists alone and is enforced; an
  // ask fallback needs the Agent SDK's permission prompt to fire, which is the
  // part ADE does not control.
  claude: {
    level: "best-effort",
    mechanism: "Agent SDK allowedTools/disallowedTools plus a canUseTool gate that evaluates the policy",
    residual: CLAUDE_ASK_FALLBACK_RESIDUAL,
  },
  // The sandbox decides most of this row, not the policy. Measured against a
  // live Codex app-server: under `sandbox: workspace-write` a command or a
  // write inside the thread's cwd, `$TMPDIR`, or `/tmp` raises no approval at
  // all, so the policy is never consulted for it. The policy governs the
  // requests Codex does raise, which are the sandbox escapes.
  codex: {
    level: "best-effort",
    mechanism:
      "approvalPolicy on-request with sandbox workspace-write. Codex runs commands and file "
      + "changes inside the thread's cwd, $TMPDIR, and /tmp without raising an approval, so the "
      + "policy never sees them. Only a sandbox escape raises an approval request, and that is "
      + "what the policy answers: a request contained by sandboxRoot is auto-accepted, and "
      + "everything else goes to fallback, so 'ask' raises an approval request and 'deny' "
      + "declines it. A policy with no sandboxRoot contains nothing, so every escape goes "
      + "straight to fallback. Legacy full auto is the one exception: it auto-accepts every "
      + "request before containment is consulted, and a policy sent through the SDK cannot "
      + "reach it because that forces permissionMode 'default'.",
    residual:
      "The policy governs sandbox escapes only. Commands and file changes inside the thread's "
      + "cwd, $TMPDIR, or /tmp are ungated by Codex's own sandbox and reach neither sandboxRoot "
      + "nor fallback. allowedTools, deniedTools, and autoApproveMcpServers are Claude-only "
      + "fields: nothing on the Codex path reads them, so sandboxRoot containment and then "
      + "fallback are the whole decision. Do not read deniedTools as a shell or tool blocklist "
      + "on Codex — it is not consulted. Codex also does not route plain MCP tool calls through "
      + "an approval request, so they are ungated too.",
  },
  cursor: {
    level: "unsupported",
    mechanism: "none — the Cursor SDK takes a mode preset, not a rule set",
    residual: null,
  },
  droid: {
    level: "unsupported",
    mechanism: "none — the Factory SDK takes an autonomy level, not a rule set",
    residual: null,
  },
  opencode: {
    level: "unsupported",
    mechanism: "none — OpenCode takes an agent profile, not a rule set",
    residual: null,
  },
  pi: {
    level: "unsupported",
    mechanism: "none — the Pi SDK takes a tool policy ADE derives from the session mode",
    residual: null,
  },
} as const satisfies Record<ShippedProvider, PermissionPolicySupport>;

/**
 * The only way to read a table. `hasOwnProperty` rather than a bare index:
 * every inherited `Object.prototype` key ("constructor", "toString", …) is a
 * string a provider field could hold, and each one would otherwise return a
 * function the callers below would read `.level` off.
 */
function tableRow<T>(
  table: Readonly<Record<ShippedProvider, T>>,
  provider: AgentChatProvider | string,
): T | null {
  if (typeof provider !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(table, provider)) return null;
  return table[provider as ShippedProvider];
}

export function instructionsSupport(
  provider: AgentChatProvider | string,
): InstructionsSupport | null {
  return tableRow<InstructionsSupport>(INSTRUCTIONS_SUPPORT, provider);
}

export function settingSourcesSupport(
  provider: AgentChatProvider | string,
): SettingSourcesSupport | null {
  return tableRow<SettingSourcesSupport>(SETTING_SOURCES_SUPPORT, provider);
}

export function permissionPolicySupport(
  provider: AgentChatProvider | string,
): PermissionPolicySupport | null {
  return tableRow<PermissionPolicySupport>(PERMISSION_POLICY_SUPPORT, provider);
}

/**
 * Accept the two shapes an embedder may send and return one.
 *
 * A bare string is shorthand for `{ mode: "append", text }`, because a host
 * that just wants to add a persona should not have to learn the union first.
 * Empty or whitespace-only text is rejected rather than stored: an empty
 * `replace` would silently erase ADE's own prompt, and an empty `append` would
 * make `instructionsCapability` claim something was applied when nothing was.
 */
export function normalizeHostInstructions(value: unknown): AgentChatHostInstructions | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length ? { mode: "append", text } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { mode?: unknown; text?: unknown };
  if (typeof record.text !== "string") return null;
  const text = record.text.trim();
  if (!text.length) return null;
  const mode = record.mode === "replace" ? "replace" : "append";
  return { mode, text };
}

export function normalizeSettingSources(value: unknown): AgentChatSettingSources | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return (HOST_SETTING_SOURCES_VALUES as readonly string[]).includes(trimmed)
    ? (trimmed as AgentChatSettingSources)
    : null;
}

/**
 * What this provider actually did with the caller's instructions.
 *
 * Call it only when the caller supplied instructions. Absent means never
 * requested, exactly as `mcpCapability` does, so an embedder can tell "you
 * asked and it was ignored" from "you never asked".
 */
export function resolveInstructionsCapability(
  provider: AgentChatProvider | string,
  instructions: Pick<AgentChatHostInstructions, "mode">,
): AgentChatInstructionsCapability {
  const support = instructionsSupport(provider);
  // A provider missing from the table is a provider added without a decision
  // here — report it as ignored rather than guessing that it carried the text.
  if (!support) {
    return {
      level: "ignored",
      mode: instructions.mode,
      mechanism: `No instructions decision is recorded for provider '${String(provider)}'.`,
      detail: "ADE does not know this provider's instruction channel, so the text was not sent.",
    };
  }
  return {
    level: support.level,
    mode: instructions.mode,
    mechanism: support.mechanism,
    detail: support.detail,
  };
}

/**
 * What this provider actually did with the caller's `settingSources`.
 *
 * The level is per requested value: Codex honors "project" as a description of
 * what it already does and cannot honor "none" at all, and reporting one level
 * for the whole feature would be a claim about a value nobody asked for.
 */
export function resolveSettingSourcesCapability(
  provider: AgentChatProvider | string,
  value: AgentChatSettingSources,
): AgentChatSettingSourcesCapability {
  const support = settingSourcesSupport(provider);
  if (!support) {
    return {
      level: "ignored",
      value,
      mechanism: `No settingSources decision is recorded for provider '${String(provider)}'.`,
      detail: "ADE does not know this provider's configuration layers, so the request was dropped.",
    };
  }
  const level = Object.prototype.hasOwnProperty.call(support.levelFor, value)
    ? support.levelFor[value]
    : "ignored";
  return {
    level,
    value,
    mechanism: support.mechanism,
    // The detail explains a level that is not "applied". Emitting it for an
    // applied value would describe a limitation that did not apply.
    detail: level === "applied" ? null : support.detail,
  };
}

/**
 * The residual sentence for `sandboxRoot` under a Claude deny fallback.
 *
 * Exported for the same reason as `CLAUDE_ASK_FALLBACK_RESIDUAL`: two test
 * files assert on this text, and a substring match against copy assembled
 * elsewhere breaks on a wording change that broke nothing.
 */
export const CLAUDE_DENY_SANDBOX_ROOT_RESIDUAL =
  "sandboxRoot is not applied on Claude under a deny fallback: containment is a per-call "
  + "decision and the per-call hook does not fire, so a mutating built-in is denied "
  + "outright unless allowedTools names it.";

/** Prefix of the residual naming caller MCP servers the policy shuts out. */
export const CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX = "caller MCP servers blocked by the policy: ";

/** Prefix of the residual naming servers admitted whole by a per-tool entry. */
export const CLAUDE_TOOL_LEVEL_MCP_RESIDUAL_PREFIX =
  "individual MCP tool entries admit the whole server on Claude; the unnamed tools of ";

/**
 * Claude's own answer, which is the only one that reads the policy's contents.
 *
 * Every other provider's verdict is its table row. Claude's depends on
 * `fallback`, on whether an `allowedTools` entry names one MCP tool rather than
 * a whole server, and on which caller-supplied servers the policy shuts out —
 * so it is a function, and it sits here rather than inside the table lookup it
 * used to be three quarters of.
 */
function resolveClaudePermissionCapability(
  policy: AgentChatPermissionPolicy,
  context: { callerMcpServerNames?: readonly string[] },
): AgentChatPermissionCapability {
  if (policy.fallback !== "deny") {
    return {
      level: "best-effort",
      mechanism: "Agent SDK allowedTools/disallowedTools plus a canUseTool gate that evaluates the policy",
      residual: CLAUDE_ASK_FALLBACK_RESIDUAL,
    };
  }
  // Every clause the deny fallback cannot enforce, gathered before the level
  // is decided. "enforced" is claimed only when this list is empty of the
  // clauses that would make it a lie.
  //
  // sandboxRoot always lands here: containment is a per-call decision about a
  // path, and the per-call hook is the one that does not fire. It does not
  // downgrade the level, because the deny fallback answers it by refusing the
  // tool outright — stricter than the root, never looser.
  const residuals: string[] = [CLAUDE_DENY_SANDBOX_ROOT_RESIDUAL];
  // This one DOES downgrade. `allowManagedMcpServersOnly` is per-server, so an
  // entry naming one tool admits the whole server, and the per-tool refusal
  // would have to come from the hook that does not fire.
  const toolLevelServers = policyToolLevelMcpServers(policy);
  const allowedServers = policyAllowedMcpServers(policy);
  const blockedCallerServers = (context.callerMcpServerNames ?? []).filter((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return !allowedServers.some((allowed) => allowed.toLowerCase() === trimmed.toLowerCase());
  });
  if (blockedCallerServers.length > 0) {
    residuals.push(`${CLAUDE_BLOCKED_CALLER_SERVERS_PREFIX}${blockedCallerServers.join(", ")}`);
  }
  if (toolLevelServers.length === 0) {
    return {
      level: "enforced",
      mechanism:
        "Agent SDK allowedTools/disallowedTools, which remove a denied tool from the model's "
        + "catalog, plus allowManagedMcpServersOnly scoped to the servers the policy names. "
        + "Every mutating built-in the policy does not name is denied up front, so no prompt "
        + "is needed and none is relied on. A canUseTool gate stays wired behind that.",
      residual: residuals.join(" "),
    };
  }
  return {
    level: "best-effort",
    mechanism:
      "Agent SDK allowedTools/disallowedTools plus allowManagedMcpServersOnly scoped to the "
      + "servers the policy names, which is per-server rather than per-tool.",
    residual: [
      `${CLAUDE_TOOL_LEVEL_MCP_RESIDUAL_PREFIX}${toolLevelServers.join(", ")} are not refused.`,
      ...residuals,
    ].join(" "),
  };
}

/**
 * What this provider actually does with the caller's permission policy.
 *
 * A null policy means the caller used a preset instead, in which case the
 * report says the policy surface is unused rather than claiming enforcement.
 * The policy itself is taken rather than a boolean because on Claude the level
 * depends on `fallback`, not merely on whether a policy exists.
 */
export function resolvePermissionCapability(
  provider: AgentChatProvider | string,
  policy: AgentChatPermissionPolicy | null | undefined,
  context: { callerMcpServerNames?: readonly string[] } = {},
): AgentChatPermissionCapability {
  const support = permissionPolicySupport(provider);
  if (!support) {
    return {
      level: "unsupported",
      mechanism: `No permission-policy decision is recorded for provider '${String(provider)}'.`,
      residual: null,
    };
  }
  if (!policy) {
    return {
      level: "unsupported",
      mechanism: "No structured permission policy was supplied; the session's permission mode applies.",
      residual: null,
    };
  }
  if (provider === "claude") return resolveClaudePermissionCapability(policy, context);
  return {
    level: support.level,
    mechanism: support.mechanism,
    residual: support.residual,
  };
}

/**
 * A persisted report's own record, or null when the value is not one.
 *
 * `mechanism` is required on all three reports, so it is checked here too: a
 * record without it is a half-written report, which is exactly what the three
 * normalizers refuse.
 */
function asCapabilityRecord(value: unknown): { level: unknown; mechanism: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.mechanism !== "string") return null;
  return { level: record.level, mechanism: record.mechanism };
}

/** The level the instructions and settingSources reports share. */
function isHostConfigLevel(value: unknown): value is AgentChatHostConfigLevel {
  return value === "applied" || value === "best-effort" || value === "ignored";
}

/** The permission report's own level set. Enforcement, not delivery. */
function isPermissionLevel(
  value: unknown,
): value is AgentChatPermissionCapability["level"] {
  return value === "enforced" || value === "best-effort" || value === "unsupported";
}

function detailOf(value: unknown): string | null {
  const record = value as Record<string, unknown>;
  return typeof record.detail === "string" ? record.detail : null;
}

/**
 * Rehydrate a persisted capability report.
 *
 * A record written by an older build can be missing fields or carry a level
 * this build does not know. Returning null for anything unrecognized keeps a
 * resumed session reporting "never requested" instead of a half-formed claim.
 */
export function normalizeInstructionsCapability(
  value: unknown,
): AgentChatInstructionsCapability | null {
  const record = asCapabilityRecord(value);
  if (!record || !isHostConfigLevel(record.level)) return null;
  return {
    level: record.level,
    mode: (value as Record<string, unknown>).mode === "replace" ? "replace" : "append",
    mechanism: record.mechanism,
    detail: detailOf(value),
  };
}

export function normalizeSettingSourcesCapability(
  value: unknown,
): AgentChatSettingSourcesCapability | null {
  const record = asCapabilityRecord(value);
  if (!record || !isHostConfigLevel(record.level)) return null;
  const requested = normalizeSettingSources((value as Record<string, unknown>).value);
  if (!requested) return null;
  return {
    level: record.level,
    value: requested,
    mechanism: record.mechanism,
    detail: detailOf(value),
  };
}

export function normalizePermissionCapability(
  value: unknown,
): AgentChatPermissionCapability | null {
  const record = asCapabilityRecord(value);
  if (!record || !isPermissionLevel(record.level)) return null;
  return {
    level: record.level,
    mechanism: record.mechanism,
    residual: typeof (value as Record<string, unknown>).residual === "string"
      ? (value as Record<string, unknown>).residual as string
      : null,
  };
}

/**
 * Re-exported from `types/chat.ts`, where the six fields are declared and
 * documented. The type lives there because the shapes that carry it —
 * `AgentChatSession`, `AgentChatSessionSummary` — live there, and importing
 * the other direction would make a cycle. The helpers that copy the set at
 * runtime live here.
 */
export type { HostSessionConfigFields };

/**
 * The same six fields with each one also permitting null.
 *
 * What a caller actually holds: a local that is null when the embedder named
 * nothing. `pickHostSessionConfig` drops null and undefined alike, so a caller
 * passes its locals straight in rather than writing six conditional spreads to
 * turn null into an absent key.
 */
export type HostSessionConfigSource = {
  [K in keyof HostSessionConfigFields]?: HostSessionConfigFields[K] | null;
};

/** Every key of {@link HostSessionConfigFields}, in one list. */
const HOST_SESSION_CONFIG_KEYS = [
  "permissionPolicy",
  "instructions",
  "settingSources",
  "instructionsCapability",
  "settingSourcesCapability",
  "permissionCapability",
] as const satisfies readonly (keyof HostSessionConfigFields)[];

/**
 * The host session configuration a source carries, with absent fields omitted.
 *
 * Used wherever the six fields are copied from one object to another, so the
 * set is named once and a seventh field cannot be copied at three sites and
 * forgotten at the fourth. What a forgotten field costs is a persisted value
 * that the next write silently deletes.
 *
 * Omitted rather than set to undefined, because these objects are spread into
 * records that are persisted as JSON, where a present `undefined` and an absent
 * key are not the same on the way back. Null is dropped too, so a caller holding
 * "not set" as null passes its values straight in.
 */
export function pickHostSessionConfig(
  source: HostSessionConfigSource | null | undefined,
): HostSessionConfigFields {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const key of HOST_SESSION_CONFIG_KEYS) {
    const value = source[key];
    if (value != null) out[key] = value;
  }
  return out as HostSessionConfigFields;
}

/**
 * The same six fields, taking each one from `live` when it has it.
 *
 * For the session summary, which answers from a running session when there is
 * one and from the persisted record otherwise. Merged per field rather than per
 * object: a live session that has rehydrated its policy but not yet its
 * capability report should still report the persisted capability.
 */
export function mergeHostSessionConfig(
  live: HostSessionConfigSource | null | undefined,
  persisted: HostSessionConfigSource | null | undefined,
): HostSessionConfigFields {
  return { ...pickHostSessionConfig(persisted), ...pickHostSessionConfig(live) };
}
