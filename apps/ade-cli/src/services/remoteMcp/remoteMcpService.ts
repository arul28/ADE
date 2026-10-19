import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
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
  type RemoteMcpActivityOutcome,
  type RemoteMcpConnectionSummary,
  type RemoteMcpCreatedToken,
  type RemoteMcpScope,
  type RemoteMcpStatus,
} from "../../../../desktop/src/shared/types/remoteMcp";
import {
  checkRemoteAdeCommand,
  describeReadOnlyCommands,
  redactedCommandForLog,
  splitCommandLine,
} from "./remoteMcpCommandPolicy";
import { createRemoteMcpActivityLog } from "./remoteMcpActivityLog";
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
import { DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, runAdeForRemote, type RemoteRunResult } from "./remoteMcpRunner";
import { createRemoteMcpStore } from "./remoteMcpStore";

/**
 * ADE MCP: an MCP server for this computer, reached through ADE Relay.
 *
 * The relay Worker forwards each HTTP request under `/m/<endpointKey>/` over
 * the brain's existing control socket, and returns whatever this answers. All
 * of it happens here: the MCP protocol, OAuth sign-in, token checks, and
 * running the `ade` command. The Worker stores nothing and can mint nothing.
 *
 * Off by default. When off, the brain tells the relay so, and the relay
 * answers 404 without waking this computer.
 */

export type RemoteMcpHttpRequest = {
  method: string;
  /** Path under the machine prefix, with query, e.g. `/oauth/authorize?…`. */
  path: string;
  headers: Record<string, string>;
  body: string | null;
};

export type RemoteMcpHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type RemoteMcpRelayEndpoint = {
  relayUrl: string;
  /** The key in the public URL; not the relay key (see mcpEndpointKeyFor). */
  endpointKey: string;
  connected: boolean;
};

export type RemoteMcpProject = { projectId: string; rootPath: string; displayName: string; lastOpenedAt: number };

export const MAX_CONCURRENT_REMOTE_RUNS = 4;
const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = "ade";

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

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
  storePath: string;
  activityPath: string;
  machineName: () => string;
  listProjects: () => RemoteMcpProject[];
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
}) {
  const store = createRemoteMcpStore({ filePath: args.storePath, logger: args.logger });
  const activity = createRemoteMcpActivityLog({ filePath: args.activityPath, logger: args.logger });
  const authorization = createRemoteMcpAuthorizationState();
  const enabledListeners = new Set<(enabled: boolean) => void>();
  let relayEndpoint: () => RemoteMcpRelayEndpoint | null = () => null;
  let analytics: FeatureAnalytics | null = null;
  let activeRuns = 0;

  const base = (): string | null => {
    const endpoint = relayEndpoint();
    if (!endpoint) return null;
    return `${withoutTrailingSlash(endpoint.relayUrl)}/m/${endpoint.endpointKey}`;
  };

  const notifyEnabled = (enabled: boolean): void => {
    for (const listener of enabledListeners) {
      try {
        listener(enabled);
      } catch (error) {
        args.logger?.warn?.("remote_mcp.enabled_listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const record = (entry: Omit<RemoteMcpActivityEntry, "at">): void => {
    activity.append({ at: new Date().toISOString(), ...entry });
  };

  // ── Projects ──────────────────────────────────────────────────────────────

  const resolveProject = (requested: unknown): { cwd: string } | { error: string } => {
    const projects = args.listProjects();
    if (typeof requested !== "string" || !requested.trim()) {
      const recent = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
      return { cwd: recent?.rootPath ?? os.homedir() };
    }
    const wanted = requested.trim();
    const lower = wanted.toLowerCase();
    const exact = projects.filter((project) =>
      project.projectId === wanted
      || (path.isAbsolute(wanted) && samePathOnPlatform(project.rootPath, wanted)));
    if (exact.length === 1) return { cwd: exact[0]!.rootPath };
    const named = projects.filter((project) =>
      project.displayName.toLowerCase() === lower || path.basename(project.rootPath).toLowerCase() === lower);
    if (named.length === 1) return { cwd: named[0]!.rootPath };
    const known = projects.map((project) => project.displayName).join(", ") || "none";
    return named.length > 1
      ? { error: `More than one project is called "${wanted}". Pass its id or path instead (see ["projects","list","--text"]).` }
      : { error: `No project "${wanted}" on this computer. Projects: ${known}.` };
  };

  // ── MCP ───────────────────────────────────────────────────────────────────

  const toolDefinition = (scope: RemoteMcpScope) => ({
    name: TOOL_NAME,
    title: "Run an ADE command",
    description: [
      `Runs ADE's \`ade\` command on ${args.machineName()} and returns its output.`,
      "Pass the words after `ade` as `args`, e.g. [\"lanes\",\"list\",\"--text\"]. Add --text for readable output.",
      "Start with [\"help\"] to see every command, or [\"help\",\"<command>\"] for one.",
      "Commands run in `project` (a name, id or path from [\"projects\",\"list\",\"--text\"]), or the most recently opened project.",
      scope === "read"
        ? `This connection is READ-ONLY. Allowed: ${describeReadOnlyCommands()}.`
        : "This connection has full access: it can do anything the person could do with `ade` in a terminal.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "The command as a list of words, without the leading `ade`.",
        },
        command: {
          type: "string",
          description: "Instead of `args`: the same command as one string, e.g. \"lanes list --text\". Quotes group words; no shell runs it.",
        },
        project: { type: "string", description: "Project name, id or path. Defaults to the most recently opened project." },
        timeout_seconds: {
          type: "integer",
          minimum: 5,
          maximum: MAX_TIMEOUT_MS / 1000,
          description: `Stop the command after this many seconds. Default ${DEFAULT_TIMEOUT_MS / 1000}.`,
        },
      },
    },
    annotations: {
      title: "Run an ADE command",
      readOnlyHint: scope === "read",
      destructiveHint: scope === "write",
      idempotentHint: false,
      openWorldHint: true,
    },
  });

  const instructions = (scope: RemoteMcpScope): string => [
    `This server is ADE on ${args.machineName()}. ADE manages coding lanes (git worktrees), agent chats, PRs and proof.`,
    "Everything goes through one tool, `ade`, which runs the ade command line on that computer.",
    "Good first calls: [\"doctor\",\"--text\"], [\"projects\",\"list\",\"--text\"], [\"lanes\",\"list\",\"--text\"], [\"help\"].",
    scope === "read" ? "This connection is read-only." : "This connection has full access.",
  ].join("\n");

  const toolText = (result: RemoteRunResult): string => {
    const parts: string[] = [];
    const stdout = result.stdout.trimEnd();
    const stderr = result.stderr.trimEnd();
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stdout ? `stderr:\n${stderr}` : stderr);
    if (result.truncated) parts.push(`[Output was cut off at ${MAX_OUTPUT_BYTES / 1024} KB. Narrow the command, e.g. with --text, filters or --limit.]`);
    if (result.timedOut) parts.push(`[Stopped: the command ran past its time limit after ${Math.round(result.durationMs / 1000)}s.]`);
    else if (result.exitCode !== 0) parts.push(`[exit code ${result.exitCode ?? "unknown"}]`);
    return parts.join("\n\n") || "(no output)";
  };

  const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

  const callTool = async (connection: RemoteMcpConnectionSummary, params: Record<string, unknown>) => {
    if (params.name !== TOOL_NAME) return toolError(`Unknown tool "${String(params.name)}". The only tool is "${TOOL_NAME}".`);
    const input = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    let words: unknown = input.args;
    if (words === undefined && typeof input.command === "string") {
      words = splitCommandLine(input.command);
      if (words === null) return toolError("The command has an unclosed quote.");
    }
    const verdict = checkRemoteAdeCommand(words, connection.scope);
    const logBase = { connectionId: connection.id, label: connection.label, scope: connection.scope };
    const loggedCommand = Array.isArray(words) ? redactedCommandForLog(words.filter((w): w is string => typeof w === "string")) : "";
    if (!verdict.ok) {
      record({ ...logBase, command: loggedCommand, outcome: "refused", exitCode: null, durationMs: 0, detail: verdict.reason });
      return toolError(verdict.reason);
    }
    const project = resolveProject(input.project);
    if ("error" in project) {
      record({ ...logBase, command: loggedCommand, outcome: "refused", exitCode: null, durationMs: 0, detail: project.error });
      return toolError(project.error);
    }
    if (activeRuns >= MAX_CONCURRENT_REMOTE_RUNS) {
      record({ ...logBase, command: loggedCommand, outcome: "busy", exitCode: null, durationMs: 0 });
      return toolError(`This computer is already running ${MAX_CONCURRENT_REMOTE_RUNS} remote commands. Wait for one to finish, then retry.`);
    }
    const timeoutSeconds = typeof input.timeout_seconds === "number" && Number.isFinite(input.timeout_seconds)
      ? input.timeout_seconds
      : DEFAULT_TIMEOUT_MS / 1000;
    activeRuns += 1;
    let result: RemoteRunResult;
    try {
      result = await runAdeForRemote({
        argv: verdict.args,
        cwd: project.cwd,
        timeoutMs: Math.round(timeoutSeconds * 1000),
        connectionId: connection.id,
        role: connection.scope === "write" ? "cto" : "agent",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ ...logBase, command: loggedCommand, outcome: "failed", exitCode: null, durationMs: 0, detail: message });
      return toolError(message);
    } finally {
      activeRuns -= 1;
    }
    const outcome: RemoteMcpActivityOutcome = result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "failed";
    record({ ...logBase, command: loggedCommand, outcome, exitCode: result.exitCode, durationMs: result.durationMs });
    return {
      content: [{ type: "text", text: toolText(result) }],
      isError: result.timedOut || result.exitCode !== 0,
    };
  };

  const handleRpc = async (
    connection: RemoteMcpConnectionSummary,
    message: JsonRpcMessage | null,
  ): Promise<Record<string, unknown> | null> => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } };
    }
    const id = message.id;
    const isRequest = id !== undefined && id !== null && (typeof id === "string" || typeof id === "number");
    const method = typeof message.method === "string" ? message.method : "";
    // Notifications and stray responses need no answer.
    if (!isRequest) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (message.jsonrpc !== "2.0" || !method) return fail(-32600, "Invalid JSON-RPC request.");
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ade", title: `ADE on ${args.machineName()}`, version: "1.0.0" },
          instructions: instructions(connection.scope),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [toolDefinition(connection.scope)] });
      case "tools/call":
        return reply(await callTool(connection, params));
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };

  const unauthorized = (serverBase: string, presented: boolean): RemoteMcpHttpResponse => json(
    401,
    { error: presented ? "invalid_token" : "unauthorized", error_description: "Sign in to ADE on this computer to use it." },
    {
      "www-authenticate": `Bearer resource_metadata="${serverBase}/.well-known/oauth-protected-resource"${presented ? ", error=\"invalid_token\"" : ""}`,
    },
  );

  const handleMcp = async (request: RemoteMcpHttpRequest, serverBase: string): Promise<RemoteMcpHttpResponse> => {
    const authHeader = header(request, "authorization");
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const connection = match ? store.authenticate(match[1]!) : null;
    if (!connection) return unauthorized(serverBase, Boolean(match));
    if (request.method === "GET" || request.method === "DELETE") {
      // Stateless server: no server-initiated stream and no session to end.
      return json(405, { error: "This server answers POST only." }, { allow: "POST" });
    }
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    store.recordUse(connection.id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0 || parsed.length > 20) {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send 1 to 20 messages." } });
      }
      const replies = (await Promise.all(parsed.map((entry) => handleRpc(connection, entry as JsonRpcMessage))))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      return replies.length ? json(200, replies) : { status: 202, headers: {}, body: "" };
    }
    if (!parsed || typeof parsed !== "object") {
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } });
    }
    const replyMessage = await handleRpc(connection, parsed as JsonRpcMessage);
    return replyMessage ? json(200, replyMessage) : { status: 202, headers: {}, body: "" };
  };

  // ── OAuth ─────────────────────────────────────────────────────────────────

  const protectedResourceMetadata = (serverBase: string) => ({
    resource: `${serverBase}/mcp`,
    authorization_servers: [serverBase],
    bearer_methods_supported: ["header"],
    scopes_supported: ["ade:read", "ade:write"],
    resource_name: `ADE on ${args.machineName()}`,
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
    if (query.get("error") || !query.get("code")) {
      authorization.forget(nonce);
      return denyToApp(authRequest, serverBase);
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
      consentPath: `${serverBase}/oauth/consent`,
    }));
  };

  // Step 3: the person chose the access and allowed it.
  const handleConsent = (request: RemoteMcpHttpRequest, serverBase: string): RemoteMcpHttpResponse => {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const params = parseForm(request);
    const taken = authorization.takeConsent(params.get("nonce") ?? "", params.get("csrf") ?? "");
    if (!taken) return expiredSignIn();
    const { request: authRequest } = taken;
    if (params.get("decision") !== "allow") return denyToApp(authRequest, serverBase);
    const scope: RemoteMcpScope = params.get("access") === "read" ? "read" : "write";
    const code = authorization.issueAuthCode({
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      codeChallenge: authRequest.codeChallenge,
      scope,
      clientName: authRequest.client.clientName,
    });
    return redirect(buildRedirect(authRequest.redirectUri, { code, state: authRequest.state, iss: serverBase }));
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
    if (!store.isEnabled()) {
      return json(404, { error: "ade_mcp_off", error_description: "ADE MCP is off on this computer." });
    }
    const serverBase = base();
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
        return await handleMcp(request, serverBase);
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, protectedResourceMetadata(serverBase), { "cache-control": "max-age=300" });
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

  const getStatus = (): RemoteMcpStatus => {
    const endpoint = relayEndpoint();
    const serverBase = base();
    return {
      enabled: store.isEnabled(),
      serverUrl: serverBase ? `${serverBase}/mcp` : null,
      relayConnected: endpoint?.connected === true,
      machineName: args.machineName(),
      connections: store.list(),
    };
  };

  const parseScope = (value: unknown, fallback: RemoteMcpScope): RemoteMcpScope => {
    if (value === undefined || value === null || value === "") return fallback;
    if (isRemoteMcpScope(value)) return value;
    throw new Error("Access must be \"read\" or \"write\".");
  };

  return {
    handleHttp,
    getStatus,
    isEnabled: () => store.isEnabled(),
    /** The tunnel tells the service where it is reachable. */
    attachRelayEndpoint(resolve: () => RemoteMcpRelayEndpoint | null): void {
      relayEndpoint = resolve;
    },
    /** The machine's product analytics sink, attached with the relay tunnel. */
    attachAnalytics(sink: FeatureAnalytics | null): void {
      analytics = sink;
    },
    onEnabledChange(listener: (enabled: boolean) => void): () => void {
      enabledListeners.add(listener);
      return () => enabledListeners.delete(listener);
    },
    setEnabled(input: { enabled?: unknown }, surface: ProductAnalyticsSurface = "desktop"): RemoteMcpStatus {
      if (typeof input?.enabled !== "boolean") throw new Error("Pass enabled: true or false.");
      store.setEnabled(input.enabled);
      captureAdeMcpAnalytics({
        analytics,
        surface,
        action: "server_toggled",
        outcome: input.enabled ? "enabled" : "disabled",
      });
      args.logger?.info?.("remote_mcp.enabled_changed", { enabled: input.enabled });
      notifyEnabled(input.enabled);
      return getStatus();
    },
    createToken(input: { label?: unknown; scope?: unknown }, surface: ProductAnalyticsSurface = "desktop"): RemoteMcpCreatedToken {
      const created = store.create({
        kind: "token",
        label: typeof input?.label === "string" ? input.label : "Token",
        scope: parseScope(input?.scope, "write"),
      });
      captureAdeMcpAnalytics({ analytics, surface, action: "token_created", outcome: "completed" });
      args.logger?.info?.("remote_mcp.token_created", { connectionId: created.connection.id, scope: created.connection.scope });
      return { ...created, serverUrl: getStatus().serverUrl };
    },
    updateConnection(input: { id?: unknown; scope?: unknown; label?: unknown }): RemoteMcpConnectionSummary {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      return store.update(input.id, {
        ...(input.scope !== undefined ? { scope: parseScope(input.scope, "write") } : {}),
        ...(typeof input.label === "string" ? { label: input.label } : {}),
      });
    },
    removeConnection(input: { id?: unknown }, surface: ProductAnalyticsSurface = "desktop"): { removed: boolean } {
      if (typeof input?.id !== "string") throw new Error("Pass the connection id.");
      const removed = store.remove(input.id);
      if (removed) {
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
    createToken: (args) => service.createToken(args, surface),
    updateConnection: (args) => service.updateConnection(args),
    removeConnection: (args) => service.removeConnection(args, surface),
  };
}
