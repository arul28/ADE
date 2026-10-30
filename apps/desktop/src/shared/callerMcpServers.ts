import type {
  AgentChatMcpCapability,
  AgentChatMcpServerConfig,
  AgentChatProvider,
} from "./types/chat";
import type { ShippedProvider } from "./providers";
import { claudeMcpToolName } from "./mcpApp";

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
 * `CALLER_MCP_SUPPORT`'s strict-mode fields answer one question per provider:
 * can an embedder be promised a clean MCP surface, and what still gets through
 * when the answer is "best-effort".
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
  /**
   * Which per-server tool filters (`allowedTools` / `disallowedTools`) this
   * provider can enforce, and how. A filter the provider cannot enforce is
   * refused at create/update (`callerMcpDeliveryProblem`), never dropped: an
   * embedder that hid a destructive tool and got it back anyway is worse off
   * than one told no. Absent means neither is supported.
   */
  toolFilters?: { allowedTools: boolean; disallowedTools: boolean; mechanism: string };
};

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
 * (`packages/sdk/src/clientOptions.ts`, `ThreadOpenOptions.loadUserMcpServers`) and
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
    // `disallowedTools` removes a tool from the model's context. There is no
    // matching "only these" switch for one server: hiding every tool not
    // named needs the server's tool list, which ADE does not have at launch.
    toolFilters: {
      allowedTools: false,
      disallowedTools: true,
      mechanism: "Agent SDK option disallowedTools: mcp__<server>__<tool>",
    },
  },
  codex: {
    level: "best-effort",
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
    toolFilters: {
      allowedTools: true,
      disallowedTools: true,
      mechanism: "thread config overlay: mcp_servers.<name>.enabled_tools / disabled_tools",
    },
  },
  cursor: {
    level: "best-effort",
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
    mechanism: "session-scoped toggleMcpTool over the live MCP tool list",
    residual:
      "Droid has no config-level MCP switch, so ADE disables non-ADE MCP tools per session after "
      + "the server list is live. A server whose tools appear only after the first disable pass is "
      + "not covered until the next turn.",
    delivery: "session mcpServers list supplied at session initialization",
  },
  opencode: {
    level: "best-effort",
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
  muse: {
    level: "best-effort",
    mechanism: "none — MSP adds per-session servers but has no switch to drop the user's own",
    residual:
      "Muse merges session/start `config.mcpServers` with the servers in ~/.config/muse and a "
      + "trusted workspace's `.mcp.json`. There is no per-session switch to turn those off, so "
      + "strict mode cannot remove them.",
    delivery: "MSP session/start `config.mcpServers` (granted `sessionMcp` capability)",
    // SessionMcpServerConfig has exactly `stdio` and `streamableHttp`.
    unsupportedTransports: ["sse"],
  },
} as const satisfies Record<ShippedProvider, CallerMcpSupport>;

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
  return CALLER_MCP_SUPPORT[provider as ShippedProvider];
}

/**
 * Providers that get the MCP registry's servers although an embedder cannot
 * hand them servers of its own (their row above stays `unsupported`).
 *
 * Pi: the chat worker registers the registry's servers in Pi's own MCP support
 * (`pi.registerMcpServer`). Pi has no legacy SSE client. Opening Pi to
 * caller-injected servers and strict mode is a separate SDK contract change
 * (the SDK fixture pins Pi's verdict), so it is not made here.
 */
const REGISTRY_ONLY_MCP_SUPPORT: Readonly<Record<string, { unsupportedTransports: readonly AgentChatMcpServerConfig["type"][] }>> = {
  pi: { unsupportedTransports: ["sse"] },
  // Kimi: ACP `session/new` `mcpServers` (stdio, HTTP and SSE, all advertised
  // in its `initialize`). The servers in Kimi's own config also load, and a
  // same-named one there wins (`providerOwnMcpServerNames`).
  kimi: { unsupportedTransports: [] },
  // Copilot: the SDK session's `mcpServers` (stdio, HTTP and SSE). The servers
  // in Copilot's own `mcp-config.json` and the workspace `.mcp.json` also load.
  copilot: { unsupportedTransports: [] },
};

/** Every provider the registry can reach: the caller-MCP table plus the registry-only rows. */
export const REGISTRY_MCP_PROVIDER_IDS: readonly string[] = [
  ...Object.keys(CALLER_MCP_SUPPORT),
  ...Object.keys(REGISTRY_ONLY_MCP_SUPPORT).filter((id) => !Object.prototype.hasOwnProperty.call(CALLER_MCP_SUPPORT, id)),
];

/**
 * Whether a provider gets the MCP registry's servers, and which transports it
 * cannot take; null when it gets none. The launch path and Settings › MCP
 * servers › Who gets them both read this.
 */
export function registryMcpSupport(
  provider: AgentChatProvider | string,
): { unsupportedTransports: readonly AgentChatMcpServerConfig["type"][] } | null {
  if (Object.prototype.hasOwnProperty.call(REGISTRY_ONLY_MCP_SUPPORT, provider)) {
    return REGISTRY_ONLY_MCP_SUPPORT[provider]!;
  }
  const support = callerMcpSupport(provider);
  if (!support || support.level === "unsupported") return null;
  return { unsupportedTransports: support.unsupportedTransports ?? [] };
}

/**
 * Providers that can receive caller-injected MCP servers, in table order. The
 * refusal message names these rather than a hand-written list, so adding a
 * provider to the table is the only edit adding it needs.
 */
export const CALLER_MCP_CAPABLE_PROVIDERS: readonly ShippedProvider[] =
  (Object.keys(CALLER_MCP_SUPPORT) as ShippedProvider[])
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
 * Why `servers` cannot be delivered to `provider`, or null when they can (or
 * when there are none). The one check create, a model switch, and
 * `updateSession({ mcpServers })` all run — each wraps it in its own message,
 * because each caller did something different to reach it.
 *
 * `provider`: the provider has no MCP surface; `mechanism` is its table text
 * (null for a provider missing from the table). `transport`: the provider
 * accepts servers but has no client for the transport the named ones speak.
 * `toolFilter`: the named servers carry a tool filter (`allowedTools` or
 * `disallowedTools`) this provider cannot enforce.
 */
export type CallerMcpDeliveryProblem =
  | { kind: "provider"; mechanism: string | null }
  | { kind: "transport"; transport: string; names: string[] }
  | { kind: "toolFilter"; filter: "allowedTools" | "disallowedTools"; names: string[] };

export function callerMcpDeliveryProblem(
  provider: AgentChatProvider | string,
  servers: CallerMcpServers | null | undefined,
): CallerMcpDeliveryProblem | null {
  if (!servers) return null;
  if (!providerAcceptsCallerMcpServers(provider)) {
    return { kind: "provider", mechanism: callerMcpSupport(provider)?.mechanism ?? null };
  }
  const unsupported = callerMcpUnsupportedTransport(provider, servers);
  if (unsupported) return { kind: "transport", ...unsupported };
  return callerMcpUnsupportedToolFilter(provider, servers);
}

/** The caller servers whose tool filter this provider cannot enforce, or null. */
function callerMcpUnsupportedToolFilter(
  provider: AgentChatProvider | string,
  servers: CallerMcpServers,
): CallerMcpDeliveryProblem | null {
  const support = callerMcpSupport(provider)?.toolFilters;
  for (const filter of ["allowedTools", "disallowedTools"] as const) {
    if (support?.[filter]) continue;
    const names = Object.entries(servers)
      .filter(([, config]) => (config[filter]?.length ?? 0) > 0)
      .map(([name]) => name);
    if (names.length) return { kind: "toolFilter", filter, names };
  }
  return null;
}

/**
 * The one sentence for a delivery problem, so create, update and a model
 * switch name the gap the same way. Each caller adds its own prefix and
 * advice around it.
 */
export function describeCallerMcpDeliveryProblem(
  provider: AgentChatProvider | string,
  problem: CallerMcpDeliveryProblem,
): string {
  switch (problem.kind) {
    case "provider":
      return `provider '${provider}' cannot accept injected MCP servers: ${problem.mechanism ?? "no MCP support"}.`;
    case "transport":
      return `provider '${provider}' has no '${problem.transport}' MCP transport, so `
        + `${problem.names.map((name) => `'${name}'`).join(", ")} cannot be delivered.`;
    case "toolFilter": {
      const servers = problem.names.map((name) => `'${name}'`).join(", ");
      const supported = CALLER_MCP_CAPABLE_PROVIDERS.filter((name) => callerMcpSupport(name)?.toolFilters?.[problem.filter]);
      const hint = problem.filter === "allowedTools" && callerMcpSupport(provider)?.toolFilters?.disallowedTools
        ? " List the tools to hide in disallowedTools instead."
        : "";
      return `provider '${provider}' cannot enforce ${problem.filter} on MCP ${problem.names.length > 1 ? "servers" : "server"} `
        + `${servers}.${hint} Providers that can: ${supported.length ? supported.join(", ") : "none"}.`;
    }
    default: {
      const unhandled: never = problem;
      return String(unhandled);
    }
  }
}

/** Whether any server carries an `allowedTools` or `disallowedTools` filter. */
export function callerMcpServersHaveToolFilters(servers: CallerMcpServers | null | undefined): boolean {
  return Object.values(servers ?? {}).some(
    (config) => (config.allowedTools?.length ?? 0) > 0 || (config.disallowedTools?.length ?? 0) > 0,
  );
}

/**
 * The capability report a session carries, or null when it should carry none.
 *
 * The gate is "servers, or strict explicitly requested": an explicit
 * `strictMcpConfig: false` with no servers emits NO report, because an absent
 * report is how every consumer tells "no MCP was requested" from "here is what
 * ADE did with your request".
 */
export function callerMcpCapabilityFor(
  provider: AgentChatProvider | string,
  { servers, strict }: { servers: CallerMcpServers | null | undefined; strict: boolean | null | undefined },
): AgentChatMcpCapability | null {
  if (!servers && strict !== true) return null;
  return resolveCallerMcpCapability(provider, {
    hasServers: servers != null,
    strictRequested: strict === true,
    hasToolFilters: callerMcpServersHaveToolFilters(servers),
  });
}

/**
 * The transcript warning for servers restored without the header values the
 * host once gave them, or null when nothing was withheld. `key` identifies the
 * withheld set, so a caller can warn once per set rather than once per launch.
 * The fix is the host's: send the servers again with
 * `updateSession({ mcpServers })`.
 */
export function callerMcpMissingHeadersNotice(
  servers: CallerMcpServers | null | undefined,
): { key: string; message: string } | null {
  const missing = callerMcpServersMissingHeaders(servers);
  if (!missing.length) return null;
  return {
    key: missing.join("\u0000"),
    message:
      `MCP ${missing.length > 1 ? "servers" : "server"} ${missing.map((name) => `'${name}'`).join(", ")} `
      + "restarted without the headers the host supplied, because ADE does not store header values. "
      + "The host must send the servers again (updateSession with mcpServers) before tools that need "
      + "those credentials will work.",
  };
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
  {
    hasServers,
    strictRequested,
    hasToolFilters = false,
  }: { hasServers: boolean; strictRequested: boolean; hasToolFilters?: boolean },
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
    // Only reached for a filter the provider can enforce: create and update
    // refuse the others before a report is made.
    ...(hasServers && hasToolFilters && support.toolFilters ? [`tool filters via ${support.toolFilters.mechanism}`] : []),
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
 * Mirrors CTO_MCP_SERVER_NAME in agentChatService.ts and the `computer_use`
 * key in codexComputerUse.ts. Kept
 * here rather than imported because this module is shared and must not pull in
 * the 49k-line service.
 */
export const ADE_RESERVED_MCP_SERVER_NAMES: readonly string[] = [
  "computer_use",
  "ade-cto",
];

// ---------------------------------------------------------------------------
// Codex config.toml MCP enumeration
// ---------------------------------------------------------------------------

/**
 * Extracts the server names declared under Codex's `mcp_servers` config table.
 *
 * Codex has no "managed servers only" switch; the only per-server knob is
 * `mcp_servers.<name>.enabled`, so strict mode is expressed as an explicit
 * `enabled = false` for every configured server. Handles the three
 * shapes `config.toml` can use: `[mcp_servers.name]` headers, dotted
 * `mcp_servers.name.key = …` assignments, and single- or multi-line inline
 * `mcp_servers = { name = { … } }` tables.
 */
export function codexConfiguredMcpServerNames(configText: string): string[] {
  const names: string[] = [];
  const add = (raw: string): void => {
    const name = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!name || names.includes(name)) return;
    names.push(name);
  };
  const firstSegment = (path: string): string | null => {
    const trimmed = path.trim();
    if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
      const quote = trimmed[0]!;
      const end = trimmed.indexOf(quote, 1);
      return end > 0 ? trimmed.slice(1, end) : null;
    }
    const segment = trimmed.split(".")[0]?.trim() ?? "";
    return segment.length ? segment : null;
  };

  const normalizedConfig = configText.replace(/\r\n?/g, "\n");
  const inlineAssignment = /^\s*mcp_servers\s*=\s*\{/gm;
  let inBareMcpServersTable = false;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineAssignment.exec(normalizedConfig)) !== null) {
    const openBrace = normalizedConfig.indexOf("{", inlineMatch.index);
    const closeBrace = findTomlInlineTableEnd(normalizedConfig, openBrace);
    if (openBrace < 0 || closeBrace < 0) continue;
    for (const key of inlineTableKeys(stripTomlComments(
      normalizedConfig.slice(openBrace + 1, closeBrace),
    ))) add(key);
    inlineAssignment.lastIndex = closeBrace + 1;
  }

  for (const line of normalizedConfig.split("\n")) {
    const withoutComment = stripTomlComments(line).trim();
    if (!withoutComment.length) continue;

    const tableHeader = withoutComment.match(/^\[\[?\s*(.*?)\s*\]\]?$/)?.[1]?.trim();
    if (tableHeader !== undefined) {
      if (tableHeader === "mcp_servers") {
        inBareMcpServersTable = true;
        continue;
      }

      const header = tableHeader.match(/^mcp_servers\s*\.\s*(.+)$/)?.[1];
      if (header) {
        const segment = firstSegment(header);
        if (segment) add(segment);
        inBareMcpServersTable = false;
        continue;
      }

      inBareMcpServersTable = false;
      continue;
    }

    if (inBareMcpServersTable) {
      const bareAssignment = withoutComment.match(
        /^((?:"[^"]+"|'[^']+'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9_-]+))*)\s*=/,
      )?.[1];
      if (bareAssignment) {
        const segment = firstSegment(bareAssignment);
        if (segment) add(segment);
        continue;
      }
    }

    const dotted = withoutComment.match(/^mcp_servers\s*\.\s*(.+?)\s*=/)?.[1];
    if (dotted) {
      const segment = firstSegment(dotted);
      if (segment) add(segment);
      continue;
    }

    const inline = withoutComment.match(/^mcp_servers\s*=\s*\{(.*)\}\s*$/)?.[1];
    if (inline !== undefined) {
      for (const key of inlineTableKeys(stripTomlComments(inline))) add(key);
    }
  }
  return names;
}

function stripTomlComments(text: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      output += char;
      if (quote === '"' && char === "\\") {
        const next = text[index + 1];
        if (next !== undefined) output += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      if (index < text.length) output += "\n";
    } else {
      output += char;
    }
  }
  return output;
}

function findTomlInlineTableEnd(text: string, openBrace: number): number {
  if (openBrace < 0) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = openBrace; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Top-level `key =` names of a single-line TOML inline table body. */
function inlineTableKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      if (char === quote && body[index - 1] !== "\\") quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{" || char === "[") { depth += 1; continue; }
    if (char === "}" || char === "]") { depth -= 1; continue; }
    if (depth === 0 && char === "=") {
      const key = token.trim();
      if (key.length) keys.push(key);
      token = "";
      // Skip the value until the next top-level comma.
      let valueDepth = 0;
      let valueQuote: string | null = null;
      index += 1;
      for (; index < body.length; index += 1) {
        const valueChar = body[index]!;
        if (valueQuote) {
          if (valueChar === valueQuote && body[index - 1] !== "\\") valueQuote = null;
          continue;
        }
        if (valueChar === "\"" || valueChar === "'") { valueQuote = valueChar; continue; }
        if (valueChar === "{" || valueChar === "[") { valueDepth += 1; continue; }
        if (valueChar === "}" || valueChar === "]") { valueDepth -= 1; continue; }
        if (valueChar === "," && valueDepth === 0) break;
      }
      continue;
    }
    if (depth === 0) token += char;
  }
  return keys;
}

/**
 * The `mcp_servers` overlay a strict-MCP Codex thread config carries: every
 * user-configured server explicitly switched off.
 */
export function codexDisabledMcpServerOverrides(
  configuredServerNames: readonly string[],
): Record<string, { enabled: false }> {
  const overrides: Record<string, { enabled: false }> = {};
  for (const name of configuredServerNames) {
    const trimmed = name.trim();
    if (trimmed.length) overrides[trimmed] = { enabled: false };
  }
  return overrides;
}

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

function normalizeHeaderNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || out.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  return out.length ? out : null;
}

/** Ceiling on one server's tool filter list. */
export const MAX_CALLER_MCP_TOOL_FILTER_ENTRIES = 256;
const TOOL_NAME_MAX_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * One tool filter list: bare tool names, trimmed, deduplicated (tool names
 * are case-sensitive, so `Search` and `search` are two tools). Absent input
 * reads as no filter; anything else that is not a list of names is a problem.
 * An empty `allowedTools` is refused rather than read as "allow nothing": a
 * server whose every tool is hidden should not be injected at all, and an
 * empty list built by mistake would otherwise silently blank it.
 */
function readToolFilter(
  serverName: string,
  field: "allowedTools" | "disallowedTools",
  value: unknown,
): { ok: true; names: string[] | null } | { ok: false; problem: string } {
  if (value === undefined || value === null) return { ok: true, names: null };
  if (!Array.isArray(value)) {
    return { ok: false, problem: `server '${serverName}' has ${field} that is not an array of tool names` };
  }
  if (value.length > MAX_CALLER_MCP_TOOL_FILTER_ENTRIES) {
    return {
      ok: false,
      problem: `server '${serverName}' lists ${value.length} ${field}, more than ${MAX_CALLER_MCP_TOOL_FILTER_ENTRIES}`,
    };
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (!name || name.length > TOOL_NAME_MAX_LENGTH || CONTROL_CHARACTER.test(name)) {
      return {
        ok: false,
        problem: `server '${serverName}' has ${field} entries that are not tool names `
          + `(1-${TOOL_NAME_MAX_LENGTH} characters, no control characters)`,
      };
    }
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length && field === "allowedTools") {
    return {
      ok: false,
      problem: `server '${serverName}' has an empty allowedTools; leave the server out instead of allowing none of its tools`,
    };
  }
  return { ok: true, names: names.length ? names : null };
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
  const allowed = readToolFilter(name, "allowedTools", record.allowedTools);
  if (!allowed.ok) return allowed;
  const disallowed = readToolFilter(name, "disallowedTools", record.disallowedTools);
  if (!disallowed.ok) return disallowed;
  // Tool names are not credentials, so they are kept everywhere the server
  // is: the durable record, the summary, the SDK's thread store.
  const toolFilter = {
    ...(allowed.names ? { allowedTools: allowed.names } : {}),
    ...(disallowed.names ? { disallowedTools: disallowed.names } : {}),
  };
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (type === "http" || type === "sse") {
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) return { ok: false, problem: `server '${name}' is type '${type}' and needs a url` };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        ok: false,
        // A malformed URL can still carry a token in its query string.
        problem: `server '${name}' has a url that is not a valid absolute URL: ${redactUrl(url)}`,
      };
    }
    // Scheme allow-list, not a block-list. `file:` would read local paths and a
    // custom scheme would be handed to whatever the provider's client does with
    // it; only the two transports MCP actually defines over HTTP are accepted.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, problem: `server '${name}' must use http: or https:, got ${parsed.protocol}` };
    }
    const headers = normalizeStringRecord(record.headers);
    // Names only survive when there are no values: with values present the
    // names are their keys, and a second list could only disagree with them.
    const headerNames = headers ? null : normalizeHeaderNames(record.headerNames);
    return {
      ok: true,
      config: {
        type,
        url,
        ...(headers ? { headers } : {}),
        ...(headerNames ? { headerNames } : {}),
        ...toolFilter,
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
        ...toolFilter,
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
    // Codex's own per-server filters: `enabled_tools` is the allow list and
    // `disabled_tools` is applied after it, so a tool in both stays off.
    const toolFilter = {
      ...(config.allowedTools?.length ? { enabled_tools: config.allowedTools } : {}),
      ...(config.disallowedTools?.length ? { disabled_tools: config.disallowedTools } : {}),
    };
    out[name] = config.type === "stdio"
      ? {
        command: config.command,
        ...(config.args?.length ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...toolFilter,
        enabled: true,
      }
      : {
        url: config.url,
        ...(config.headers ? { http_headers: config.headers } : {}),
        ...toolFilter,
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
  const out: Record<string, AgentChatMcpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    // `headerNames` is ADE's own bookkeeping for withheld credentials, and the
    // tool filters are applied by the adapter (Claude's `disallowedTools`,
    // see `callerMcpClaudeDisallowedTools`); neither is a transport field, and
    // a provider schema that validates strictly would reject them.
    const { allowedTools: _allowed, disallowedTools: _disallowed, ...rest } = config;
    if (rest.type === "stdio" || rest.headerNames === undefined) {
      out[name] = rest;
      continue;
    }
    const { headerNames: _headerNames, ...transport } = rest;
    out[name] = transport;
  }
  return out;
}

/**
 * The Claude `disallowedTools` entries for the caller servers' deny lists:
 * `mcp__<server>__<tool>`, the name Claude Code gives an MCP tool. The Agent
 * SDK removes each from the model's context. `allowedTools` has no Claude
 * form and is refused before launch (`CALLER_MCP_SUPPORT.claude.toolFilters`).
 */
export function callerMcpClaudeDisallowedTools(servers: CallerMcpServers | null | undefined): string[] {
  const out: string[] = [];
  for (const [name, config] of Object.entries(servers ?? {})) {
    for (const tool of config.disallowedTools ?? []) {
      const entry = claudeMcpToolName(name, tool);
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

/**
 * OpenCode 2.0 config shape (`mcp.servers.<name>`): an HTTP/SSE server is
 * "remote", a stdio server is "local" with `command` as a single argv array.
 */
export type OpenCodeMcpServerConfig =
  | { type: "local"; command: string[]; environment?: Record<string, string>; disabled: false; codemode?: boolean }
  | { type: "remote"; url: string; headers?: Record<string, string>; disabled: false; codemode?: boolean };

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
        disabled: false,
      }
      : {
        type: "remote",
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        disabled: false,
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

// ---------------------------------------------------------------------------
// Credentials: header values stay in memory, never on disk or in error text
// ---------------------------------------------------------------------------

/**
 * The servers as ADE may write them down: every header VALUE dropped, the
 * header names kept in `headerNames`.
 *
 * Used for the durable chat record and for any summary that leaves the
 * process, because an MCP header is almost always a credential. A value
 * replaced by a placeholder would be worse than one dropped: the placeholder
 * would be sent to the server as if it were the token. Stdio servers are
 * returned unchanged — their `env` is launch configuration the provider needs
 * to start the process at all after a restart.
 *
 * Twin: `toStoredMcpServers` in packages/sdk/src/mcpHeaders.ts, the SDK's
 * copy for the host side. Change the two together.
 */
export function withholdCallerMcpHeaderValues(servers: CallerMcpServers): CallerMcpServers {
  const out: CallerMcpServers = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.type === "stdio" || !config.headers) {
      out[name] = config;
      continue;
    }
    const { headers, headerNames: _existing, ...rest } = config;
    // Deduped case-insensitively on write, like the SDK twin, so the stored
    // bytes agree and not only the values read back.
    const headerNames = normalizeHeaderNames(Object.keys(headers)) ?? [];
    out[name] = headerNames.length ? { ...rest, headerNames } : rest;
  }
  return out;
}

/**
 * Servers restored without the header values the host once gave them — the
 * ones a provider will now dial with no credentials until the host sends the
 * servers again. Empty when nothing was withheld.
 */
function callerMcpServersMissingHeaders(servers: CallerMcpServers | null | undefined): string[] {
  if (!servers) return [];
  return Object.entries(servers)
    .filter(([, config]) => config.type !== "stdio" && !config.headers && (config.headerNames?.length ?? 0) > 0)
    .map(([name]) => name);
}

/**
 * `scheme://host[:port]/path` with any userinfo, query string, and fragment
 * replaced. Text that does not parse as a URL keeps everything before its first
 * `?`.
 */
function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a URL, so the parser cannot find the secrets; cut them by hand,
    // since a malformed URL can still carry a token in its userinfo, query
    // string or fragment.
    return raw
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1<redacted>@")
      .replace(/\?[^#]*/, "?<redacted>")
      .replace(/#.*$/s, "#<redacted>");
  }
  const hadUserinfo = parsed.username.length > 0 || parsed.password.length > 0;
  const hadQuery = parsed.search.length > 0;
  const hadHash = parsed.hash.length > 0;
  if (!hadUserinfo && !hadQuery && !hadHash) return raw;
  return `${parsed.protocol}//${hadUserinfo ? "<redacted>@" : ""}${parsed.host}${parsed.pathname}`
    + `${hadQuery ? "?<redacted>" : ""}${hadHash ? "#<redacted>" : ""}`;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`)\]]+/gi;
const BEARER_IN_TEXT = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Scrub MCP credentials out of text ADE is about to show or record: an error
 * message, a notice, a provider's startup-failure line.
 *
 * Every URL loses its query string, fragment, and userinfo (a token in
 * `?key=` is as common as one in a header); every `Bearer …` credential loses
 * its value; and every header value of `servers`
 * is replaced wherever it appears verbatim, which catches a token a provider
 * echoed in some other shape. Values shorter than four characters are left
 * alone — replacing every "1" in a message would destroy it and protect
 * nothing.
 */
export function redactCallerMcpText(
  text: string,
  servers?: CallerMcpServers | null,
): string {
  let out = text.replace(URL_IN_TEXT, (match) => redactUrl(match));
  out = out.replace(BEARER_IN_TEXT, (_match, scheme: string) => `${scheme} <redacted>`);
  if (servers) {
    const secrets = new Set<string>();
    for (const config of Object.values(servers)) {
      // A stdio server's secrets ride in its environment, an http one's in
      // its headers; a failing server can echo either back in its error.
      const values = config.type === "stdio" ? config.env : config.headers;
      if (!values) continue;
      for (const value of Object.values(values)) {
        const trimmed = value.trim();
        if (trimmed.length >= 4) secrets.add(trimmed);
        // `Bearer abc…`: the token alone may be echoed without its scheme.
        const token = trimmed.split(/\s+/).at(-1);
        if (token && token.length >= 4) secrets.add(token);
      }
    }
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}
