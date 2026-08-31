import type {
  AgentChatMcpCapability,
  AgentChatMcpServerConfig,
  AgentChatProvider,
} from "./types/chat";

/**
 * Caller-injected MCP servers.
 *
 * An external embedder (the ADE SDK) hands ADE a set of MCP servers when it
 * creates a chat, plus an optional `strictMcpConfig` that asks ADE to withhold
 * the *user's* own MCP configuration from that chat. This module owns the two
 * things every provider adapter needs to agree on: what a valid injected server
 * looks like, and what each provider can honestly do with one — deliver it, and
 * enforce strict mode over it.
 *
 * `CALLER_MCP_SUPPORT`'s strict-mode fields are deliberately the same shape as
 * `ORCHESTRATION_LEAD_MCP_ISOLATION` in `orchestrationRuntimePolicy.ts`, and
 * for the providers where the mechanism is identical it says so. The two are
 * separate because they answer different questions: the orchestration table
 * asks "can a lead be denied capability", this one asks "can an embedder be
 * promised a clean MCP surface".
 */

export type CallerMcpServers = Record<string, AgentChatMcpServerConfig>;

export type CallerMcpSupport = {
  /**
   * "enforced" — the user's MCP config provably does not load.
   * "best-effort" — ADE applies the strongest mechanism the provider exposes,
   *   but a residual path can still surface user servers. `residual` says which.
   * "unsupported" — the provider has no MCP surface at all; injected servers
   *   are not delivered and strict mode is meaningless.
   */
  level: "enforced" | "best-effort" | "unsupported";
  /** How strict mode is applied. Only a claim when the caller asked for it. */
  mechanism: string;
  /** Non-null exactly when `level` is "best-effort": the hole that remains. */
  residual: string | null;
  /**
   * How the caller's servers reach the provider, independent of strict mode.
   * `mcpCapability.mechanism` reports this when the caller never asked for
   * strict mode — describing the strict mechanism there would claim an
   * isolation guarantee nobody asked for.
   */
  delivery: string;
  /**
   * Transports this provider has no client for. A server ADE cannot express in
   * the provider's own config would otherwise be handed over as the nearest
   * thing the provider does understand, connecting over the wrong protocol
   * instead of failing — the same silent under-delivery the Pi refusal exists
   * to prevent.
   */
  unsupportedTransports?: readonly AgentChatMcpServerConfig["type"][];
};

/**
 * Every provider ADE ships, named exactly. `AgentChatProvider` widens to
 * `string` for forward compatibility, which would let a new provider be added
 * with no entry below; this narrow alias makes the omission a compile error
 * instead, the same way `McpCapableProvider` does for orchestration.
 */
export type CallerMcpProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | "pi";

/**
 * One row per provider, and one accessor onto it. These facts were three
 * parallel maps keyed by provider name — strict mode, delivery, and unsupported
 * transports — which is three chances to add a provider to two of them, and it
 * cost a real bug: the transports map was read with a bare index, so the
 * provider name "constructor" resolved to `Object.prototype.constructor` and
 * threw inside the create-path refusal gate. Everything now goes through
 * `callerMcpSupport`, which is `hasOwnProperty`-guarded.
 *
 * This table is also the source of truth the `@ade-dev/sdk` docs summarize
 * (`packages/sdk/src/client.ts`, `ThreadOpenOptions.loadUserMcpServers`) and
 * the SDK's test fixture pins for `claude` and `pi`
 * (`packages/sdk/test/mockRuntime.ts`, `PROVIDER_MCP_VERDICTS`). Changing a
 * row's `level` is a change to both of those too.
 */
export const CALLER_MCP_SUPPORT = {
  claude: {
    level: "enforced",
    mechanism: "Agent SDK option strictMcpConfig",
    residual: null,
    delivery: "Agent SDK option mcpServers (programmatic, additive to the user's own config)",
  },
  codex: {
    level: "best-effort",
    // Same mechanism as ORCHESTRATION_LEAD_MCP_ISOLATION.codex; kept separate
    // because this string is reported to the embedder.
    mechanism: "thread config overlay: mcp_servers.<name>.enabled = false per configured server",
    residual:
      "Codex merges the thread `config` overlay into config.toml rather than replacing it, so "
      + "there is no 'load nothing' switch — ADE enumerates config.toml's mcp_servers table and "
      + "disables each entry. A server contributed by a Codex *plugin* never appears in that table "
      + "and cannot be enumerated, so it survives strict mode.",
    delivery: "thread config overlay: mcp_servers.<name> with enabled = true",
    // Codex's `mcp_servers` table has exactly two forms, `command` and `url`,
    // and the `url` form is streamable HTTP. There is no `sse` variant, so an
    // SSE server would be dialed as HTTP.
    unsupportedTransports: ["sse"],
  },
  cursor: {
    level: "best-effort",
    // Same mechanism as ORCHESTRATION_LEAD_MCP_ISOLATION.cursor; kept separate
    // because this string is reported to the embedder.
    mechanism: "local.settingSources with the project and plugin layers dropped",
    residual:
      "The Cursor SDK derives includeProjectMcp/includePluginMcp from settingSources, so dropping "
      + "those layers drops their servers. The `user` layer must stay — ADE's own preToolUse "
      + "tool-gate hook is a user-layer artifact (~/.cursor/hooks.json) — so user-level MCP servers "
      + "still load.",
    delivery: "Cursor SDK inline mcpServers keyed by name",
  },
  droid: {
    level: "best-effort",
    // Same mechanism as ORCHESTRATION_LEAD_MCP_ISOLATION.droid; kept separate
    // because this string is reported to the embedder.
    mechanism: "session-scoped toggleMcpTool over the live MCP tool list",
    residual:
      "Droid has no config-level MCP switch, so ADE disables non-ADE MCP tools per session after "
      + "the server list is live. A server whose tools appear only after the first disable pass is "
      + "not covered until the next turn.",
    delivery: "session mcpServers list supplied at session initialization",
  },
  opencode: {
    level: "best-effort",
    // Same mechanism as ORCHESTRATION_LEAD_MCP_ISOLATION.opencode; kept
    // separate because this string is reported to the embedder.
    mechanism: "dedicated server with ADE-authored config + OPENCODE_DISABLE_PROJECT_CONFIG=1",
    residual:
      "The project config layer is disabled and the config is ADE-authored, but the dedicated "
      + "server still resolves the user's global OpenCode config directory for auth.",
    delivery: "dedicated server config `mcp` entries",
  },
  pi: {
    level: "unsupported",
    mechanism: "none — the Pi SDK exposes no MCP configuration",
    residual: null,
    delivery: "none — the Pi SDK exposes no MCP configuration",
  },
} as const satisfies Record<CallerMcpProvider, CallerMcpSupport>;

/**
 * The only way to read the table. `hasOwnProperty` rather than a bare index:
 * every inherited `Object.prototype` key ("constructor", "toString", …) is a
 * string a provider field could hold, and each one would otherwise return a
 * function that the callers below would read `.level` or iterate.
 */
export function callerMcpSupport(
  provider: AgentChatProvider | string,
): CallerMcpSupport | null {
  if (!Object.prototype.hasOwnProperty.call(CALLER_MCP_SUPPORT, provider)) return null;
  return CALLER_MCP_SUPPORT[provider as CallerMcpProvider];
}

/**
 * Providers that can receive caller-injected MCP servers, in table order. The
 * refusal message names these rather than a hand-written list, so adding a
 * provider to the table is the only edit adding it needs.
 */
export const CALLER_MCP_CAPABLE_PROVIDERS: readonly CallerMcpProvider[] =
  (Object.keys(CALLER_MCP_SUPPORT) as CallerMcpProvider[])
    .filter((name) => CALLER_MCP_SUPPORT[name].level !== "unsupported");

/** True when the provider can receive caller-injected MCP servers at all. */
export function providerAcceptsCallerMcpServers(
  provider: AgentChatProvider | string,
): boolean {
  const support = callerMcpSupport(provider);
  // `callerMcpSupport(p)?.level !== "unsupported"` failed OPEN: a provider
  // missing from the table read as capable, which is the exact case the table
  // exists to make a decision about. An unknown provider is not known to be
  // able to carry the servers, so it cannot.
  return support != null && support.level !== "unsupported";
}

/**
 * The caller servers this provider has no transport for, or null when every
 * server is expressible. Named keys, because the caller has to know which ones.
 */
export function callerMcpUnsupportedTransport(
  provider: AgentChatProvider | string,
  servers: CallerMcpServers,
): { transport: string; names: string[] } | null {
  const unsupported = callerMcpSupport(provider)?.unsupportedTransports;
  if (!unsupported?.length) return null;
  for (const transport of unsupported) {
    const names = Object.entries(servers)
      .filter(([, config]) => config.type === transport)
      .map(([name]) => name);
    if (names.length) return { transport, names };
  }
  return null;
}

/**
 * The one place that turns "what did the caller ask for" plus "what can this
 * provider do" into the report an embedder reads. Both the create path and the
 * model-switch path call it, so a switch can never produce a report shaped
 * differently from the one create produced.
 */
export function resolveCallerMcpCapability(
  provider: AgentChatProvider | string,
  // An object, not two positional booleans: adjacent same-typed parameters swap
  // silently, and the swap type-checks.
  { hasServers, strictRequested }: { hasServers: boolean; strictRequested: boolean },
): AgentChatMcpCapability {
  const support = callerMcpSupport(provider);
  // A provider missing from the table is a provider added without a decision
  // here — report it as undelivered rather than guessing.
  if (!support) {
    return {
      level: "unsupported",
      mechanism: `No MCP decision is recorded for provider '${provider}'.`,
      residual: null,
      delivered: false,
      strictRequested,
    };
  }
  // "Nothing the caller asked for was dropped" — NOT "servers exist". A
  // strict-only request has nothing to deliver, and a provider with no MCP
  // surface delivers nothing whatever was asked for, so this reads off the
  // provider's capability alone.
  const delivered = support.level !== "unsupported";
  const mechanism = [
    ...(hasServers ? [support.delivery] : []),
    // Strict-mode text is a claim about withholding the user's config. Emitting
    // it for a caller that never asked for strict mode described an enforcement
    // ADE is not performing.
    ...(strictRequested ? [support.mechanism] : []),
  ].join("; ");
  return {
    level: support.level,
    mechanism,
    residual: strictRequested ? support.residual : null,
    delivered,
    strictRequested,
  };
}

/**
 * Server names ADE injects itself. A caller reusing one would either shadow an
 * ADE-managed server or be shadowed by it depending on the adapter's merge
 * order — silently, and differently per provider. Rejecting the collision is
 * the only outcome that behaves the same everywhere.
 *
 * Mirrors CTO_MCP_SERVER_NAME / ORCHESTRATION_CLAUDE_SERVER_NAME in
 * agentChatService.ts and the `computer_use` key in codexComputerUse.ts. Kept
 * here rather than imported because this module is shared and must not pull in
 * the 49k-line service.
 */
export const ADE_RESERVED_MCP_SERVER_NAMES: readonly string[] = [
  "computer_use",
  "ade-cto",
  "ade-orchestration",
];

/** Ceiling on injected servers. Each one costs a connection and a tool catalog. */
export const MAX_CALLER_MCP_SERVERS = 32;

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

class CallerMcpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallerMcpServerError";
  }
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || typeof raw !== "string") continue;
    out[name] = raw;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validates and normalizes one caller-supplied server in a single pass: either
 * the config ADE will hand a provider verbatim, or the reason it cannot.
 *
 * One traversal rather than a validator plus a normalizer, because two passes
 * over the same fields can disagree about what "valid" means — and the strict
 * entry point below then needs an unreachable "validated but unreadable" branch
 * to satisfy the types.
 */
type CallerMcpServerRead =
  | { ok: true; config: AgentChatMcpServerConfig }
  | { ok: false; problem: string };

function readCallerMcpServer(name: string, value: unknown): CallerMcpServerRead {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      problem: `server name '${name}' must be 1-64 characters of A-Z, a-z, 0-9, underscore, or hyphen`,
    };
  }
  if (ADE_RESERVED_MCP_SERVER_NAMES.includes(name)) {
    return { ok: false, problem: `server name '${name}' is reserved by ADE` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: `server '${name}' must be an object` };
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (type === "http" || type === "sse") {
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) return { ok: false, problem: `server '${name}' is type '${type}' and needs a url` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, problem: `server '${name}' has a url that is not a valid absolute URL: ${url}` };
    }
    // Scheme allow-list, not a block-list. `file:` would read local paths and a
    // custom scheme would be handed to whatever the provider's client does with
    // it; only the two transports MCP actually defines over HTTP are accepted.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, problem: `server '${name}' must use http: or https:, got ${parsed.protocol}` };
    }
    const headers = normalizeStringRecord(record.headers);
    return {
      ok: true,
      config: {
        type,
        url,
        ...(headers ? { headers } : {}),
      },
    };
  }
  if (type === "stdio") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    if (!command) return { ok: false, problem: `server '${name}' is type 'stdio' and needs a command` };
    if (record.args !== undefined && !Array.isArray(record.args)) {
      return { ok: false, problem: `server '${name}' has args that are not an array` };
    }
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string")
      : null;
    const env = normalizeStringRecord(record.env);
    return {
      ok: true,
      config: {
        type: "stdio",
        command,
        ...(args?.length ? { args } : {}),
        ...(env ? { env } : {}),
      },
    };
  }
  return {
    ok: false,
    problem:
      `server '${name}' has an unsupported type '${String(record.type ?? "")}' (use http, sse, or stdio)`,
  };
}

/**
 * Normalizes the whole caller map. Returns null (not `{}`) when nothing valid
 * survives, so every call site can keep using the `...(x ? { mcpServers: x } : {})`
 * spread that guarantees a chat without injected servers is byte-for-byte
 * unchanged.
 */
export function normalizeCallerMcpServers(value: unknown): CallerMcpServers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: CallerMcpServers = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    const read = readCallerMcpServer(name, raw);
    if (read.ok) out[name] = read.config;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Strict entry point for the CREATE path.
 *
 * `normalizeCallerMcpServers` above drops what it cannot use, which is right
 * for rehydrating a persisted record — a corrupt field must not make an
 * existing chat unloadable. It is wrong for a caller's request: dropping a
 * server there hands back a chat quietly missing the tools it asked for, which
 * is the same silent under-delivery the Pi refusal exists to prevent. So this
 * one throws, naming every offending key at once rather than making the caller
 * fix them one round trip at a time.
 */
export function parseCallerMcpServers(value: unknown): CallerMcpServers | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CallerMcpServerError("mcpServers must be an object keyed by server name.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return null;
  if (entries.length > MAX_CALLER_MCP_SERVERS) {
    throw new CallerMcpServerError(
      `mcpServers has ${entries.length} servers, more than the ${MAX_CALLER_MCP_SERVERS} ADE will inject into one chat.`,
    );
  }
  const problems: string[] = [];
  const out: CallerMcpServers = {};
  for (const [key, raw] of entries) {
    const name = key.trim();
    if (!name) {
      problems.push("a server name is empty");
      continue;
    }
    const read = readCallerMcpServer(name, raw);
    if (!read.ok) {
      problems.push(read.problem);
      continue;
    }
    out[name] = read.config;
  }
  if (problems.length) {
    throw new CallerMcpServerError(`Invalid mcpServers: ${problems.join("; ")}.`);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * `fallbackStrictRequested` covers reports persisted before `strictRequested`
 * existed: the session row's own strict flag is what the field would have said,
 * so a reopened chat reports the same thing it did when it was created.
 */
export function normalizeCallerMcpCapability(
  value: unknown,
  fallbackStrictRequested = false,
): AgentChatMcpCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const level = record.level;
  if (level !== "enforced" && level !== "best-effort" && level !== "unsupported") return null;
  const strictRequested = typeof record.strictRequested === "boolean"
    ? record.strictRequested
    : fallbackStrictRequested;
  return {
    level,
    mechanism: typeof record.mechanism === "string" ? record.mechanism : "",
    // Gated on the RESOLVED `strictRequested`, matching
    // `resolveCallerMcpCapability` above and the SDK's own normalizer: a
    // residual names what strict mode could not exclude, so a delivery-only
    // report that carries one — because it was persisted by an older build, or
    // because the fallback resolved strict to false — would describe an
    // isolation this chat never asked for.
    residual: strictRequested && typeof record.residual === "string" ? record.residual : null,
    delivered: record.delivered === true,
    strictRequested,
  };
}

/**
 * Codex's `mcp_servers` config table is TOML, and the app-server merges the
 * thread overlay into it. HTTP/SSE servers use `url`; stdio servers use
 * `command`/`args`/`env`. `enabled = true` is explicit so a caller server is
 * not left off by a `[mcp_servers]` default the user set.
 */
export function callerMcpServersToCodexConfig(
  servers: CallerMcpServers,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(servers)) {
    out[name] = config.type === "stdio"
      ? {
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        enabled: true,
      }
      : {
        url: config.url,
        ...(config.headers ? { http_headers: config.headers } : {}),
        enabled: true,
      };
  }
  return out;
}

/**
 * Providers whose inline shape is structurally identical to ADE's: a record
 * keyed by server name, with the same three transports and the same field
 * names. Today that is the Claude Agent SDK's `mcpServers` and Cursor's inline
 * servers — two identical copies of this function used to exist, one per
 * provider, which is two places for the same assumption to drift.
 *
 * It stays a named function rather than a bare spread at the call sites so the
 * assumption has one place to break, and so no call site needs an `as` cast to
 * assert it.
 */
export function callerMcpServersToInlineRecord(
  servers: CallerMcpServers,
): Record<string, AgentChatMcpServerConfig> {
  return { ...servers };
}

/**
 * OpenCode config shape: an HTTP/SSE server is "remote", a stdio server is
 * "local" with `command` as a single argv array.
 */
export type OpenCodeMcpServerConfig =
  | { type: "local"; command: string[]; environment?: Record<string, string>; enabled: true }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled: true };

export function callerMcpServersToOpenCodeConfig(
  servers: CallerMcpServers,
): Record<string, OpenCodeMcpServerConfig> {
  const out: Record<string, OpenCodeMcpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    out[name] = config.type === "stdio"
      ? {
        type: "local",
        command: [config.command, ...(config.args ?? [])],
        ...(config.env ? { environment: config.env } : {}),
        enabled: true,
      }
      : {
        type: "remote",
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        enabled: true,
      };
  }
  return out;
}

/**
 * Droid takes a list, with the server name as a field rather than a key — and
 * its `InitializeSessionRequestParams` validates that list with a STRICT zod
 * union, so a near-miss is not tolerated the way a loose config would be:
 *
 * - the stdio variant has NO `type` key at all (it is the union's default
 *   branch, keyed by `command`); sending `type: "stdio"` fails `.strict()`.
 * - `headers` on the http/sse variants is an ARRAY of `{ name, value }` pairs,
 *   not a record.
 *
 * Spreading ADE's own shape produced both errors at once, and the failure mode
 * is that session initialization rejects and the chat never starts.
 */
export type DroidMcpServerConfig =
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  | {
    type: "http" | "sse";
    name: string;
    url: string;
    headers?: Array<{ name: string; value: string }>;
  };

export function callerMcpServersToDroidList(
  servers: CallerMcpServers,
): DroidMcpServerConfig[] {
  return Object.entries(servers).map(([name, config]) => {
    if (config.type === "stdio") {
      return {
        name,
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
      };
    }
    const headers = config.headers
      ? Object.entries(config.headers).map(([key, value]) => ({ name: key, value }))
      : null;
    return {
      type: config.type,
      name,
      url: config.url,
      ...(headers?.length ? { headers } : {}),
    };
  });
}
