import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RemoteMcpScope } from "../../../../desktop/src/shared/types/remoteMcp";
import { recogniseRemoteMcpApp, type RecognisedRemoteMcpApp } from "./remoteMcpKnownApps";
import { cleanRemoteMcpLabel } from "./remoteMcpStore";

/**
 * The OAuth half of ADE MCP, run entirely on this computer.
 *
 * MCP apps (claude.ai, ChatGPT, Cursor, VS Code, Claude Code) sign in with
 * OAuth 2.1 + PKCE and register themselves first (dynamic client
 * registration). The relay only carries these requests; it holds no key and
 * cannot mint anything.
 *
 * What proves the person approved is their ADE account: the sign-in page sends
 * them to ADE's own sign-in (Clerk, the "ADE CLI" public client), Clerk sends
 * them back through the relay's one fixed callback, and this computer redeems
 * that code itself with a PKCE verifier only it holds, then checks the account
 * is the one this computer is signed in to. Only then does the person choose
 * the access level and accept.
 *
 * Registration is stateless: the client id IS the registration (its redirect
 * URIs and name, encoded). Open registration grants nothing by itself, since
 * every client is public and must still pass the account sign-in, so there is
 * no table to fill up or lose on restart.
 */

const CLIENT_ID_PREFIX = "ade1.";
const MAX_CLIENT_ID_CHARS = 4_096;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_CHARS = 1_024;
const MAX_STATE_CHARS = 1_024;
const PKCE_CHALLENGE = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:"]);

/** How long a person has to finish the ADE sign-in and accept. */
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGN_INS = 20;
const AUTH_CODE_TTL_MS = 2 * 60_000;

type RegisteredClient = {
  redirectUris: string[];
  clientName: string;
};

export function scopeToOAuth(scope: RemoteMcpScope): string {
  return scope === "write" ? "ade:read ade:write" : "ade:read";
}

/** A requested OAuth scope string → our scope. Asking for nothing means full access. */
function scopeFromOAuth(value: string | null | undefined): RemoteMcpScope {
  const words = (value ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "write";
  return words.includes("ade:write") ? "write" : "read";
}

/**
 * Whether a redirect URI may receive an authorization code. HTTPS anywhere,
 * plain HTTP only on loopback (desktop apps' local callback servers), and
 * private-use schemes (`cursor://`, `vscode://`). Never a scheme that runs or
 * reads anything in the browser.
 */
function isAllowedRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  const scheme = url.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(scheme)) return false;
  if (scheme === "https:") return Boolean(url.hostname);
  if (scheme === "http:") {
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(scheme);
}

/** The host a code goes to, for the sign-in page and Settings. */
export function redirectDisplayHost(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return `${url.protocol}//${url.host}`.replace(/\/\/$/, "");
  } catch {
    return "unknown";
  }
}

function cleanClientName(value: unknown): string {
  return cleanRemoteMcpLabel(value, "AI app");
}

type RegistrationResult =
  | { ok: true; clientId: string; client: RegisteredClient }
  | { ok: false; error: string; description: string };

/** RFC 7591 registration. Returns the stateless client id. */
export function registerClient(body: unknown): RegistrationResult {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!record) return { ok: false, error: "invalid_client_metadata", description: "Send the registration as a JSON object." };
  const uris = record.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `Send between 1 and ${MAX_REDIRECT_URIS} redirect_uris.`,
    };
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description: "Each redirect URI must be HTTPS, a loopback HTTP address, or an app scheme, with no fragment.",
      };
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }
  const authMethod = record.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "Only public clients are supported: token_endpoint_auth_method must be \"none\".",
    };
  }
  const client: RegisteredClient = { redirectUris, clientName: cleanClientName(record.client_name) };
  const clientId = encodeClientId(client);
  if (clientId.length > MAX_CLIENT_ID_CHARS) {
    return { ok: false, error: "invalid_client_metadata", description: "The registration is too large." };
  }
  return { ok: true, clientId, client };
}

function encodeClientId(client: RegisteredClient): string {
  return CLIENT_ID_PREFIX + Buffer.from(JSON.stringify({ r: client.redirectUris, n: client.clientName }), "utf8")
    .toString("base64url");
}

/** The registration a client id carries, re-validated; null when it is not one of ours. */
export function decodeClientId(clientId: string | null | undefined): RegisteredClient | null {
  if (!clientId || !clientId.startsWith(CLIENT_ID_PREFIX) || clientId.length > MAX_CLIENT_ID_CHARS) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientId.slice(CLIENT_ID_PREFIX.length), "base64url").toString("utf8")) as {
      r?: unknown;
      n?: unknown;
    };
    if (!Array.isArray(parsed.r) || parsed.r.length === 0 || parsed.r.length > MAX_REDIRECT_URIS) return null;
    const redirectUris = parsed.r.filter((uri): uri is string => typeof uri === "string" && isAllowedRedirectUri(uri));
    if (redirectUris.length !== parsed.r.length) return null;
    return { redirectUris, clientName: cleanClientName(parsed.n) };
  } catch {
    return null;
  }
}

export type AuthorizeRequest = {
  clientId: string;
  client: RegisteredClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  requestedScope: RemoteMcpScope;
  /** The app ADE recognised from the redirect URI (and name); null when it is not one ADE knows. */
  app: RecognisedRemoteMcpApp | null;
};

/** What the pages and the connection call the app: the recognised name, else the name it registered. */
export function authorizeAppName(request: Pick<AuthorizeRequest, "app" | "client">): string {
  return request.app?.name ?? request.client.clientName;
}

type AuthorizeParse =
  | { ok: true; request: AuthorizeRequest }
  /** Shown on our page: the redirect URI is not trusted, so nothing is sent to it. */
  | { ok: false; kind: "page"; message: string }
  /** Sent back to the app's redirect URI, which is trusted. */
  | { ok: false; kind: "redirect"; redirectUri: string; state: string | null; error: string; description: string };

/** Validates authorize parameters from the query (GET) or the form (POST). */
export function parseAuthorizeRequest(params: URLSearchParams): AuthorizeParse {
  const clientId = params.get("client_id") ?? "";
  const client = decodeClientId(clientId);
  if (!client) {
    return {
      ok: false,
      kind: "page",
      message: "This app's registration isn't valid here. Remove the connector in the app and add it again.",
    };
  }
  const requested = params.get("redirect_uri");
  let redirectUri: string;
  if (requested) {
    if (!client.redirectUris.includes(requested)) {
      return { ok: false, kind: "page", message: "This app asked to return to an address it didn't register." };
    }
    redirectUri = requested;
  } else if (client.redirectUris.length === 1) {
    redirectUri = client.redirectUris[0]!;
  } else {
    return { ok: false, kind: "page", message: "This app didn't say where to return after signing in." };
  }
  const state = params.get("state");
  if (state !== null && state.length > MAX_STATE_CHARS) {
    return { ok: false, kind: "page", message: "This sign-in request is too large." };
  }
  const fail = (error: string, description: string): AuthorizeParse => ({
    ok: false,
    kind: "redirect",
    redirectUri,
    state,
    error,
    description,
  });
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!PKCE_CHALLENGE.test(codeChallenge)) return fail("invalid_request", "PKCE code_challenge is required.");
  if ((params.get("code_challenge_method") ?? "") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  return {
    ok: true,
    request: {
      clientId,
      client,
      redirectUri,
      codeChallenge,
      state,
      requestedScope: scopeFromOAuth(params.get("scope")),
      app: recogniseRemoteMcpApp(redirectUri, client.clientName),
    },
  };
}

export function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time string comparison for secrets of any length. */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  return PKCE_VERIFIER.test(verifier) && sameSecret(pkceChallengeFor(verifier), challenge);
}

export type SignedInAccount = { userId: string; email: string | null; name: string | null };

type PendingSignIn = {
  request: AuthorizeRequest;
  /** PKCE verifier for the ADE (Clerk) leg. Never leaves this computer. */
  accountVerifier: string;
  /** Began on the account address; false on this computer's own (what its pages promise). */
  accountMount: boolean;
  expiresAt: number;
  /** Set once the ADE sign-in checked out; the accept form must echo it. */
  consent: { csrf: string; account: SignedInAccount } | null;
};

type PendingAuthCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: RemoteMcpScope;
  /** The connection's label: the recognised app's name, else the registered one. */
  clientName: string;
  app: RecognisedRemoteMcpApp | null;
  /**
   * The sign-in began on this computer's own address (`/m/<endpointKey>`),
   * whose pages say it uses ADE on this computer: the connection reaches
   * only this computer. False on the account address.
   */
  thisMachineOnly: boolean;
  expiresAt: number;
};

/**
 * In-memory, single-use state for signing apps in: sign-ins waiting on the
 * ADE account step or on the person's accept, and authorization codes waiting
 * to be exchanged. A brain restart forgets them, which only means signing in
 * again.
 */
export function createRemoteMcpAuthorizationState() {
  const now = (): number => Date.now();
  const signIns = new Map<string, PendingSignIn>();
  const authCodes = new Map<string, PendingAuthCode>();

  const sweep = (): void => {
    const at = now();
    for (const [nonce, pending] of signIns) if (pending.expiresAt <= at) signIns.delete(nonce);
    for (const [code, pending] of authCodes) if (pending.expiresAt <= at) authCodes.delete(code);
  };

  return {
    /** Starts the ADE account leg. The oldest unfinished sign-in is dropped past the cap. */
    beginSignIn(request: AuthorizeRequest, accountMount: boolean): { nonce: string; accountChallenge: string } {
      sweep();
      while (signIns.size >= MAX_PENDING_SIGN_INS) {
        const oldest = signIns.keys().next().value;
        if (oldest === undefined) break;
        signIns.delete(oldest);
      }
      const nonce = randomBytes(24).toString("base64url");
      const accountVerifier = randomBytes(48).toString("base64url");
      signIns.set(nonce, { request, accountVerifier, accountMount, expiresAt: now() + SIGN_IN_TTL_MS, consent: null });
      return { nonce, accountChallenge: pkceChallengeFor(accountVerifier) };
    },

    /** The sign-in waiting on the ADE account step, or null. */
    pendingAccountStep(nonce: string): { request: AuthorizeRequest; accountVerifier: string; accountMount: boolean } | null {
      sweep();
      const pending = signIns.get(nonce);
      return pending && !pending.consent
        ? { request: pending.request, accountVerifier: pending.accountVerifier, accountMount: pending.accountMount }
        : null;
    },

    /** The ADE account checked out: the person may now accept. Returns the form's CSRF value. */
    markSignedIn(nonce: string, account: SignedInAccount): string | null {
      const pending = signIns.get(nonce);
      if (!pending || pending.consent) return null;
      const csrf = randomBytes(24).toString("base64url");
      pending.consent = { csrf, account };
      return csrf;
    },

    /** Drops a sign-in (failed account step, or the person cancelled). */
    forget(nonce: string): void {
      signIns.delete(nonce);
    },

    /** Single use: the accept form spends the sign-in whatever happens next. */
    takeConsent(nonce: string, csrf: string): { request: AuthorizeRequest; account: SignedInAccount; accountMount: boolean } | null {
      sweep();
      const pending = signIns.get(nonce);
      signIns.delete(nonce);
      if (!pending?.consent || !sameSecret(pending.consent.csrf, csrf)) return null;
      return { request: pending.request, account: pending.consent.account, accountMount: pending.accountMount };
    },

    issueAuthCode(pending: Omit<PendingAuthCode, "expiresAt">): string {
      sweep();
      const code = randomBytes(32).toString("base64url");
      authCodes.set(code, { ...pending, expiresAt: now() + AUTH_CODE_TTL_MS });
      return code;
    },

    /** Single use: the code is gone whether or not the exchange succeeds. */
    takeAuthCode(code: string): PendingAuthCode | null {
      sweep();
      const pending = authCodes.get(code) ?? null;
      authCodes.delete(code);
      return pending;
    },
  };
}

// ── Pages ───────────────────────────────────────────────────────────────────
// ADE's sign-in look (docs/design/visual-language.md, "Sign-in"): a glass card
// over the ADE mesh, the mark without a box, one heading, the buttons. Values
// follow the default theme (styles/foundation.css) and launchGateGlass.css.

const ADE_LOGO_URL = "https://app.ade-app.dev/logo.png";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
:root{color-scheme:dark;--bg:#0C0B10;--fg:#F0F0F2;--accent:#A78BFA;--t2:color-mix(in srgb,var(--fg) 66%,transparent);--t3:color-mix(in srgb,var(--fg) 46%,transparent);--chip:color-mix(in srgb,var(--fg) 7%,transparent);--chip-h:color-mix(in srgb,var(--fg) 12%,transparent);--edge:color-mix(in srgb,var(--fg) 12%,transparent);--warn:#F59E0B}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;
background-image:radial-gradient(60% 50% at 20% 15%,color-mix(in srgb,var(--accent) 34%,transparent),transparent 70%),radial-gradient(55% 50% at 85% 80%,color-mix(in srgb,#6D28D9 30%,transparent),transparent 70%),radial-gradient(42% 46% at 50% 50%,color-mix(in srgb,var(--bg) 22%,transparent),transparent 72%)}
.card{position:relative;width:min(420px,100%);padding:34px 30px 24px;border-radius:24px;border:1px solid var(--edge);text-align:center;
background:linear-gradient(180deg,color-mix(in srgb,var(--fg) 10%,transparent),color-mix(in srgb,var(--fg) 3%,transparent)),color-mix(in srgb,var(--bg) 24%,transparent);
backdrop-filter:blur(32px) saturate(1.3);-webkit-backdrop-filter:blur(32px) saturate(1.3);
box-shadow:inset 0 1px 0 color-mix(in srgb,white 22%,transparent),0 40px 90px -30px rgba(0,0,0,.7),0 12px 32px -18px rgba(0,0,0,.5)}
.mark{display:block;margin:0 auto;height:30px;width:auto;filter:drop-shadow(0 6px 18px rgba(0,0,0,.35))}
h1{margin:14px 0 6px;font-size:24px;line-height:1.2;font-weight:600;letter-spacing:-.01em}
.sub{margin:0 auto;max-width:330px;font-size:13.5px;color:var(--t2)}
.sub strong{color:var(--fg);font-weight:600}
.who{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:4px 10px;border-radius:999px;background:var(--chip);font-size:12px;color:var(--t2)}
.choices{display:grid;gap:8px;margin:22px 0 4px;text-align:left}
.choice{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:13px;border:1px solid var(--edge);background:var(--chip);cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease}
.choice:hover{background:var(--chip-h)}
.choice input{margin:3px 0 0;accent-color:var(--accent)}
.choice:has(input:checked){border-color:color-mix(in srgb,var(--accent) 60%,transparent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.choice b{display:block;font-size:13.5px;font-weight:600}
.choice span{display:block;font-size:12.5px;color:var(--t3);margin-top:1px}
.actions{display:flex;flex-direction:column;gap:8px;margin-top:22px}
button,.btn{appearance:none;width:100%;height:46px;border-radius:13px;font-family:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none}
.primary{border:0;background:var(--fg);color:var(--bg);box-shadow:inset 0 1px 0 color-mix(in srgb,white 35%,transparent),0 14px 30px -14px color-mix(in srgb,var(--accent) 70%,transparent)}
.primary:hover{box-shadow:inset 0 1px 0 color-mix(in srgb,white 35%,transparent),0 18px 36px -14px color-mix(in srgb,var(--accent) 85%,transparent)}
.link{height:auto;padding:6px;border:0;background:none;color:var(--t3);font-weight:500;font-size:13px}
.link:hover{color:var(--fg)}
.notice{display:flex;gap:8px;align-items:flex-start;margin-top:18px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--warn) 12%,transparent);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);text-align:left;font-size:13px}
.fine{margin:18px 0 0;font-size:12px;color:var(--t3)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main class="card"><img class="mark" src="${ADE_LOGO_URL}" alt="ADE" width="62" height="30">${body}</main></body></html>`;
}

export const AUTHORIZE_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // No form-action: browsers apply it to the redirect after the form posts,
  // which would block the hop to ADE sign-in and back to the app.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https://app.ade-app.dev; frame-ancestors 'none'; base-uri 'none'",
};

function hidden(name: string, value: string | null): string {
  return value === null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/**
 * What the app gets: the whole account (the account address: every computer
 * the person includes, now and later) or one computer (its own address).
 */
export type SignInTarget =
  | { kind: "account"; machineNames: readonly string[] }
  | { kind: "machine"; name: string };

const MAX_LISTED_MACHINES = 6;

function computerList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_LISTED_MACHINES).map((name) => `<strong>${escapeHtml(name)}</strong>`);
  const more = names.length - shown.length;
  if (more > 0) shown.push(`${more} more`);
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function appLine(request: AuthorizeRequest, target: SignInTarget): string {
  const appName = escapeHtml(authorizeAppName(request));
  const host = escapeHtml(redirectDisplayHost(request.redirectUri));
  if (target.kind === "machine") {
    return `<p class="sub"><strong>${appName}</strong> (${host}) wants to use ADE on <strong>${escapeHtml(target.name)}</strong>.</p>`;
  }
  const names = [...new Set(target.machineNames.filter((name) => name.trim()))];
  const which = names.length ? `: ${computerList(names)}` : "";
  return `<p class="sub"><strong>${appName}</strong> (${host}) wants to use your <strong>ADE account</strong>, on every computer you include in ADE MCP${which}.</p>`;
}

/** Step 1: the app sent the person here. Signing in to ADE is the only way on. */
export function renderSignInPage(args: { request: AuthorizeRequest; target: SignInTarget; error?: string | null }): string {
  const { request } = args;
  const appName = authorizeAppName(request);
  const fields = hidden("response_type", "code") + hidden("client_id", request.clientId)
    + hidden("redirect_uri", request.redirectUri) + hidden("code_challenge", request.codeChallenge)
    + hidden("code_challenge_method", "S256") + hidden("state", request.state)
    + hidden("scope", request.requestedScope === "read" ? "ade:read" : null);
  return page(`Connect ${appName} to ADE`, `
<h1>Connect ${escapeHtml(appName)}</h1>
${appLine(request, args.target)}
${args.error ? `<div class="notice" role="alert">${escapeHtml(args.error)}</div>` : ""}
<form method="post" class="actions">${fields}
<button class="primary" type="submit" name="decision" value="signin">Continue with ADE</button>
<button class="link" type="submit" name="decision" value="deny">Cancel</button>
</form>`);
}

/** Step 2: signed in as the computer's account. Choose the access, then accept. */
export function renderConsentPage(args: {
  request: AuthorizeRequest;
  target: SignInTarget;
  account: SignedInAccount;
  nonce: string;
  csrf: string;
  consentPath: string;
}): string {
  const { request } = args;
  const appName = authorizeAppName(request);
  const who = escapeHtml(args.account.email ?? args.account.name ?? "your ADE account");
  const readOnly = request.requestedScope === "read";
  return page(`Connect ${appName} to ADE`, `
<h1>Allow ${escapeHtml(appName)}?</h1>
${appLine(request, args.target)}
<div class="who">Signed in as ${who}</div>
<form method="post" action="${escapeHtml(args.consentPath)}">${hidden("nonce", args.nonce)}${hidden("csrf", args.csrf)}
<div class="choices" role="radiogroup" aria-label="Access">
<label class="choice"><input type="radio" name="access" value="write"${readOnly ? "" : " checked"}><div><b>Read &amp; write</b><span>Full access: anything you can do with ade.</span></div></label>
<label class="choice"><input type="radio" name="access" value="read"${readOnly ? " checked" : ""}><div><b>Read only</b><span>See lanes, chats, diffs, PRs and files. Change nothing.</span></div></label>
</div>
<div class="actions">
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button class="link" type="submit" name="decision" value="deny">Cancel</button>
</div>
</form>
<p class="fine">Change or remove it any time in ADE Settings → ADE MCP.</p>`);
}

export function renderMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(message)}</p>`);
}
