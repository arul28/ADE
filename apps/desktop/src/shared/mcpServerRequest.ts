import type { ConnectProviderId } from "./integrationConnect";
import type { PendingInputRequest } from "./types/chat";
import type { McpConfigProvider, McpFoundServer } from "./types/mcpRegistry";
import {
  isValidMcpFieldName,
  normalizeMcpRegistryServer,
  type McpRegistryServer,
  type McpRegistryState,
  type McpRegistryTransport,
  type McpSecretField,
} from "./mcpRegistry";

/**
 * The MCP server card: an agent proposes adding a server to the person's MCP
 * registry, and the person approves it in the agent's own chat.
 *
 * It rides the same pending-input machinery as the connect card
 * (`requestChatInput` → `respondToInput`), so any client that can answer a
 * question can answer it. A secret value travels only as the answer to an
 * `isSecret` question, which the transcript writer drops. The host on the
 * chat's machine saves the server into the account registry and its values
 * into the account vault, the way Settings › Connections › MCP servers does, and hands the
 * agent only the outcome.
 *
 * Approval is always the person's: the metadata key below makes the card
 * user-only (`isUserOnlyConsentCard`), whatever the chat's permission mode.
 */

/** `providerMetadata` key on the card. Its presence makes the card user-only. */
export const MCP_SERVER_REQUEST_METADATA_KEY = "mcpServerRequest" as const;

/** The yes/no question every client answers. */
export const MCP_SERVER_APPROVE_QUESTION_ID = "mcp_server_approve" as const;
export const MCP_SERVER_APPROVE_VALUE = "add" as const;
export const MCP_SERVER_DECLINE_VALUE = "not_now" as const;

export const MCP_SERVER_REQUEST_REASON_MAX_CHARS = 500;

/**
 * Where the proposal came from: another tool's config, an agent's own
 * description, or ADE's catalogue of known servers (`mcpCatalogue.ts`).
 */
export type McpServerRequestSource = "imported" | "agent" | "catalog";

/** One env variable or header the server reads from the vault. */
export type McpServerRequestSecret = {
  field: McpSecretField;
  name: string;
  /** The question the value is answered under. */
  questionId: string;
  /** The other tool's config already has the value; ADE copies it, nobody types it. */
  copied: boolean;
};

export type McpServerRequestCard = {
  source: McpServerRequestSource;
  reason: string;
  /** The definition as it will be saved. Names only, never a value. */
  server: McpRegistryServer;
  /** Exactly what will run (the command line) or be dialed (the URL). */
  runs: string;
  /** `imported`: the tools whose config has it. */
  providers: McpConfigProvider[];
  secrets: McpServerRequestSecret[];
  /** `catalog`: the entry it was built from (`mcpCatalogue.ts`). */
  catalogueId?: string;
};

/** What `mcp_registry.request` returns. Never a secret value. */
export type McpServerRequestResult =
  | { name: string; added: true; missing: string[]; next: string }
  | { name: string; added: false; already: true; existing: string; matchedBy: "name" | "url" | "command"; next: string }
  | { name: string; added: false; declined: true }
  /** A catalogue name that is an ADE integration: the connect card ran instead. */
  | { name: string; added: false; integration: ConnectProviderId; connected: boolean; next: string };

/** One registry server as `mcp_registry.list` reports it. */
export type McpRegistryListEntry = {
  name: string;
  transport: McpRegistryTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** What it runs or where it answers, as one line. */
  runs: string;
  enabled: boolean;
  offOnThisMachine: boolean;
  offInThisProject: boolean;
  /** Whether chats on this machine in this project get it. */
  state: McpRegistryState;
  /** Each env variable / header it names, and whether its value is in the vault. */
  secrets: Array<{ field: McpSecretField; name: string; set: boolean }>;
};

/** What `mcp_registry.list` returns. Names and set/not-set only. */
export type McpRegistryListing = {
  servers: McpRegistryListEntry[];
  /** Servers other tools' configs on this machine have that the registry does not. */
  found: McpFoundServer[];
  /** Names the scan saw but ADE cannot hold. */
  skipped: string[];
  /** Null when the registry read fine; otherwise why the list may be stale or empty. */
  notice: string | null;
};

/** What `mcp_registry.chatStatus` returns for one chat. */
export type McpRegistryChatStatus = {
  /** Registry servers on here that this chat's running agent did not start with. */
  missing: string[];
};

export function mcpServerSecretQuestionId(field: McpSecretField, name: string): string {
  return `mcp_secret_${field}_${name}`;
}

/** One argument as a person would type it in a shell. */
function shellWord(word: string): string {
  if (word.length && /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The exact command line a `stdio` server runs, or the URL a remote one answers at. */
export function mcpServerRunsLine(server: Pick<McpRegistryServer, "transport" | "command" | "args" | "url">): string {
  if (server.transport !== "stdio") return server.url ?? "";
  return [server.command ?? "", ...(server.args ?? [])].map(shellWord).join(" ");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSecrets(value: unknown): McpServerRequestSecret[] {
  if (!Array.isArray(value)) return [];
  const out: McpServerRequestSecret[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    if (!record) continue;
    const field = record.field;
    const name = typeof record.name === "string" ? record.name : "";
    if ((field !== "env" && field !== "header") || !isValidMcpFieldName(name)) continue;
    out.push({ field, name, questionId: mcpServerSecretQuestionId(field, name), copied: record.copied === true });
  }
  return out;
}

/** The card's metadata, or null when this pending input is not an MCP server card. */
export function readMcpServerRequestCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): McpServerRequestCard | null {
  const record = readRecord(request?.providerMetadata?.[MCP_SERVER_REQUEST_METADATA_KEY]);
  if (!record) return null;
  const server = normalizeMcpRegistryServer(record.server);
  if (!server) return null;
  const source: McpServerRequestSource = record.source === "imported" || record.source === "catalog" ? record.source : "agent";
  return {
    source,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    server,
    // Drawn from the definition, never from free text the asker sent along.
    runs: mcpServerRunsLine(server),
    providers: Array.isArray(record.providers)
      ? record.providers.filter((entry): entry is McpConfigProvider => typeof entry === "string")
      : [],
    secrets: readSecrets(record.secrets),
    ...(source === "catalog" && typeof record.catalogueId === "string" ? { catalogueId: record.catalogueId } : {}),
  };
}

/** The answers the native card sends: the approval, then each typed value by its question. */
export function mcpServerRequestAnswers(values: Record<string, string>): Record<string, string> {
  const answers: Record<string, string> = { [MCP_SERVER_APPROVE_QUESTION_ID]: MCP_SERVER_APPROVE_VALUE };
  for (const [questionId, value] of Object.entries(values)) {
    if (value.length) answers[questionId] = value;
  }
  return answers;
}
