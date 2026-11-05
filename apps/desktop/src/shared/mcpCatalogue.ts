/**
 * ADE's catalogue of known MCP servers: the vendor's own address or command,
 * how it signs in, and its brand. It ships with ADE and is read-only.
 *
 * The catalogue is quick setups for popular servers, not a list of what ADE
 * supports: any MCP server can be added by command or URL. The card and
 * Settings show an entry's brand and publisher only when a server's URL or
 * package is exactly the entry's. Every address here comes from the vendor's
 * own docs; an entry that could not be confirmed is left out, never guessed.
 *
 * GitHub, Linear and Jira are ADE integrations. Their entries carry `native`,
 * and asking for one raises the integration's connect card instead of adding
 * a second, separate connection as an MCP server.
 */

import type { ConnectProviderId } from "./integrationConnect";
import type { McpRegistryServer, McpRegistryTransport } from "./mcpRegistry";
import { MCP_CATALOGUE_ENTRIES } from "./mcpCatalogueEntries";

/** How a server signs in. `oauth`: ADE's browser sign-in (`mcpOAuth.ts`). */
export type McpCatalogueAuth = "oauth" | "header" | "env" | "none";

export type McpCatalogueCategory =
  | "docs"
  | "dev"
  | "data"
  | "design"
  | "search"
  | "browser"
  | "payments"
  | "productivity"
  | "observability"
  | "reference";

/** One header (remote) or env variable (local) the server reads its key from. */
export type McpCatalogueSecret = {
  name: string;
  /** What the person is asked for: "API key". */
  label: string;
  /** Put before what the person types, when they leave it out: "Bearer ". */
  prefix?: string;
};

export type McpCatalogueEntry = {
  /** The server name agents see its tools under. A valid registry name. */
  id: string;
  name: string;
  publisher: string;
  /** What it does, in a few plain words. */
  description: string;
  category: McpCatalogueCategory;
  transport: McpRegistryTransport;
  url?: string;
  command?: string;
  args?: string[];
  auth: McpCatalogueAuth;
  secrets?: McpCatalogueSecret[];
  /** Where the person makes the key. */
  tokenUrl?: string;
  docsUrl: string;
  brand: {
    hex: string;
    /**
     * The brand mark as one 24×24 path: Simple Icons (CC0) where it has the
     * brand, else the vendor's own logo, scaled to fit. Absent: the name's first letter.
     */
    path?: string;
    /** For a mark whose holes need it (a logo with a cut-out). */
    fillRule?: "evenodd";
  };
  /** ADE has this as an integration; asking for it opens the connect card. */
  native?: ConnectProviderId;
};

export const MCP_CATALOGUE: readonly McpCatalogueEntry[] = MCP_CATALOGUE_ENTRIES;

const BY_ID = new Map(MCP_CATALOGUE.map((entry) => [entry.id, entry]));

export function mcpCatalogueEntry(id: string | null | undefined): McpCatalogueEntry | null {
  return id ? BY_ID.get(id.trim().toLowerCase()) ?? null : null;
}

/** The registry definition an entry adds. Names only; values go to the vault. */
export function mcpCatalogueServer(entry: McpCatalogueEntry): McpRegistryServer {
  const names = (entry.secrets ?? []).map((secret) => secret.name);
  return {
    name: entry.id,
    transport: entry.transport,
    ...(entry.transport === "stdio"
      ? { command: entry.command ?? "", args: [...(entry.args ?? [])] }
      : { url: entry.url ?? "" }),
    envNames: entry.transport === "stdio" ? names : [],
    headerNames: entry.transport === "stdio" ? [] : names,
    enabled: true,
  };
}

/** A typed value with the entry's prefix ("Bearer ") added when the person left it out. */
export function mcpCatalogueSecretValue(entry: McpCatalogueEntry | null, name: string, value: string): string {
  const prefix = entry?.secrets?.find((secret) => secret.name === name)?.prefix;
  if (!prefix || !value) return value;
  return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value : `${prefix}${value}`;
}

function normalizedUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const PACKAGE_RUNNERS = new Set(["npx", "bunx", "uvx", "pnpx"]);
/** The only runner options a match allows before the package; any other (`--registry`, `-p`, `--from`) can run something else. */
const PLAIN_RUNNER_OPTIONS = new Set(["-y", "--yes"]);

/**
 * `npx -y @scope/pkg@latest` → `@scope/pkg`; null when the command is not a
 * package runner, or a runner option before the package could change what runs.
 */
function runnerPackage(command: string | undefined, args: readonly string[] | undefined): string | null {
  const runner = (command ?? "").trim().split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, "").toLowerCase() ?? "";
  if (!PACKAGE_RUNNERS.has(runner)) return null;
  let spec: string | undefined;
  for (const arg of args ?? []) {
    if (!arg.startsWith("-")) {
      spec = arg;
      break;
    }
    if (!PLAIN_RUNNER_OPTIONS.has(arg)) return null;
  }
  if (!spec) return null;
  const at = spec.lastIndexOf("@");
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
}

/**
 * The catalogue entry a server is, by its exact URL or package. A server an
 * agent describes or another tool has gets the entry's brand and badge only
 * when it really is the vendor's server.
 */
export function matchMcpCatalogue(
  server: Pick<McpRegistryServer, "transport" | "url" | "command" | "args">,
): McpCatalogueEntry | null {
  if (server.transport === "stdio") {
    const pkg = runnerPackage(server.command, server.args);
    if (!pkg) return null;
    return MCP_CATALOGUE.find((entry) =>
      entry.transport === "stdio" && runnerPackage(entry.command, entry.args) === pkg) ?? null;
  }
  const url = normalizedUrl(server.url);
  if (!url) return null;
  return MCP_CATALOGUE.find((entry) => entry.transport !== "stdio" && normalizedUrl(entry.url) === url) ?? null;
}
