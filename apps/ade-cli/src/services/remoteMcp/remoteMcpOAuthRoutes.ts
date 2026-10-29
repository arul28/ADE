import { createHash, randomUUID } from "node:crypto";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import type {
  RemoteMcpConnectionSummary,
  RemoteMcpKnownApp,
  RemoteMcpScope,
} from "../../../../desktop/src/shared/types/remoteMcp";
import { AccountAttestationError, verifyClerkAccountAttestation } from "../account/accountAttestationVerifier";
import type { AccountAttestationConfig } from "../account/sharedAccountAuthService";
import {
  createRemoteMcpReplayGuard,
  describeNetworkError,
  fetchOnFreshConnection,
  fetchThroughRelayWithRetry,
  header,
  json,
  REMOTE_MCP_CALL_ID_HEADER,
  requestCallId,
  withoutTrailingSlash,
  type RemoteMcpHttpRequest,
  type RemoteMcpHttpResponse,
  type RemoteMcpRelayEndpoint,
} from "./remoteMcpHttp";
import {
  AUTHORIZE_PAGE_HEADERS,
  authorizeAppName,
  buildRedirect,
  createRemoteMcpAuthorizationState,
  decodeClientId,
  parseAuthorizeRequest,
  redirectDisplayHost,
  registerClient,
  renderConsentPage,
  renderMessagePage,
  renderSignInPage,
  scopeToOAuth,
  verifyPkce,
  type AuthorizeRequest,
  type SignedInAccount,
  type SignInTarget,
} from "./remoteMcpOAuth";
import { REMOTE_MCP_KEY_PATTERN } from "./remoteMcpAccount";
import { REMOTE_MCP_VIA_HEADER, encodeViaHeader } from "./remoteMcpForward";

/**
 * ADE MCP's OAuth routes: the metadata an app reads, dynamic registration,
 * and the sign-in an app sends the person through (authorize → ADE sign-in →
 * consent → token). The pure parts (parsing, PKCE, the pages, the pending
 * sign-ins) are in remoteMcpOAuth.ts; this wires them to one computer.
 */

/** The ADE account this computer is signed in to, and how to check one. */
export type RemoteMcpAccountAccess = {
  signedIn: () => SignedInAccount | null;
  oauth: () => { issuer: string; clientId: string } | null;
  attestation: () => AccountAttestationConfig | null;
};

/** Pending web sign-ins remember which address (account or machine) they began on. */
const SIGN_IN_ISSUER_TTL_MS = 15 * 60_000;
const MAX_SIGN_IN_ISSUERS = 64;
const ACCOUNT_CODE_EXCHANGE_TIMEOUT_MS = 10_000;
const TOKEN_FORWARD_TIMEOUT_MS = 15_000;
/** A forwarded token exchange that is retried within this long gets the first one's answer. */
const TOKEN_REPLAY_TTL_MS = 2 * 60_000;

function html(status: number, body: string): RemoteMcpHttpResponse {
  return { status, headers: { ...AUTHORIZE_PAGE_HEADERS }, body };
}

function redirect(location: string): RemoteMcpHttpResponse {
  return { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" };
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

export function createRemoteMcpOAuthRoutes(deps: {
  machineName: () => string;
  /** The computers an app on the account address reaches, by name, for the sign-in pages. */
  accountMachineNames: () => string[];
  account: RemoteMcpAccountAccess;
  relayEndpoint: () => RemoteMcpRelayEndpoint | null;
  /** `https://<relay>/m/<endpointKey>`: this computer only, where its pending sign-ins live. */
  machineBase: () => string | null;
  /** Makes the app's connection once the person allowed it; throws when it can't. */
  connectApp: (input: {
    label: string;
    scope: RemoteMcpScope;
    redirectHost: string;
    app: RemoteMcpKnownApp | null;
    clientKey: string;
    legacyClientKey: string;
    /** Reaches only this computer: the sign-in began on its own address. */
    thisMachineOnly: boolean;
  }) => { token: string; connection: RemoteMcpConnectionSummary };
  logger?: { warn?: (event: string, data?: Record<string, unknown>) => void };
  fetchImpl?: typeof fetch;
  now: () => number;
}) {
  const authorization = createRemoteMcpAuthorizationState();

  // A web sign-in can begin on the account address but always comes back to
  // this computer (the Clerk state names its endpoint key). The `iss` an app
  // gets back must be the issuer it started with, so remember it per sign-in.
  // (What the sign-in grants, the account or this computer, rides on the
  // pending sign-in itself.)
  const signInIssuers = new Map<string, { issuer: string; at: number }>();
  const rememberIssuer = (nonce: string, issuer: string): void => {
    for (const [key, value] of signInIssuers) {
      if (deps.now() - value.at > SIGN_IN_ISSUER_TTL_MS || signInIssuers.size >= MAX_SIGN_IN_ISSUERS) signInIssuers.delete(key);
    }
    signInIssuers.set(nonce, { issuer, at: deps.now() });
  };
  const issuerFor = (nonce: string, fallback: string): string => signInIssuers.get(nonce)?.issuer ?? fallback;

  const signInTarget = (accountMount: boolean): SignInTarget => (accountMount
    ? { kind: "account", machineNames: deps.accountMachineNames() }
    : { kind: "machine", name: deps.machineName() });

  // A forwarded token exchange the sender retried: answered once.
  const tokenReplays = createRemoteMcpReplayGuard<RemoteMcpHttpResponse>({ ttlMs: TOKEN_REPLAY_TTL_MS, now: deps.now });

  const protectedResourceMetadata = (serverBase: string, accountMount: boolean) => ({
    resource: `${serverBase}/mcp`,
    authorization_servers: [serverBase],
    bearer_methods_supported: ["header"],
    scopes_supported: ["ade:read", "ade:write"],
    resource_name: accountMount ? "ADE" : `ADE on ${deps.machineName()}`,
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
    const endpoint = deps.relayEndpoint();
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
  const handleAuthorize = (
    request: RemoteMcpHttpRequest,
    query: URLSearchParams,
    serverBase: string,
    accountMount: boolean,
  ): RemoteMcpHttpResponse => {
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
    const machineName = deps.machineName();
    const oauth = deps.account.oauth();
    const callbackUrl = accountCallbackUrl();
    const endpoint = deps.relayEndpoint();
    const ready = oauth && deps.account.attestation() && callbackUrl && endpoint
      ? { oauth, callbackUrl, endpoint }
      : null;
    const unavailable = !deps.account.signedIn()
      ? `${machineName} isn't signed in to an ADE account. Sign in to ADE on it, then try again.`
      : !ready
        ? `${machineName} can't check ADE sign-ins right now. Update ADE on it, then try again.`
        : null;
    const target = signInTarget(accountMount);
    if (!isPost) return html(200, renderSignInPage({ request: authRequest, target, error: unavailable }));
    if (params.get("decision") === "deny") return denyToApp(authRequest, serverBase);
    if (unavailable || !ready) {
      return html(409, renderSignInPage({ request: authRequest, target, error: unavailable }));
    }
    const { nonce, accountChallenge } = authorization.beginSignIn(authRequest, accountMount);
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
    const oauth = deps.account.oauth();
    const callbackUrl = accountCallbackUrl();
    if (!oauth || !callbackUrl) throw new Error("ADE sign-in isn't configured on this computer.");
    const response = await (deps.fetchImpl ?? fetch)(`${withoutTrailingSlash(oauth.issuer)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: oauth.clientId,
        redirect_uri: callbackUrl,
      }).toString(),
      signal: AbortSignal.timeout(ACCOUNT_CODE_EXCHANGE_TIMEOUT_MS),
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
    const owner = deps.account.signedIn();
    const attestation = deps.account.attestation();
    if (!owner || !attestation) {
      authorization.forget(nonce);
      return html(409, renderMessagePage("Can't connect", `${deps.machineName()} isn't signed in to an ADE account.`));
    }
    try {
      const token = await exchangeAccountCode(query.get("code")!, pending.accountVerifier);
      await verifyClerkAccountAttestation({ token, expectedUserId: owner.userId, config: attestation });
    } catch (error) {
      authorization.forget(nonce);
      const mismatch = error instanceof AccountAttestationError && error.code === "account_mismatch";
      deps.logger?.warn?.("remote_mcp.account_sign_in_failed", {
        reason: error instanceof AccountAttestationError ? error.code : "exchange_failed",
      });
      return html(mismatch ? 403 : 502, renderMessagePage(
        mismatch ? "Different ADE account" : "Couldn't check your sign-in",
        mismatch
          ? `${deps.machineName()} belongs to ${owner.email ?? "another ADE account"}. Sign in with that account to connect apps to it.`
          : "ADE couldn't confirm your sign-in. Go back to the app and try again.",
      ));
    }
    const csrf = authorization.markSignedIn(nonce, owner);
    if (!csrf) return expiredSignIn();
    return html(200, renderConsentPage({
      request: authRequest,
      target: signInTarget(pending.accountMount),
      account: owner,
      nonce,
      csrf,
      // The pending sign-in lives on this computer: post back to it, not the account address.
      consentPath: `${deps.machineBase() ?? serverBase}/oauth/consent`,
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
    // What the allow page said it grants: the account, or this computer only.
    const { request: authRequest, accountMount } = taken;
    if (params.get("decision") !== "allow") return denyToApp(authRequest, issuer);
    const scope: RemoteMcpScope = params.get("access") === "read" ? "read" : "write";
    const issued = authorization.issueAuthCode({
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      codeChallenge: authRequest.codeChallenge,
      scope,
      clientName: authorizeAppName(authRequest),
      app: authRequest.app,
      thisMachineOnly: !accountMount,
    });
    // The code names this computer, which holds it: if the relay sends the
    // app's token request to another computer, that one hands it back here.
    const endpoint = deps.relayEndpoint();
    const code = endpoint ? `${endpoint.endpointKey}.${issued}` : issued;
    return redirect(buildRedirect(authRequest.redirectUri, { code, state: authRequest.state, iss: issuer }));
  };

  /**
   * Sends a token request for a code another computer issued to that
   * computer. One hop. The code is single use, so the request is tried again
   * only when the first try never left this computer; its call id lets a
   * holder that does see it twice redeem the code once.
   */
  const forwardToken = async (request: RemoteMcpHttpRequest, endpointKey: string): Promise<RemoteMcpHttpResponse> => {
    const endpoint = deps.relayEndpoint();
    if (!endpoint || header(request, REMOTE_MCP_VIA_HEADER)) {
      return json(400, { error: "invalid_grant", error_description: "The authorization code is unknown, used, or expired." });
    }
    try {
      // A fresh connection: the exchange is never retried after it may have
      // been sent, so it must not go out on a socket the relay closed while idle.
      const response = await fetchThroughRelayWithRetry(deps.fetchImpl ?? fetchOnFreshConnection, `${withoutTrailingSlash(endpoint.relayUrl)}/m/${endpointKey}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": header(request, "content-type") || "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "ADE MCP",
          [REMOTE_MCP_VIA_HEADER]: encodeViaHeader(deps.machineName()),
          [REMOTE_MCP_CALL_ID_HEADER]: randomUUID(),
        },
        body: request.body ?? "",
      }, TOKEN_FORWARD_TIMEOUT_MS, { retryAfterSend: false });
      return json(response.status, await response.json().catch(() => ({ error: "server_error" })));
    } catch (error) {
      deps.logger?.warn?.("remote_mcp.token_forward_failed", { error: getErrorMessage(error) });
      return json(503, {
        error: "temporarily_unavailable",
        error_description: `${describeNetworkError(error, "the computer that holds this sign-in")} If it keeps failing, connect again.`,
      });
    }
  };

  const handleToken = async (request: RemoteMcpHttpRequest): Promise<RemoteMcpHttpResponse> => {
    if (request.method !== "POST") return json(405, { error: "invalid_request" });
    // A token request another computer forwarded and retried: the code is
    // single use, so the retry gets the first exchange's answer. Keyed by the
    // body too, so a call id never answers a different request.
    const callId = header(request, REMOTE_MCP_VIA_HEADER) ? requestCallId(request) : null;
    if (callId) {
      const key = `${callId}:${createHash("sha256").update(request.body ?? "", "utf8").digest("hex")}`;
      return await tokenReplays.run(key, () => exchangeToken(request));
    }
    return await exchangeToken(request);
  };

  const exchangeToken = async (request: RemoteMcpHttpRequest): Promise<RemoteMcpHttpResponse> => {
    const params = parseForm(request);
    const fail = (error: string, description: string, status = 400) =>
      json(status, { error, error_description: description });
    if (params.get("grant_type") !== "authorization_code") {
      return fail("unsupported_grant_type", "Only authorization_code is supported.");
    }
    const presented = params.get("code") ?? "";
    const dot = presented.indexOf(".");
    const issuer = dot > 0 ? presented.slice(0, dot) : null;
    if (issuer && REMOTE_MCP_KEY_PATTERN.test(issuer) && issuer !== deps.relayEndpoint()?.endpointKey) {
      return await forwardToken(request, issuer);
    }
    const pending = authorization.takeAuthCode(dot > 0 ? presented.slice(dot + 1) : presented);
    if (!pending) return fail("invalid_grant", "The authorization code is unknown, used, or expired.");
    const clientId = params.get("client_id");
    if (clientId && clientId !== pending.clientId) return fail("invalid_grant", "The code was issued to another client.");
    const redirectUri = params.get("redirect_uri");
    if (redirectUri && redirectUri !== pending.redirectUri) return fail("invalid_grant", "redirect_uri does not match.");
    if (!verifyPkce(params.get("code_verifier") ?? "", pending.codeChallenge)) {
      return fail("invalid_grant", "PKCE verification failed.");
    }
    if (!decodeClientId(pending.clientId)) return fail("invalid_client", "Unknown client.");
    let created: ReturnType<typeof deps.connectApp>;
    try {
      // A sign-in on this computer's own address replaces only an earlier one
      // there, and an account sign-in only an account one: an app can hold
      // both addresses, each with its own token.
      const machineKey = deps.relayEndpoint()?.machineKey ?? "";
      const where = pending.thisMachineOnly ? `\nmachine:${machineKey}` : "";
      created = deps.connectApp({
        label: pending.clientName,
        scope: pending.scope,
        redirectHost: redirectDisplayHost(pending.redirectUri),
        app: pending.app?.app ?? null,
        // The registration and the return address: one registration can serve several apps.
        clientKey: createHash("sha256").update(`${pending.clientId}\n${pending.redirectUri}${where}`, "utf8").digest("hex"),
        legacyClientKey: createHash("sha256").update(pending.clientId, "utf8").digest("hex"),
        thisMachineOnly: pending.thisMachineOnly,
      });
    } catch (error) {
      return fail("invalid_request", getErrorMessage(error));
    }
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
      client_id_issued_at: Math.floor(deps.now() / 1000),
      client_name: result.client.clientName,
      redirect_uris: result.client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  };

  return {
    /** Answers one of the OAuth or metadata routes; null when `route` is not one of them. */
    async handle(
      route: string,
      request: RemoteMcpHttpRequest,
      query: URLSearchParams,
      serverBase: string,
      accountMount: boolean,
    ): Promise<RemoteMcpHttpResponse | null> {
      switch (route) {
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return json(200, protectedResourceMetadata(serverBase, accountMount), { "cache-control": "max-age=300" });
        case "/.well-known/oauth-authorization-server":
        case "/.well-known/openid-configuration":
          return json(200, authorizationServerMetadata(serverBase), { "cache-control": "max-age=300" });
        case "/oauth/register":
          return handleRegister(request);
        case "/oauth/authorize":
          return handleAuthorize(request, query, serverBase, accountMount);
        case "/oauth/account-callback":
          return await handleAccountCallback(query, serverBase);
        case "/oauth/consent":
          return handleConsent(request, serverBase);
        case "/oauth/token":
          return await handleToken(request);
        default:
          return null;
      }
    },
  };
}
