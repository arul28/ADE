import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { AccountAttestationError, verifyClerkAccountAttestation } from "../account/accountAttestationVerifier";
import type { AccountAttestationConfig } from "../account/sharedAccountAuthService";
import {
  captureAdeMcpAnalytics,
  type FeatureAnalytics,
} from "../../../../desktop/src/main/services/analytics/featureProductAnalytics";
import type { ProductAnalyticsSurface } from "../../../../desktop/src/shared/types/productAnalytics";
import {
  isRemoteMcpScope,
  type RemoteMcpAction,
  type RemoteMcpActivityEntry,
  type RemoteMcpConnectionSummary,
  type RemoteMcpCreatedToken,
  type RemoteMcpScope,
  type RemoteMcpStatus,
} from "../../../../desktop/src/shared/types/remoteMcp";
import {
  deriveRemoteMcpAccountKey,
  isRemoteMcpAccountSecret,
  isRemoteMcpEnabledForAccount,
  isRemoteMcpMachineKey,
  mintRemoteMcpAccountSecret,
  readRemoteMcpLastUsed,
  readRemoteMcpMachineEntry,
  remoteMcpAdeVersion,
  remoteMcpLastUsedKey,
  REMOTE_MCP_ENABLED_KEY,
  REMOTE_MCP_SETTINGS_SCOPE,
  writeRemoteMcpMachineEntry,
  type RemoteMcpSettings,
} from "./remoteMcpAccount";
import { createRemoteMcpActivityLog } from "./remoteMcpActivityLog";
import {
  createRemoteMcpMachineRouter,
  decodeViaHeader,
  REMOTE_MCP_VIA_HEADER,
  type RemoteMcpCallContext,
  type RemoteMcpDirectoryMachine,
} from "./remoteMcpForward";
import {
  AUTHORIZE_PAGE_HEADERS,
  buildRedirect,
  createRemoteMcpAuthorizationState,
  decodeClientId,
  parseAuthorizeRequest,
  type AuthorizeRequest,
  redirectDisplayHost,
  registerClient,
  renderConsentPage,
  renderSignInPage,
  type SignedInAccount,
  renderMessagePage,
  scopeToOAuth,
  verifyPkce,
} from "./remoteMcpOAuth";
import {
  createRemoteMcpStore,
  markLegacyRemoteMcpFileMigrated,
  readLegacyRemoteMcpFile,
  REMOTE_MCP_ACCOUNT_SECRET_KEY,
  REMOTE_MCP_TOKEN_PREFIX,
  REMOTE_MCP_VAULT_KIND,
  REMOTE_MCP_VAULT_SCOPE,
  type RemoteMcpVault,
} from "./remoteMcpStore";
import { createRemoteMcpProtocol, type JsonRpcMessage, type RemoteMcpProject } from "./remoteMcpProtocol";

export { MAX_CONCURRENT_REMOTE_RUNS, MAX_CONCURRENT_RUNS_PER_CONNECTION, type RemoteMcpProject } from "./remoteMcpProtocol";

/**
 * ADE MCP: one MCP server for the person's ADE account, reached through ADE
 * Relay. This is one computer's part of it.
 *
 * The relay Worker forwards each HTTP request under `/a/<accountKey>/` (the
 * account address, answered by any serving computer of the account) or
 * `/m/<endpointKey>/` (this computer only) over the brain's existing control
 * socket, and returns whatever this answers. All of it happens here: the MCP
 * protocol, OAuth sign-in, token checks against this computer's copy of the
 * account vault, running the `ade` command, and sending a call on to another
 * computer of the account. The Worker stores nothing and can mint nothing.
 *
 * Off by default, for the whole account (`ade_mcp.enabled`). This computer
 * serves when it is signed in, the account has it on, it is not left out, the
 * account secret exists and it has a relay identity. Otherwise the brain
 * tells the relay so, and the relay answers 404 without waking this computer.
 */

export type RemoteMcpHttpRequest = {
  method: string;
  /** Path under the machine prefix, with query, e.g. `/oauth/authorize?…`. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
  /** Set by the relay when the request came on the account address. */
  mount?: { kind: "account"; key: string };
};

export type RemoteMcpHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type RemoteMcpRelayEndpoint = {
  relayUrl: string;
  /** This computer's relay machine key: its id in the account directory and settings. */
  machineKey: string;
  /** The key in the per-machine URL; not the relay key (see mcpEndpointKeyFor). */
  endpointKey: string;
  connected: boolean;
};

const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
/** A token this computer does not know triggers at most one vault pull per this long. */
const AUTH_MISS_SYNC_INTERVAL_MS = 15_000;
/**
 * A known token starts a background pull when this computer's vault copy is
 * older than this, so a revoke on another computer reaches here within about
 * a minute (plus one pull).
 */
const REVOCATION_FRESHNESS_MS = 60_000;
/** While ADE MCP is on, the vault copy is pulled at least this often even with no traffic. */
const IDLE_VAULT_FRESHNESS_MS = 5 * 60_000;
/** `ade_mcp.lastUsed.<id>` is written at most this often per connection. */
const LAST_USED_PUBLISH_INTERVAL_MS = 10 * 60_000;
/** How often the service re-reads its account state when nothing pokes it. */
const REFRESH_INTERVAL_MS = 30_000;
/** Pending web sign-ins remember which address (account or machine) they began on. */
const SIGN_IN_ISSUER_TTL_MS = 15 * 60_000;
const MAX_SIGN_IN_ISSUERS = 64;

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RemoteMcpHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
    body: JSON.stringify(value),
  };
}

function html(status: number, body: string): RemoteMcpHttpResponse {
  return { status, headers: { ...AUTHORIZE_PAGE_HEADERS }, body };
}

function redirect(location: string): RemoteMcpHttpResponse {
  return { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" };
}

function header(request: RemoteMcpHttpRequest, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function parseForm(request: RemoteMcpHttpRequest): URLSearchParams {
  const type = header(request, "content-type").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (typeof value === "string") params.set(key, value);
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(request.body ?? "");
}

export type RemoteMcpService = ReturnType<typeof createRemoteMcpService>;

export function createRemoteMcpService(args: {
  /** The per-computer `remote-mcp.json` from before accounts; read once to migrate it. */
  legacyStorePath: string;
  activityPath: string;
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
  /** The provider and model this computer last launched a chat with. */
  launchDefaults?: () => { provider: string; model: string } | null;
  logger?: {
    info?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  /**
   * The ADE account this computer is signed in to, and how to check one: the
   * same Clerk client and attestation the relay's phone hellos use.
   */
  account: {
    signedIn: () => SignedInAccount | null;
    oauth: () => { issuer: string; clientId: string } | null;
    attestation: () => AccountAttestationConfig | null;
  };
  /** This computer's copy of the account vault: the account secret and the connections. */
  vault: RemoteMcpVault;
  /** This computer's copy of the account settings: on/off and the computers. */
  settings: RemoteMcpSettings;
  /** The account directory (who is online); null when it cannot be read. */
  listAccountMachines?: () => Promise<RemoteMcpDirectoryMachine[] | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const lastUsedHere = new Map<string, number>();
  const lastUsedPublished = new Map<string, number>();
  const store = createRemoteMcpStore({
    vault: args.vault,
    logger: args.logger,
    now: () => new Date(now()),
    lastUsedAt: (id) => {
      const here = lastUsedHere.get(id);
      const account = readRemoteMcpLastUsed(args.settings, id);
      if (here === undefined) return account;
      const hereIso = new Date(here).toISOString();
      return account && account > hereIso ? account : hereIso;
    },
  });
  const activity = createRemoteMcpActivityLog({ filePath: args.activityPath, logger: args.logger });
  const authorization = createRemoteMcpAuthorizationState();
  const stateListeners = new Set<(enabled: boolean) => void>();
  let relayEndpoint: () => RemoteMcpRelayEndpoint | null = () => null;
  let analytics: FeatureAnalytics | null = null;
  // The computer that forwarded the call being handled, for the activity log.
  const viaContext = new AsyncLocalStorage<string | null>();

  const warn = (event: string, error: unknown, data: Record<string, unknown> = {}): void => {
    args.logger?.warn?.(event, { ...data, error: error instanceof Error ? error.message : String(error) });
  };

  // ── Account state ─────────────────────────────────────────────────────────

  const signedIn = (): boolean => args.account.signedIn() !== null;
  const accountOn = (): boolean => signedIn() && isRemoteMcpEnabledForAccount(args.settings);

  const accountSecret = (): string | null => {
    if (!signedIn()) return null;
    const value = args.vault.get(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, REMOTE_MCP_ACCOUNT_SECRET_KEY);
    return isRemoteMcpAccountSecret(value) ? value : null;
  };

  let accountKeyMemo: { secret: string; key: string } | null = null;
  const accountKey = (): string | null => {
    const secret = accountSecret();
    if (!secret) return null;
    if (accountKeyMemo?.secret !== secret) accountKeyMemo = { secret, key: deriveRemoteMcpAccountKey(secret) };
    return accountKeyMemo.key;
  };

  const includedHere = (): boolean => {
    const endpoint = relayEndpoint();
    if (!endpoint) return true;
    return readRemoteMcpMachineEntry(args.settings, endpoint.machineKey)?.included !== false;
  };

  /** This computer answers ADE MCP: signed in, on for the account, not left out, secret and relay present. */
  const serving = (): boolean =>
    accountOn() && includedHere() && accountSecret() !== null && relayEndpoint() !== null;

  /** `https://<relay>/m/<endpointKey>`: this computer only. */
  const base = (): string | null => {
    const endpoint = relayEndpoint();
    if (!endpoint) return null;
    return `${withoutTrailingSlash(endpoint.relayUrl)}/m/${endpoint.endpointKey}`;
  };

  /** `https://<relay>/a/<accountKey>`: any serving computer of the account. */
  const accountBase = (): string | null => {
    const endpoint = relayEndpoint();
    const key = accountKey();
    if (!endpoint || !key) return null;
    return `${withoutTrailingSlash(endpoint.relayUrl)}/a/${key}`;
  };

  const notifyState = (): void => {
    const enabled = serving();
    for (const listener of stateListeners) {
      try {
        listener(enabled);
      } catch (error) {
        warn("remote_mcp.enabled_listener_failed", error);
      }
    }
  };

  // What the relay was last told; a change (on/off or a new secret) is said again.
  let announced: { serving: boolean; secret: string | null } = { serving: false, secret: null };
  const announceIfChanged = (): void => {
    const isServing = serving();
    const next = { serving: isServing, secret: isServing ? accountSecret() : null };
    if (next.serving === announced.serving && next.secret === announced.secret) return;
    announced = next;
    args.logger?.info?.("remote_mcp.serving_changed", { serving: next.serving });
    notifyState();
  };

  let secretInFlight: Promise<string> | null = null;
  /**
   * The account secret, made by the first computer that turns ADE MCP on.
   * Read after a fresh pull so a second computer adopts the first one's; if
   * two make one at once, the vault keeps one and both follow it on the next
   * pull (`announceIfChanged` tells the relay the new one).
   */
  const ensureAccountSecret = (): Promise<string> => {
    secretInFlight ??= (async () => {
      const existing = accountSecret();
      if (existing) return existing;
      const status = await args.vault.sync();
      const pulled = accountSecret();
      if (pulled) return pulled;
      if (status !== "ready") {
        throw new Error("ADE couldn't reach your ADE account to set up ADE MCP. Check the internet connection and try again.");
      }
      const minted = mintRemoteMcpAccountSecret();
      if (!args.vault.set(REMOTE_MCP_VAULT_SCOPE, REMOTE_MCP_VAULT_KIND, REMOTE_MCP_ACCOUNT_SECRET_KEY, minted)) {
        throw new Error("ADE couldn't save ADE MCP to your ADE account: the signed-in account changed. Try again.");
      }
      args.logger?.info?.("remote_mcp.account_secret_created", {});
      return minted;
    })().finally(() => {
      secretInFlight = null;
    });
    return secretInFlight;
  };

  let lastEntryPublishAt = 0;
  /**
   * Publishes this computer's entry (name, per-machine endpoint key, version)
   * while ADE MCP is on for the account, so the others can list and reach it.
   * Written only when something changed, after a pull, and it keeps whatever
   * `included` another computer set.
   */
  const publishOwnEntry = async (): Promise<void> => {
    const endpoint = relayEndpoint();
    if (!endpoint || !accountOn()) return;
    const desired = { name: args.machineName(), endpointKey: endpoint.endpointKey, version: remoteMcpAdeVersion() };
    const same = (entry: ReturnType<typeof readRemoteMcpMachineEntry>) => Boolean(entry
      && entry.name === desired.name && entry.endpointKey === desired.endpointKey && entry.version === desired.version);
    if (same(readRemoteMcpMachineEntry(args.settings, endpoint.machineKey))) return;
    if (now() - lastEntryPublishAt < 60_000) return;
    lastEntryPublishAt = now();
    await args.settings.sync().catch((error) => warn("remote_mcp.settings_sync_failed", error));
    const existing = readRemoteMcpMachineEntry(args.settings, endpoint.machineKey);
    if (same(existing)) return;
    writeRemoteMcpMachineEntry(args.settings, {
      machineKey: endpoint.machineKey,
      ...desired,
      included: existing?.included ?? true,
      updatedAt: new Date(now()).toISOString(),
    });
    // Upload now: the others cannot reach this computer until they see it.
    void args.settings.sync().catch((error) => warn("remote_mcp.settings_sync_failed", error));
  };

  let legacyMigrated = false;
  /**
   * Copies the per-computer connections from before accounts into the vault,
   * with the same ids and hashes so their tokens keep working, and carries the
   * old on/off over unless the account already has its own. Waits for a
   * sign-in and a reachable vault; the legacy file is emptied only after.
   */
  const migrateLegacy = async (): Promise<void> => {
    if (legacyMigrated) return;
    const legacy = readLegacyRemoteMcpFile(args.legacyStorePath, args.logger);
    if (!legacy || legacy.migratedAt || (!legacy.enabled && legacy.connections.length === 0)) {
      legacyMigrated = true;
      return;
    }
    if (!signedIn()) return;
    if (await args.vault.sync() !== "ready") return;
    let copied = 0;
    for (const connection of legacy.connections) {
      if (store.has(connection.id)) continue;
      store.importConnection(connection);
      copied += 1;
      if (connection.lastUsedAt && !readRemoteMcpLastUsed(args.settings, connection.id)) {
        args.settings.set(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpLastUsedKey(connection.id), connection.lastUsedAt);
      }
    }
    if (legacy.enabled && args.settings.get(REMOTE_MCP_SETTINGS_SCOPE, REMOTE_MCP_ENABLED_KEY) === undefined) {
      await ensureAccountSecret();
      args.settings.set(REMOTE_MCP_SETTINGS_SCOPE, REMOTE_MCP_ENABLED_KEY, true);
    }
    markLegacyRemoteMcpFileMigrated(args.legacyStorePath, new Date(now()));
    legacyMigrated = true;
    void args.settings.sync().catch((error) => warn("remote_mcp.settings_sync_failed", error));
    args.logger?.info?.("remote_mcp.legacy_migrated", { connections: copied, enabled: legacy.enabled });
  };

  let maintenanceInFlight: Promise<void> | null = null;
  /** Migration, this computer's entry, the account secret and vault freshness. Single-flight. */
  const maintain = (): Promise<void> => {
    maintenanceInFlight ??= (async () => {
      try {
        await migrateLegacy();
      } catch (error) {
        warn("remote_mcp.legacy_migration_failed", error);
      }
      if (!accountOn()) return;
      try {
        await publishOwnEntry();
      } catch (error) {
        warn("remote_mcp.entry_publish_failed", error);
      }
      try {
        if (!accountSecret()) await ensureAccountSecret();
      } catch (error) {
        warn("remote_mcp.account_secret_failed", error);
      }
      // A computer with no traffic still follows a replaced secret and revocations.
      void args.vault.sync({ maxAgeMs: IDLE_VAULT_FRESHNESS_MS }).catch(() => undefined);
    })().finally(() => {
      maintenanceInFlight = null;
      announceIfChanged();
    });
    return maintenanceInFlight;
  };

  /** Re-reads the account state; tells the relay when serving or the secret changed. */
  const refresh = (): void => {
    announceIfChanged();
    void maintain();
  };

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const startRefreshing = (): void => {
    if (refreshTimer) return;
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  };

  // ── Connections ───────────────────────────────────────────────────────────

  let missSync: { at: number; inFlight: Promise<unknown> | null } = { at: 0, inFlight: null };
  /**
   * The connection a bearer belongs to, from this computer's vault copy.
   *
   * A token made on another computer may not be here yet: a miss pulls the
   * vault (shared by concurrent misses, at most one pull per 15 s whatever
   * the tokens) and looks again. A hit starts a background pull when the copy is older than a
   * minute, which is how a revoke on another computer reaches this one.
   */
  const authenticate = async (token: string): Promise<RemoteMcpConnectionSummary | null> => {
    const hit = store.authenticate(token);
    if (hit) {
      void args.vault.sync({ maxAgeMs: REVOCATION_FRESHNESS_MS }).catch(() => undefined);
      return hit;
    }
    if (!token.startsWith(REMOTE_MCP_TOKEN_PREFIX) || token.length > 200) return null;
    if (!missSync.inFlight) {
      if (now() - missSync.at < AUTH_MISS_SYNC_INTERVAL_MS) return null;
      missSync = {
        at: now(),
        // A forced pull: "fresh within 15 s" would still miss a token made
        // on another computer just after this one's last pull.
        inFlight: args.vault.sync()
          .catch(() => undefined)
          .finally(() => {
            missSync = { at: missSync.at, inFlight: null };
          }),
      };
    }
    await missSync.inFlight;
    return store.authenticate(token);
  };

  const recordUse = (id: string): void => {
    const at = now();
    lastUsedHere.set(id, at);
    if (at - (lastUsedPublished.get(id) ?? 0) < LAST_USED_PUBLISH_INTERVAL_MS) return;
    lastUsedPublished.set(id, at);
    try {
      args.settings.set(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpLastUsedKey(id), new Date(at).toISOString());
    } catch (error) {
      // Last-used is informational; a failed write must not fail the call.
      warn("remote_mcp.last_used_write_failed", error);
    }
  };

  const record = (entry: Omit<RemoteMcpActivityEntry, "at">): void => {
    const via = viaContext.getStore();
    activity.append({ at: new Date(now()).toISOString(), ...entry, ...(via ? { via } : {}) });
  };

  const machines = createRemoteMcpMachineRouter({
    settings: args.settings,
    thisMachine: () => ({ key: relayEndpoint()?.machineKey ?? null, name: args.machineName() }),
    servingHere: serving,
    relayUrl: () => relayEndpoint()?.relayUrl ?? null,
    listAccountMachines: args.listAccountMachines ?? (async () => null),
    fetchImpl: args.fetchImpl,
    now,
  });

  const protocol = createRemoteMcpProtocol({
    machineName: args.machineName,
    listProjects: args.listProjects,
    ...(args.launchDefaults ? { launchDefaults: args.launchDefaults } : {}),
    record,
    warn: (event, data) => args.logger?.warn?.(event, data),
    machines,
  });

  const unauthorized = (serverBase: string, presented: boolean): RemoteMcpHttpResponse => json(
    401,
    {
      error: presented ? "invalid_token" : "unauthorized",
      error_description: "Connect this app to ADE first: sign in with your ADE account, or send an ADE MCP token.",
    },
    {
      "www-authenticate": `Bearer resource_metadata="${serverBase}/.well-known/oauth-protected-resource"${presented ? ", error=\"invalid_token\"" : ""}`,
    },
  );

  const handleMcp = async (
    request: RemoteMcpHttpRequest,
    serverBase: string,
    accountMount: boolean,
  ): Promise<RemoteMcpHttpResponse> => {
    const authHeader = header(request, "authorization");
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const bearer = match ? match[1]! : null;
    const connection = bearer ? await authenticate(bearer) : null;
    if (!connection) return unauthorized(serverBase, Boolean(match));
    if (request.method === "GET" || request.method === "DELETE") {
      // Stateless server: no server-initiated stream and no session to end.
      return json(405, { error: "This server answers POST only." }, { allow: "POST" });
    }
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    recordUse(connection.id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const via = decodeViaHeader(header(request, REMOTE_MCP_VIA_HEADER));
    const context: RemoteMcpCallContext = {
      bearer,
      via,
      protocolVersion: header(request, "mcp-protocol-version") || null,
      accountMount,
    };
    return await viaContext.run(via, async () => {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > 20) {
          return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send 1 to 20 messages." } });
        }
        // One at a time: run together, a batch would trip the run limit on itself.
        const replies: Record<string, unknown>[] = [];
        for (const entry of parsed) {
          const answer = await protocol.handleRpc(connection, entry as JsonRpcMessage, context);
          if (answer !== null) replies.push(answer);
        }
        return replies.length ? json(200, replies) : { status: 202, headers: {}, body: "" };
      }
      if (!parsed || typeof parsed !== "object") {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
      }
      const replyMessage = await protocol.handleRpc(connection, parsed as JsonRpcMessage, context);
      return replyMessage ? json(200, replyMessage) : { status: 202, headers: {}, body: "" };
    });
  };

  // ── OAuth ─────────────────────────────────────────────────────────────────

  // A web sign-in can begin on the account address but always comes back to
  // this computer (the Clerk state names its endpoint key). The `iss` an app
  // gets back must be the issuer it started with, so remember it per sign-in.
  const signInIssuers = new Map<string, { issuer: string; at: number }>();
  const rememberIssuer = (nonce: string, issuer: string): void => {
    for (const [key, value] of signInIssuers) {
      if (now() - value.at > SIGN_IN_ISSUER_TTL_MS || signInIssuers.size >= MAX_SIGN_IN_ISSUERS) signInIssuers.delete(key);
    }
    signInIssuers.set(nonce, { issuer, at: now() });
  };
  const issuerFor = (nonce: string, fallback: string): string => signInIssuers.get(nonce)?.issuer ?? fallback;

  const protectedResourceMetadata = (serverBase: string, accountMount: boolean) => ({
    resource: `${serverBase}/mcp`,
    authorization_servers: [serverBase],
    bearer_methods_supported: ["header"],
    scopes_supported: ["ade:read", "ade:write"],
    resource_name: accountMount ? "ADE" : `ADE on ${args.machineName()}`,
  });

  const authorizationServerMetadata = (serverBase: string) => ({
    issuer: serverBase,
    authorization_endpoint: `${serverBase}/oauth/authorize`,
    token_endpoint: `${serverBase}/oauth/token`,
    registration_endpoint: `${serverBase}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["ade:read", "ade:write"],
    authorization_response_iss_parameter_supported: true,
  });

  const expiredSignIn = (): RemoteMcpHttpResponse =>
    html(400, renderMessagePage("This sign-in expired", "Go back to the app and connect again."));

  /** Where ADE sign-in sends the person back: the relay's one fixed callback. */
  const accountCallbackUrl = (): string | null => {
    const endpoint = relayEndpoint();
    return endpoint ? `${withoutTrailingSlash(endpoint.relayUrl)}/oauth/callback` : null;
  };

  const denyToApp = (authRequest: AuthorizeRequest, serverBase: string): RemoteMcpHttpResponse =>
    redirect(buildRedirect(authRequest.redirectUri, {
      error: "access_denied",
      error_description: "The person cancelled.",
      state: authRequest.state,
      iss: serverBase,
    }));

  // Step 1: the app sends the person here; "Continue with ADE" starts the ADE sign-in.
  const handleAuthorize = (request: RemoteMcpHttpRequest, query: URLSearchParams, serverBase: string): RemoteMcpHttpResponse => {
    const isPost = request.method === "POST";
    if (!isPost && request.method !== "GET") return json(405, { error: "Method not allowed." });
    const params = isPost ? parseForm(request) : query;
    const parsed = parseAuthorizeRequest(params);
    if (!parsed.ok) {
      if (parsed.kind === "page") return html(400, renderMessagePage("Can't connect this app", parsed.message));
      return redirect(buildRedirect(parsed.redirectUri, {
        error: parsed.error,
        error_description: parsed.description,
        state: parsed.state,
        iss: serverBase,
      }));
    }
    const authRequest = parsed.request;
    const machineName = args.machineName();
    const oauth = args.account.oauth();
    const callbackUrl = accountCallbackUrl();
    const endpoint = relayEndpoint();
    const ready = oauth && args.account.attestation() && callbackUrl && endpoint
      ? { oauth, callbackUrl, endpoint }
      : null;
    const unavailable = !args.account.signedIn()
      ? `${machineName} isn't signed in to an ADE account. Sign in to ADE on it, then try again.`
      : !ready
        ? `${machineName} can't check ADE sign-ins right now. Update ADE on it, then try again.`
        : null;
    if (!isPost) return html(200, renderSignInPage({ request: authRequest, machineName, error: unavailable }));
    if (params.get("decision") === "deny") return denyToApp(authRequest, serverBase);
    if (unavailable || !ready) {
      return html(409, renderSignInPage({ request: authRequest, machineName, error: unavailable }));
    }
    const { nonce, accountChallenge } = authorization.beginSignIn(authRequest);
    rememberIssuer(nonce, serverBase);
    const signIn = new URL(`${withoutTrailingSlash(ready.oauth.issuer)}/oauth/authorize`);
    signIn.searchParams.set("response_type", "code");
    signIn.searchParams.set("client_id", ready.oauth.clientId);
    signIn.searchParams.set("redirect_uri", ready.callbackUrl);
    signIn.searchParams.set("code_challenge", accountChallenge);
    signIn.searchParams.set("code_challenge_method", "S256");
    // The relay routes the callback back to this machine by the key before the dot.
    signIn.searchParams.set("state", `${ready.endpoint.endpointKey}.${nonce}`);
    signIn.searchParams.set("scope", "openid profile email");
    return redirect(signIn.toString());
  };

  /** Redeems ADE's sign-in code here, with a verifier only this computer holds. */
  const exchangeAccountCode = async (code: string, verifier: string): Promise<string> => {
    const oauth = args.account.oauth();
    const callbackUrl = accountCallbackUrl();
    if (!oauth || !callbackUrl) throw new Error("ADE sign-in isn't configured on this computer.");
    const response = await fetch(`${withoutTrailingSlash(oauth.issuer)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: oauth.clientId,
        redirect_uri: callbackUrl,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
    if (!response.ok || typeof body?.access_token !== "string") throw new Error(`ADE sign-in answered ${response.status}.`);
    return body.access_token;
  };

  // Step 2: back from ADE sign-in. Check the account, then ask for access.
  const handleAccountCallback = async (query: URLSearchParams, serverBase: string): Promise<RemoteMcpHttpResponse> => {
    const state = query.get("state") ?? "";
    const nonce = state.slice(state.indexOf(".") + 1);
    const pending = nonce ? authorization.pendingAccountStep(nonce) : null;
    if (!pending) {
      return expiredSignIn();
    }
    const { request: authRequest } = pending;
    const issuer = issuerFor(nonce, serverBase);
    if (query.get("error") || !query.get("code")) {
      authorization.forget(nonce);
      return denyToApp(authRequest, issuer);
    }
    const owner = args.account.signedIn();
    const attestation = args.account.attestation();
    if (!owner || !attestation) {
      authorization.forget(nonce);
      return html(409, renderMessagePage("Can't connect", `${args.machineName()} isn't signed in to an ADE account.`));
    }
    try {
      const token = await exchangeAccountCode(query.get("code")!, pending.accountVerifier);
      await verifyClerkAccountAttestation({ token, expectedUserId: owner.userId, config: attestation });
    } catch (error) {
      authorization.forget(nonce);
      const mismatch = error instanceof AccountAttestationError && error.code === "account_mismatch";
      args.logger?.warn?.("remote_mcp.account_sign_in_failed", {
        reason: error instanceof AccountAttestationError ? error.code : "exchange_failed",
      });
      return html(mismatch ? 403 : 502, renderMessagePage(
        mismatch ? "Different ADE account" : "Couldn't check your sign-in",
        mismatch
          ? `${args.machineName()} belongs to ${owner.email ?? "another ADE account"}. Sign in with that account to connect apps to it.`
          : "ADE couldn't confirm your sign-in. Go back to the app and try again.",
      ));
    }
    const csrf = authorization.markSignedIn(nonce, owner);
    if (!csrf) return expiredSignIn();
    return html(200, renderConsentPage({
      request: authRequest,
      machineName: args.machineName(),
      account: owner,
      nonce,
      csrf,
      // The pending sign-in lives on this computer: post back to it, not the account address.
      consentPath: `${base() ?? serverBase}/oauth/consent`,
    }));
  };

  // Step 3: the person chose the access and allowed it.
  const handleConsent = (request: RemoteMcpHttpRequest, serverBase: string): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const params = parseForm(request);
    const nonce = params.get("nonce") ?? "";
    const taken = authorization.takeConsent(nonce, params.get("csrf") ?? "");
    if (!taken) return expiredSignIn();
    const issuer = issuerFor(nonce, serverBase);
    signInIssuers.delete(nonce);
    const { request: authRequest } = taken;
    if (params.get("decision") !== "allow") return denyToApp(authRequest, issuer);
    const scope: RemoteMcpScope = params.get("access") === "read" ? "read" : "write";
    const code = authorization.issueAuthCode({
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      codeChallenge: authRequest.codeChallenge,
      scope,
      clientName: authRequest.client.clientName,
    });
    return redirect(buildRedirect(authRequest.redirectUri, { code, state: authRequest.state, iss: issuer }));
  };

  const handleToken = (request: RemoteMcpHttpRequest): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "invalid_request" });
    const params = parseForm(request);
    const fail = (error: string, description: string, status = 400) =>
      json(status, { error, error_description: description });
    if (params.get("grant_type") !== "authorization_code") {
      return fail("unsupported_grant_type", "Only authorization_code is supported.");
    }
    const pending = authorization.takeAuthCode(params.get("code") ?? "");
    if (!pending) return fail("invalid_grant", "The authorization code is unknown, used, or expired.");
    const clientId = params.get("client_id");
    if (clientId && clientId !== pending.clientId) return fail("invalid_grant", "The code was issued to another client.");
    const redirectUri = params.get("redirect_uri");
    if (redirectUri && redirectUri !== pending.redirectUri) return fail("invalid_grant", "redirect_uri does not match.");
    if (!verifyPkce(params.get("code_verifier") ?? "", pending.codeChallenge)) {
      return fail("invalid_grant", "PKCE verification failed.");
    }
    if (!decodeClientId(pending.clientId)) return fail("invalid_client", "Unknown client.");
    let created: ReturnType<typeof store.create>;
    try {
      created = store.create({
        kind: "app",
        label: pending.clientName,
        scope: pending.scope,
        redirectHost: redirectDisplayHost(pending.redirectUri),
        clientKey: createHash("sha256").update(pending.clientId, "utf8").digest("hex"),
      });
    } catch (error) {
      return fail("invalid_request", error instanceof Error ? error.message : String(error));
    }
    captureAdeMcpAnalytics({ analytics, surface: "api", action: "app_connected", outcome: "completed" });
    args.logger?.info?.("remote_mcp.app_connected", {
      connectionId: created.connection.id,
      scope: created.connection.scope,
      redirectHost: created.connection.redirectHost,
    });
    return json(200, {
      access_token: created.token,
      token_type: "Bearer",
      scope: scopeToOAuth(created.connection.scope),
    });
  };

  const handleRegister = (request: RemoteMcpHttpRequest): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "invalid_request" });
    let body: unknown;
    try {
      body = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { error: "invalid_client_metadata", error_description: "Send JSON." });
    }
    const result = registerClient(body);
    if (!result.ok) return json(400, { error: result.error, error_description: result.description });
    return json(201, {
      client_id: result.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: result.client.clientName,
      redirect_uris: result.client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  };

  const handleHttp = async (request: RemoteMcpHttpRequest): Promise<RemoteMcpHttpResponse> => {
    const off = () => json(404, { error: "ade_mcp_off", error_description: "ADE MCP is off on this computer." });
    if (!serving()) return off();
    const accountMount = request.mount?.kind === "account";
    // The account address is answered only for this computer's own account.
    if (request.mount && (!accountMount || request.mount.key !== accountKey())) return off();
    const serverBase = accountMount ? accountBase() : base();
    if (!serverBase) return json(503, { error: "unavailable", error_description: "This computer has no relay address yet." });
    if ((request.body?.length ?? 0) > MAX_REQUEST_BODY_CHARS) return json(413, { error: "Request too large." });
    let url: URL;
    try {
      url = new URL(request.path, "https://relay.invalid");
    } catch {
      return json(400, { error: "Bad path." });
    }
    const route = url.pathname.replace(/\/+$/, "") || "/";
    switch (route) {
      case "/mcp":
        return await handleMcp(request, serverBase, accountMount);
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, protectedResourceMetadata(serverBase, accountMount), { "cache-control": "max-age=300" });
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json(200, authorizationServerMetadata(serverBase), { "cache-control": "max-age=300" });
      case "/oauth/register":
        return handleRegister(request);
      case "/oauth/authorize":
        return handleAuthorize(request, url.searchParams, serverBase);
      case "/oauth/account-callback":
        return await handleAccountCallback(url.searchParams, serverBase);
      case "/oauth/consent":
        return handleConsent(request, serverBase);
      case "/oauth/token":
        return handleToken(request);
      default:
        return json(404, { error: "not_found" });
    }
  };

  // ── Settings ──────────────────────────────────────────────────────────────

  const serverUrl = (): string | null => {
    const account = accountBase();
    return account ? `${account}/mcp` : null;
  };

  const getStatus = async (): Promise<RemoteMcpStatus> => {
    const endpoint = relayEndpoint();
    const isSignedIn = signedIn();
    let machineList: RemoteMcpStatus["machines"] = [];
    if (isSignedIn) {
      try {
        machineList = (await machines.roster()).map((machine) => ({
          machineKey: machine.machineKey,
          name: machine.name,
          included: machine.included,
          supported: machine.supported,
          online: machine.online,
          isThisMachine: machine.isThisMachine,
        }));
      } catch (error) {
        warn("remote_mcp.roster_failed", error);
      }
    }
    return {
      enabled: accountOn(),
      signedIn: isSignedIn,
      serverUrl: isSignedIn ? serverUrl() : null,
      relayConnected: endpoint?.connected === true,
      machineName: args.machineName(),
      thisMachineServing: serving(),
      machines: machineList,
      connections: isSignedIn ? store.list() : [],
    };
  };

  const parseScope = (value: unknown, fallback: RemoteMcpScope): RemoteMcpScope => {
    if (value === undefined || value === null || value === "") return fallback;
    if (isRemoteMcpScope(value)) return value;
    throw new Error("Access must be \"read\" or \"write\".");
  };

  const requireSignedIn = (): void => {
    if (!signedIn()) {
      throw new Error("Sign in to ADE on this computer first: ADE MCP belongs to your ADE account.");
    }
  };

  const SETTINGS_REJECTED = "ADE couldn't save this to your ADE account: the signed-in account changed. Try again.";

  /** The settings store uploads on its next tick; a person's change should reach the other computers now. */
  const pushSettings = (): void => {
    void args.settings.sync().catch((error) => warn("remote_mcp.settings_sync_failed", error));
  };

  return {
    handleHttp,
    getStatus,
    /** Whether this computer answers ADE MCP now (the relay's `mcp_state.enabled`). */
    isEnabled: serving,
    /**
     * The account secret for `mcp_state.account`, only while serving. The
     * relay derives the account key from it, so the brain never names a key.
     */
    accountSecret: (): string | null => (serving() ? accountSecret() : null),
    /** Re-read account state now (after the settings or vault pulled rows). */
    refresh,
    /** The tunnel tells the service where it is reachable. */
    attachRelayEndpoint(resolve: () => RemoteMcpRelayEndpoint | null): void {
      relayEndpoint = resolve;
      startRefreshing();
      refresh();
    },
    /** The machine's product analytics sink, attached with the relay tunnel. */
    attachAnalytics(sink: FeatureAnalytics | null): void {
      analytics = sink;
    },
    /** Called whenever serving or the account secret may have changed. */
    onEnabledChange(listener: (enabled: boolean) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    /** On/off for the whole account. */
    async setEnabled(input: { enabled?: unknown }, surface: ProductAnalyticsSurface = "desktop"): Promise<RemoteMcpStatus> {
      if (typeof input?.enabled !== "boolean") throw new Error("Pass enabled: true or false.");
      requireSignedIn();
      if (input.enabled) await ensureAccountSecret();
      if (!args.settings.set(REMOTE_MCP_SETTINGS_SCOPE, REMOTE_MCP_ENABLED_KEY, input.enabled)) {
        throw new Error(SETTINGS_REJECTED);
      }
      captureAdeMcpAnalytics({
        analytics,
        surface,
        action: "server_toggled",
        outcome: input.enabled ? "enabled" : "disabled",
      });
      args.logger?.info?.("remote_mcp.enabled_changed", { enabled: input.enabled });
      pushSettings();
      announceIfChanged();
      await maintain();
      return await getStatus();
    },
    /** Leaves a computer of the account out of ADE MCP, or brings it back. Any computer may set it. */
    async setMachineIncluded(input: { machineKey?: unknown; machine?: unknown; included?: unknown }): Promise<RemoteMcpStatus> {
      if (typeof input?.included !== "boolean") throw new Error("Pass included: true or false.");
      requireSignedIn();
      // Settings passes the key; `ade mcp machine` may pass a name.
      let machineKey = isRemoteMcpMachineKey(input.machineKey) ? input.machineKey : null;
      const roster = await machines.roster();
      if (!machineKey && typeof input.machine === "string" && input.machine.trim()) {
        const wanted = input.machine.trim().toLowerCase();
        const matches = roster.filter((machine) => machine.machineKey === wanted || machine.name.toLowerCase() === wanted);
        if (matches.length > 1) throw new Error(`More than one computer is called "${input.machine.trim()}". Pass its key instead.`);
        machineKey = matches[0]?.machineKey ?? null;
        if (!machineKey) {
          const names = roster.map((machine) => machine.name).join(", ") || "none";
          throw new Error(`No computer "${input.machine.trim()}" on this ADE account. Computers: ${names}.`);
        }
      }
      if (!machineKey) throw new Error("Pass the computer's machineKey (see getStatus).");
      const existing = readRemoteMcpMachineEntry(args.settings, machineKey);
      const listed = roster.find((machine) => machine.machineKey === machineKey) ?? null;
      if (!existing && !listed) throw new Error("That computer isn't on this ADE account.");
      // A computer that never published gets a stub; it fills in the rest and keeps `included`.
      const ok = writeRemoteMcpMachineEntry(args.settings, {
        machineKey,
        name: existing?.name ?? listed?.name ?? "",
        endpointKey: existing?.endpointKey ?? "",
        version: existing?.version ?? "",
        included: input.included,
        updatedAt: new Date(now()).toISOString(),
      });
      if (!ok) throw new Error(SETTINGS_REJECTED);
      args.logger?.info?.("remote_mcp.machine_included_changed", { machineKey, included: input.included });
      pushSettings();
      announceIfChanged();
      return await getStatus();
    },
    createToken(input: { label?: unknown; scope?: unknown }, surface: ProductAnalyticsSurface = "desktop"): RemoteMcpCreatedToken {
      requireSignedIn();
      const created = store.create({
        kind: "token",
        label: typeof input?.label === "string" ? input.label : "Token",
        scope: parseScope(input?.scope, "write"),
      });
      captureAdeMcpAnalytics({ analytics, surface, action: "token_created", outcome: "completed" });
      args.logger?.info?.("remote_mcp.token_created", { connectionId: created.connection.id, scope: created.connection.scope });
      return { ...created, serverUrl: serverUrl() };
    },
    updateConnection(input: { id?: unknown; scope?: unknown; label?: unknown }): RemoteMcpConnectionSummary {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      requireSignedIn();
      return store.update(input.id, {
        ...(input.scope !== undefined ? { scope: parseScope(input.scope, "write") } : {}),
        ...(typeof input.label === "string" ? { label: input.label } : {}),
      });
    },
    removeConnection(input: { id?: unknown }, surface: ProductAnalyticsSurface = "desktop"): { removed: boolean } {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      requireSignedIn();
      const removed = store.remove(input.id);
      if (removed) {
        lastUsedHere.delete(input.id);
        lastUsedPublished.delete(input.id);
        args.settings.remove(REMOTE_MCP_SETTINGS_SCOPE, remoteMcpLastUsedKey(input.id));
        captureAdeMcpAnalytics({ analytics, surface, action: "connection_removed", outcome: "completed" });
        args.logger?.info?.("remote_mcp.connection_removed", { connectionId: input.id });
      }
      return { removed };
    },
    listActivity(input: { limit?: unknown } = {}): RemoteMcpActivityEntry[] {
      return activity.recent(typeof input?.limit === "number" ? input.limit : 100);
    },
  };
}

/**
 * The one table of what Settings (the `remote_mcp` action domain) and
 * `ade mcp` (the machine method `remoteMcp.call`) may ask the service.
 */
export function remoteMcpActionHandlers(
  service: RemoteMcpService,
  /** Who asked, for product analytics: Settings is `desktop`, `ade mcp` is `api`. */
  surface: ProductAnalyticsSurface,
): Record<RemoteMcpAction, (args: Record<string, unknown>) => unknown> {
  return {
    getStatus: () => service.getStatus(),
    listActivity: (args) => service.listActivity(args),
    setEnabled: (args) => service.setEnabled(args, surface),
    setMachineIncluded: (args) => service.setMachineIncluded(args),
    createToken: (args) => service.createToken(args, surface),
    updateConnection: (args) => service.updateConnection(args),
    removeConnection: (args) => service.removeConnection(args, surface),
  };
}
