/**
 * `mcp_registry.*` on one runtime: an agent reads the person's MCP setup, and
 * proposes a server that the person approves in the agent's own chat.
 *
 * Runs on the machine that runs the chat. The registry list is the account
 * settings row every machine shares (`mcp.servers`), read and written through
 * this runtime's account settings store, the same store the desktop's
 * Settings › Connections › MCP servers writes through. Secret values go to the account vault
 * through {@link createMcpRegistryService}'s own `setSecret` / `importServer`
 * / `pruneSecrets`, the calls behind that page's IPC handlers. Nothing here
 * returns, logs, or puts a secret value in a card or a transcript.
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { ADE_RESERVED_MCP_SERVER_NAMES } from "../../../shared/callerMcpServers";
import type { ConnectProviderId, IntegrationConnectRequestResult } from "../../../shared/integrationConnect";
import {
  matchMcpCatalogue,
  mcpCatalogueEntry,
  mcpCatalogueSecretValue,
  mcpCatalogueServer,
  type McpCatalogueEntry,
} from "../../../shared/mcpCatalogue";
import {
  MCP_OFF_SETTING_KEY,
  MCP_SECRET_VAULT_KIND,
  MCP_SERVERS_SETTING_KEY,
  addMcpRegistryServer,
  findSameMcpServer,
  isValidMcpFieldName,
  isValidMcpRegistryName,
  mcpRegistryState,
  mcpSecretVaultKey,
  normalizeMcpOffList,
  normalizeMcpRegistry,
  normalizeMcpRegistryServer,
  type McpRegistryServer,
  type McpSecretField,
} from "../../../shared/mcpRegistry";
import {
  MCP_SERVER_APPROVE_QUESTION_ID,
  MCP_SERVER_APPROVE_VALUE,
  MCP_SERVER_DECLINE_VALUE,
  MCP_SERVER_REQUEST_METADATA_KEY,
  MCP_SERVER_REQUEST_REASON_MAX_CHARS,
  mcpServerRunsLine,
  mcpServerSecretQuestionId,
  type McpRegistryListing,
  type McpServerRequestCard,
  type McpServerRequestResult,
  type McpServerRequestSecret,
  type McpServerRequestSource,
} from "../../../shared/mcpServerRequest";
import type { AccountVaultItem, AccountVaultWriteOptions } from "../../../shared/types/accountVault";
import type { McpConfigProvider } from "../../../shared/types/mcpRegistry";
import type { createMcpRegistryService, McpRegistryVault } from "./mcpRegistryService";
import type { ProviderMcpScan } from "./mcpProviderConfigScan";

/** Long enough to go make a token in another tab, not forever. */
export const MCP_SERVER_REQUEST_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const MCP_SERVER_REQUEST_MAX_TIMEOUT_MS = 2 * 60 * 60_000;

/** What the agent is told once the server is in. */
export const MCP_SERVER_ADDED_NEXT = "Added. Ask the person to press Refresh chat to load its tools.";

type RequestChatInput = (args: {
  chatSessionId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  allowsFreeform?: boolean;
  providerMetadata?: Record<string, unknown>;
  eventDescription?: string;
  questions?: Array<{
    id?: string;
    header?: string;
    question: string;
    options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
    allowsFreeform?: boolean;
    isSecret?: boolean;
  }>;
  beforeAccept?: (answers: Record<string, string[]>) => void | Promise<void>;
}) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null; timedOut?: boolean }>;

/** The account settings calls this module makes. A runtime's `accountSettingsStore` satisfies it. */
export type McpRegistrySettingsStore = {
  get(scope: string, key: string): unknown;
  set(scope: string, key: string, value: unknown): boolean;
};

/** The account vault calls this module makes. A runtime's `accountVaultStore` satisfies it. */
export type McpRegistryVaultStore = {
  list(scope?: string): Array<{ scope: string; kind: string; key: string; updatedAt: string; refreshOwner: string | null; deleted?: boolean }>;
  get(scope: string, kind: string, key: string): string | null;
  set(scope: string, kind: string, key: string, value: string, options?: AccountVaultWriteOptions): boolean;
  remove(scope: string, kind: string, key: string): boolean;
};

const VAULT_UNAVAILABLE = "This machine has no account vault (it is not signed in to ADE, or sync is off), so it cannot hold MCP server values.";
const VAULT_REJECTED = "The account vault did not take the change.";

/** The registry service's vault, over a runtime's synchronous account vault store. */
export function mcpRegistryVaultFromStore(getStore: () => McpRegistryVaultStore | null | undefined): McpRegistryVault {
  const unavailable = () => ({ ok: false as const, unavailable: true as const, message: VAULT_UNAVAILABLE });
  const rejected = () => ({ ok: false as const, rejected: true as const, message: VAULT_REJECTED });
  return {
    async list(scope) {
      const store = getStore();
      if (!store) return unavailable();
      return {
        ok: true,
        value: store.list(scope ?? undefined).map((item): AccountVaultItem => ({
          scope: item.scope,
          kind: item.kind,
          key: item.key,
          value: null,
          updatedAt: item.updatedAt,
          refreshOwner: item.refreshOwner,
          ...(item.deleted === true ? { deleted: true } : {}),
        })),
      };
    },
    async get(scope, kind, key) {
      const store = getStore();
      return store ? { ok: true, value: store.get(scope, kind, key) } : unavailable();
    },
    async set(scope, kind, key, value, options) {
      const store = getStore();
      if (!store) return unavailable();
      return store.set(scope, kind, key, value, options) ? { ok: true, value: null } : rejected();
    },
    async remove(scope, kind, key) {
      const store = getStore();
      if (!store) return unavailable();
      return store.remove(scope, kind, key) ? { ok: true, value: null } : rejected();
    },
  };
}

type McpRegistryService = ReturnType<typeof createMcpRegistryService>;

export type McpServerRequestDeps = {
  /** Null on a runtime with no account (signed out, or sync off). */
  settings: McpRegistrySettingsStore | null;
  vault: McpRegistryVaultStore | null;
  registry: Pick<McpRegistryService, "context" | "setSecret" | "pruneSecrets" | "importServer">;
  /** The other tools' configs on this machine, values included (they never leave this process). */
  scanConfigs: (projectRoot: string | null) => ProviderMcpScan;
  projectRoot: string | null;
};

function readArgs(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function firstAnswer(answers: Record<string, string[]>, id: string): string {
  return answers[id]?.[0] ?? "";
}

/** The registry list and both off lists, as this machine's account store holds them now. */
function readRegistry(deps: McpServerRequestDeps): {
  servers: McpRegistryServer[];
  off: { machine: string[]; project: string[] };
  live: boolean;
} {
  const context = deps.registry.context(deps.projectRoot);
  if (!deps.settings) {
    return {
      servers: context.cached?.servers ?? [],
      off: context.cached?.off ?? { machine: [], project: [] },
      live: false,
    };
  }
  return {
    servers: normalizeMcpRegistry(deps.settings.get(ACCOUNT_SCOPE_ALL, MCP_SERVERS_SETTING_KEY)),
    off: {
      machine: context.deviceOffKey ? normalizeMcpOffList(deps.settings.get(ACCOUNT_SCOPE_ALL, context.deviceOffKey)) : [],
      project: context.repoScope ? normalizeMcpOffList(deps.settings.get(context.repoScope, MCP_OFF_SETTING_KEY)) : [],
    },
    live: true,
  };
}

function secretIsSet(deps: McpServerRequestDeps, server: string, field: McpSecretField, name: string): boolean {
  const value = deps.vault?.get(ACCOUNT_SCOPE_ALL, MCP_SECRET_VAULT_KIND, mcpSecretVaultKey(server, field, name));
  return typeof value === "string" && value.length > 0;
}

/**
 * `mcp_registry.list`: every registry server with where it is on, and
 * whether each of its values is set here; plus the servers other tools'
 * configs on this machine have that the registry does not. Never a value.
 */
export function listMcpRegistry(deps: McpServerRequestDeps): McpRegistryListing {
  const { servers, off, live } = readRegistry(deps);
  const scan = deps.scanConfigs(deps.projectRoot);
  const known = new Set(servers.map((server) => server.name));
  return {
    servers: servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: [...server.args] } : {}),
      ...(server.url ? { url: server.url } : {}),
      runs: mcpServerRunsLine(server),
      enabled: server.enabled,
      offOnThisMachine: off.machine.includes(server.name),
      offInThisProject: off.project.includes(server.name),
      state: mcpRegistryState(server, off),
      secrets: [
        ...server.envNames.map((name) => ({ field: "env" as const, name, set: secretIsSet(deps, server.name, "env", name) })),
        ...server.headerNames.map((name) => ({ field: "header" as const, name, set: secretIsSet(deps, server.name, "header", name) })),
      ],
    })),
    found: scan.servers
      .filter((server) => !known.has(server.name))
      .map((server) => ({
        name: server.name,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.args?.length ? { args: [...server.args] } : {}),
        ...(server.url ? { url: server.url } : {}),
        envNames: Object.keys(server.env),
        headerNames: Object.keys(server.headers),
        providers: [...server.providers],
      })),
    skipped: [...scan.skipped],
    notice: live
      ? null
      : "This machine is not signed in to an ADE account, or its sync is off: this is the last list it saved, and it cannot be changed from here.",
  };
}

/** One proposal, checked: what the card shows and what the save writes. */
type Proposal = {
  source: McpServerRequestSource;
  server: McpRegistryServer;
  providers: McpConfigProvider[];
  secrets: McpServerRequestSecret[];
  catalogueId?: string;
};

/** `integration_connect.request`, for a catalogue name that is an ADE integration. */
export type ConnectIntegration = (args: Record<string, unknown>) => Promise<IntegrationConnectRequestResult>;

function stringList(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be a list of strings.`);
  }
  return value as string[];
}

function fieldNameList(value: unknown, label: string): string[] {
  const names = stringList(value, label).map((name) => name.trim()).filter(Boolean);
  const bad = names.find((name) => !isValidMcpFieldName(name));
  if (bad) throw new Error(`"${bad}" is not a name ADE can store a value under (letters, digits, _ and - only).`);
  return [...new Set(names)];
}

function secretsFor(server: McpRegistryServer, copied: (field: McpSecretField, name: string) => boolean): McpServerRequestSecret[] {
  return [
    ...server.envNames.map((name) => ({ field: "env" as const, name })),
    ...server.headerNames.map((name) => ({ field: "header" as const, name })),
  ].map((entry) => ({ ...entry, questionId: mcpServerSecretQuestionId(entry.field, entry.name), copied: copied(entry.field, entry.name) }));
}

function proposeCatalogue(entry: McpCatalogueEntry): Proposal {
  const server = mcpCatalogueServer(entry);
  return { source: "catalog", server, providers: [], secrets: secretsFor(server, () => false), catalogueId: entry.id };
}

async function connectNative(
  deps: McpServerRequestDeps & { connectIntegration?: ConnectIntegration },
  args: Record<string, unknown>,
  name: string,
  provider: ConnectProviderId,
): Promise<McpServerRequestResult> {
  if (!deps.connectIntegration) {
    throw new Error(`${provider} is built into ADE. Run \`ade integrations connect ${provider} --reason "…"\` instead.`);
  }
  const result = await deps.connectIntegration({
    chatSessionId: args.chatSessionId,
    provider,
    reason: args.reason,
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
  });
  return result.connected
    ? { name, added: false, integration: provider, connected: true, next: `${provider} is built into ADE, so it is connected as an integration, not an MCP server. ${result.next}` }
    : { name, added: false, integration: provider, connected: false, next: `The user declined to connect ${provider}.` };
}

function proposeImported(deps: McpServerRequestDeps, name: string): Proposal {
  const found = deps.scanConfigs(deps.projectRoot).servers.find((server) => server.name === name);
  if (!found) {
    throw new Error(`No other tool on this machine has an MCP server named "${name}". Run \`ade mcp servers\` to see the ones it found, or describe the server yourself (--command or --url).`);
  }
  const server = normalizeMcpRegistryServer({
    ...found,
    envNames: Object.keys(found.env),
    headerNames: Object.keys(found.headers),
    enabled: true,
  });
  if (!server) throw new Error(`ADE cannot hold the server "${name}" as the other tool defines it.`);
  return {
    source: "imported",
    server,
    providers: [...found.providers],
    secrets: secretsFor(server, (field, fieldName) => (field === "env" ? found.env[fieldName] : found.headers[fieldName])?.length ? true : false),
  };
}

function proposeAgent(args: Record<string, unknown>, name: string): Proposal {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (command && url) throw new Error("Give either a command (a local server) or a URL (a remote one), not both.");
  const transportArg = typeof args.transport === "string" ? args.transport.trim().toLowerCase() : "";
  const transport = transportArg || (url ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error(`Unknown transport "${transportArg}". Use stdio (a command), http, or sse.`);
  }
  const envNames = fieldNameList(args.envNames, "envNames");
  const headerNames = fieldNameList(args.headerNames, "headerNames");
  if (transport === "stdio") {
    if (!command) throw new Error("A local (stdio) server needs the command to run (--command, or the command line after --).");
    if (headerNames.length) throw new Error("Headers belong to an http or sse server. A local server reads env variables (--env).");
  } else {
    if (!/^https?:\/\//i.test(url)) throw new Error("A remote server needs its URL, starting with https:// (--url).");
    if (envNames.length) throw new Error("Env variables belong to a local server. A remote server sends headers (--header).");
  }
  const server = normalizeMcpRegistryServer({
    name,
    transport,
    ...(transport === "stdio" ? { command, args: stringList(args.args, "args") } : { url }),
    envNames,
    headerNames,
    enabled: true,
  });
  if (!server) throw new Error("ADE cannot save that server. Check its name, and its command or URL.");
  return { source: "agent", server, providers: [], secrets: secretsFor(server, () => false) };
}

function already(match: NonNullable<ReturnType<typeof findSameMcpServer>>, name: string): McpServerRequestResult {
  const how = match.by === "name" ? "under that name" : match.by === "url" ? "at that URL" : "with that command";
  return {
    name,
    added: false,
    already: true,
    existing: match.server.name,
    matchedBy: match.by,
    next: match.server.name === name
      ? `The person already has ${name} in ADE. No card was raised.`
      : `The person already has this server in ADE ${how}, as ${match.server.name}. No card was raised.`,
  };
}

/** Asks still waiting on the person, by chat and server name: a second ask joins the open card. */
const inFlight = new Map<string, Promise<McpServerRequestResult>>();

/**
 * `mcp_registry.request` — propose adding one MCP server; the person approves
 * it in this chat. Returns at once with `already` when the registry has the
 * same name, URL, or command line. Otherwise blocks until the person adds it,
 * declines, or the wait runs out.
 */
export async function requestMcpServer(
  deps: McpServerRequestDeps & { requestChatInput: RequestChatInput; connectIntegration?: ConnectIntegration },
  rawArgs: unknown,
): Promise<McpServerRequestResult> {
  const args = readArgs(rawArgs);
  const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() : "";
  if (!chatSessionId) {
    throw new Error("Adding an MCP server needs a chat to ask in. Run `ade mcp servers add` from inside an ADE chat.");
  }
  if (!deps.settings || !deps.vault) {
    throw new Error("This machine is not signed in to an ADE account, or its sync is off, so it cannot add MCP servers. The person can add one in Settings › Connections › MCP servers.");
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!isValidMcpRegistryName(name)) {
    throw new Error("Name the server: letters, digits, _ and -, starting with a letter or digit, up to 64 characters.");
  }
  if (ADE_RESERVED_MCP_SERVER_NAMES.includes(name)) throw new Error(`"${name}" is one of ADE's own servers. Pick another name.`);
  const reason = (typeof args.reason === "string" ? args.reason.trim() : "").slice(0, MCP_SERVER_REQUEST_REASON_MAX_CHARS);
  if (!reason) throw new Error("Say why you want the server (--reason). The person decides from that one line.");
  const sourceArg = typeof args.source === "string" ? args.source.trim().toLowerCase() : "";
  if (sourceArg && sourceArg !== "imported" && sourceArg !== "agent" && sourceArg !== "catalog") {
    throw new Error(`Unknown source "${sourceArg}". Use catalog, imported or agent.`);
  }
  const describes = ["command", "url", "transport"].some((key) => typeof args[key] === "string" && (args[key] as string).trim());
  // A bare name is ADE's catalogue entry when there is one, else another
  // tool's server; --import always means the other tool's.
  const entry = mcpCatalogueEntry(name);
  const source: McpServerRequestSource = sourceArg
    ? sourceArg as McpServerRequestSource
    : describes ? "agent" : entry ? "catalog" : "imported";
  if (source === "catalog" && !entry) {
    throw new Error(`ADE's catalogue has no server named "${name}". Run \`ade mcp servers --help\` for its names, or describe the server yourself (--command or --url).`);
  }
  const proposal = source === "catalog" ? proposeCatalogue(entry!)
    : source === "imported" ? proposeImported(deps, name)
      : proposeAgent(args, name);
  // GitHub, Linear and Jira are ADE integrations: one connection covers
  // `ade github`/`ade linear`/`ade jira` and every agent, so the connect card
  // runs instead of adding a second connection as an MCP server.
  const native = (source === "catalog" ? entry : matchMcpCatalogue(proposal.server))?.native;
  if (native) return await connectNative(deps, args, name, native);
  const match = findSameMcpServer(readRegistry(deps).servers, proposal.server);
  if (match) return already(match, name);

  const key = `${chatSessionId}\u0000${name}`;
  const pending = inFlight.get(key);
  if (pending) return await pending;
  const ask = askToAdd(deps, args, chatSessionId, reason, proposal);
  inFlight.set(key, ask);
  try {
    return await ask;
  } finally {
    if (inFlight.get(key) === ask) inFlight.delete(key);
  }
}

async function askToAdd(
  deps: McpServerRequestDeps & { requestChatInput: RequestChatInput },
  args: Record<string, unknown>,
  chatSessionId: string,
  reason: string,
  proposal: Proposal,
): Promise<McpServerRequestResult> {
  const { server } = proposal;
  const requestedTimeout = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.floor(args.timeoutMs)
    : MCP_SERVER_REQUEST_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(requestedTimeout, 10_000), MCP_SERVER_REQUEST_MAX_TIMEOUT_MS);
  const runs = mcpServerRunsLine(server);
  const card: McpServerRequestCard = {
    source: proposal.source,
    reason,
    server,
    runs,
    providers: proposal.providers,
    secrets: proposal.secrets,
    ...(proposal.catalogueId ? { catalogueId: proposal.catalogueId } : {}),
  };
  const catalogue = mcpCatalogueEntry(proposal.catalogueId);
  const asked = proposal.secrets.filter((secret) => !secret.copied);

  // A client that draws the native card reads the metadata; any other client
  // (an older desktop, the phone) still gets working questions: add or not,
  // with what runs, then each value as a password question.
  const questions = [
    {
      id: MCP_SERVER_APPROVE_QUESTION_ID,
      header: server.name,
      question: `Add the MCP server ${server.name}? Runs: ${runs}`,
      allowsFreeform: false,
      options: [
        { label: "Add server", value: MCP_SERVER_APPROVE_VALUE, description: "Saved to your account, on all your machines.", recommended: true },
        { label: "Not now", value: MCP_SERVER_DECLINE_VALUE },
      ],
    },
    ...asked.map((secret) => ({
      id: secret.questionId,
      header: server.name,
      question: `${secret.name} (${secret.field === "env" ? "env variable" : "header"}). Leave empty to add it later in Settings.`,
      allowsFreeform: true,
      isSecret: true,
    })),
  ];

  let outcome: McpServerRequestResult | null = null;
  // The save runs while the answer is accepted, before the card resolves: a
  // value the vault refuses keeps the card open with the reason instead of an
  // "added" receipt for a server that was not.
  const beforeAccept = async (answers: Record<string, string[]>): Promise<void> => {
    if (firstAnswer(answers, MCP_SERVER_APPROVE_QUESTION_ID) !== MCP_SERVER_APPROVE_VALUE) {
      outcome = { name: server.name, added: false, declined: true };
      return;
    }
    const current = readRegistry(deps);
    if (!current.live || !deps.settings) throw new Error("This machine lost its ADE account connection. Try again, or add the server in Settings › Connections › MCP servers.");
    // Another machine may have added it while the card was open.
    const raced = findSameMcpServer(current.servers, server);
    if (raced) {
      outcome = already(raced, server.name);
      return;
    }
    let saved = server;
    if (proposal.source === "imported") {
      // Moves the other tool's values into the vault inside this process.
      const imported = await deps.registry.importServer(server.name, deps.projectRoot);
      if (!imported.ok) throw new Error(imported.message);
      saved = imported.value;
    }
    // Values first: once the server is in the list the next chat starts it,
    // and it must find its values already there.
    const typed = new Set<string>();
    for (const secret of asked) {
      const value = firstAnswer(answers, secret.questionId);
      if (!value.length) continue;
      const stored = await deps.registry.setSecret(
        { server: saved.name, field: secret.field, name: secret.name },
        mcpCatalogueSecretValue(catalogue, secret.name, value),
      );
      if (!stored.ok) throw new Error(stored.message);
      typed.add(secret.questionId);
    }
    const next = addMcpRegistryServer(current.servers, saved);
    if (typeof next === "string") throw new Error(next);
    if (!deps.settings.set(ACCOUNT_SCOPE_ALL, MCP_SERVERS_SETTING_KEY, next)) {
      throw new Error("Your ADE account did not take the change. Try again, or add the server in Settings › Connections › MCP servers.");
    }
    // Values the server does not name. A failure leaves an unused value, not a broken server.
    await deps.registry.pruneSecrets(saved.name, saved).catch(() => undefined);
    outcome = {
      name: saved.name,
      added: true,
      missing: proposal.secrets
        .filter((secret) => !secret.copied && !typed.has(secret.questionId))
        .map((secret) => secret.name),
      next: MCP_SERVER_ADDED_NEXT,
    };
  };

  const response = await deps.requestChatInput({
    beforeAccept,
    chatSessionId,
    title: `Add MCP server ${server.name}`,
    body: reason,
    timeoutMs,
    allowsFreeform: false,
    eventDescription: `Add MCP server ${server.name}`,
    providerMetadata: { [MCP_SERVER_REQUEST_METADATA_KEY]: card },
    questions,
  });

  if (response.timedOut) {
    throw new Error(`Nobody answered the request to add ${server.name} in time. Ask again when the person is around.`);
  }
  const settled = outcome as McpServerRequestResult | null;
  if (response.decision === "decline" || response.decision === "cancel" || response.decision === "none" || !settled) {
    return { name: server.name, added: false, declined: true };
  }
  return settled;
}
