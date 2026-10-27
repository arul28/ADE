/**
 * Antigravity sign-in: the ACP `authenticate` request, run as an explicit
 * user action in the process that owns the provider row (the brain on that
 * machine; the `ai.antigravitySignIn*` runtime actions route it there).
 *
 *   start    spawn ADE's pinned agent with the chosen method's credentials,
 *            `initialize`, `authenticate({ methodId })`, then one
 *            `session/new` to prove the login works
 *   status   the flow's state plus the disk check (cheap; polled by Settings
 *            only while a flow runs)
 *   complete forward a pasted return URL to the agent's 127.0.0.1 listener
 *            on this machine, for a browser on another machine
 *   cancel   end the flow and the agent
 *
 * Browser methods (Google account, Gemini Enterprise): the agent prints
 * "Open the following link to authenticate the ACP server: <url>" on stderr
 * and waits for Google to redirect to its loopback listener. The URL goes to
 * the client, which opens it (same machine) or shows it with a paste field
 * (another machine). ADE validates a pasted URL against the agent's own
 * `redirect_uri` and `state` before it forwards exactly that request, and
 * never logs the URL, the code or a token.
 *
 * Key methods (Gemini API key, Agent Platform): the credentials go in the
 * agent's environment for this run only; the agent records the method in
 * its own settings.json, and later chats get the same variables from
 * `antigravityCredentialEnv`.
 *
 * One flow per process: a new start replaces a running one.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import type { Logger } from "../logging/logger";
import type {
  AntigravityAuthMethod,
  AntigravitySignInCancelArgs,
  AntigravitySignInCompleteArgs,
  AntigravitySignInStartArgs,
  AntigravitySignInState,
} from "../../../shared/types/config";
import {
  createAcpConnection,
  initializeAcpConnection,
  AcpRpcError,
  type AcpConnection,
} from "../chat/acpHost/acpConnection";
import { ACP_METHOD } from "../chat/acpHost/acpProtocolTypes";
import {
  ANTIGRAVITY_AUTH_URL_PREFIX,
  ANTIGRAVITY_LICENSE_URL_PREFIX,
  antigravityDialect,
  buildAntigravitySpawnPlan,
} from "../chat/acpHost/acpDialects/antigravity";
import { resolveAntigravityExecutable } from "./acpExecutables";
import {
  ANTIGRAVITY_AGENT_PLATFORM_KEY_CREDENTIAL,
  inspectAntigravityCredentials,
  invalidateAntigravityAuthCache,
  isAntigravityAuthMethod,
  readAdeAntigravityAgentPlatformConfig,
  storedAntigravityGeminiKey,
  writeAdeAntigravityAgentPlatformConfig,
} from "./antigravityAuth";
import { requirePinnedProviderExecutable } from "./pinnedProviderTools";
import { getErrorMessage } from "../shared/utils";

/** A sign-in that has not finished in this long is abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 90_000;
const FORWARD_TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 16_384;

type PendingRedirect = { redirectUri: URL; state: string };

type Flow = {
  id: string;
  method: AntigravityAuthMethod;
  phase: AntigravitySignInState["phase"];
  authorizationUrl: string | null;
  licensePickerUrl: string | null;
  pending: PendingRedirect | null;
  callbackSent: boolean;
  message: string | null;
  expiresAtMs: number;
  connection: AcpConnection | null;
  timer: NodeJS.Timeout | null;
  done: boolean;
};

let current: Flow | null = null;
let logger: Logger | null = null;

export function setAntigravitySignInLogger(next: Logger | null): void {
  logger = next;
}

function browserMethod(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business";
}

// ── URL validation ──────────────────────────────────────────────────────────

/**
 * Google's sign-in URL as the agent printed it. Accepted only when it is the
 * real Google endpoint and names one `state` and a loopback `redirect_uri`
 * on an unprivileged port.
 */
export function parseAntigravityAuthorizationUrl(raw: string): { url: string; pending: PendingRedirect } | null {
  if (raw.length > MAX_URL_LENGTH || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const state = url.searchParams.getAll("state");
  const redirect = url.searchParams.getAll("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com"
    || url.pathname !== "/o/oauth2/v2/auth"
    || url.username || url.password || url.hash
    || state.length !== 1 || !state[0] || state[0].length > 512 || /\s/.test(state[0])
    || redirect.length !== 1
    || url.searchParams.get("response_type") !== "code"
  ) {
    return null;
  }
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[A-Za-z0-9._~/-]*$/.test(redirect[0]!)) return null;
  let redirectUri: URL;
  try {
    redirectUri = new URL(redirect[0]!);
  } catch {
    return null;
  }
  const port = Number(redirectUri.port);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) return null;
  return { url: url.toString(), pending: { redirectUri, state: state[0] } };
}

/** The license page the agent serves on this machine's loopback. */
function parseLicensePickerUrl(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A pasted return URL, accepted only when it is exactly the callback this
 * flow's agent is waiting for: http, the same 127.0.0.1 host, port and path
 * as its `redirect_uri`, the same single `state`, and one Google response
 * (a `code` or an `error`). Returns the URL to forward, or an error sentence.
 */
export function validateAntigravityCallbackUrl(
  pending: PendingRedirect,
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  const notOurs = "This address does not belong to the current Antigravity sign-in. Paste the full address the Google page ended on.";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return { ok: false, error: notOurs };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Paste the full address the Google page ended on, starting with http://127.0.0.1." };
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== pending.redirectUri.hostname
    || url.port !== pending.redirectUri.port
    || url.pathname !== pending.redirectUri.pathname
    || url.username || url.password || url.hash
  ) {
    return { ok: false, error: notOurs };
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) return { ok: false, error: notOurs };
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  const oneResponse = (codes.length === 1 && Boolean(codes[0]) && errors.length === 0)
    || (errors.length === 1 && Boolean(errors[0]) && codes.length === 0);
  if (!oneResponse) return { ok: false, error: "That address carries no Google sign-in response. Paste the full address, including everything after ?." };
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")) {
    return { ok: false, error: notOurs };
  }
  return { ok: true, url };
}

/** One GET to the agent's listener on this machine. No proxy, no redirects, nothing logged. */
function forwardCallback(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        protocol: "http:",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        timeout: FORWARD_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 400) resolve();
          else reject(new Error(`listener answered ${status}`));
        });
        response.once("error", reject);
      },
    );
    request.once("timeout", () => request.destroy(new Error("timed out")));
    request.once("error", reject);
    request.end();
  });
}

// ── State ───────────────────────────────────────────────────────────────────

const IDLE: Pick<AntigravitySignInState, "flowId" | "method" | "phase" | "authorizationUrl" | "licensePickerUrl" | "acceptsCallbackUrl" | "message" | "expiresAt"> = {
  flowId: null,
  method: null,
  phase: "idle",
  authorizationUrl: null,
  licensePickerUrl: null,
  acceptsCallbackUrl: false,
  message: null,
  expiresAt: null,
};

async function snapshot(flow: Flow | null): Promise<AntigravitySignInState> {
  const disk = await inspectAntigravityCredentials().catch(() => ({ authenticated: false, method: null }));
  const base = flow
    ? {
        flowId: flow.id,
        method: flow.method,
        phase: flow.phase,
        authorizationUrl: flow.phase === "waiting" ? flow.authorizationUrl : null,
        licensePickerUrl: flow.phase === "waiting" || flow.phase === "verifying" ? flow.licensePickerUrl : null,
        acceptsCallbackUrl: flow.phase === "waiting" && Boolean(flow.pending) && !flow.callbackSent,
        message: flow.message,
        expiresAt: flow.done ? null : new Date(flow.expiresAtMs).toISOString(),
      }
    : IDLE;
  return {
    ...base,
    recordedMethod: disk.method,
    signedIn: disk.authenticated,
    agentPlatform: readAdeAntigravityAgentPlatformConfig(),
  };
}

function finish(flow: Flow, phase: "succeeded" | "failed" | "cancelled", message: string): void {
  if (flow.done) return;
  flow.done = true;
  flow.phase = phase;
  flow.message = message;
  flow.pending = null;
  flow.authorizationUrl = null;
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = null;
  flow.connection?.dispose(`antigravity sign-in ${phase}`);
  flow.connection = null;
  invalidateAntigravityAuthCache();
  logger?.info("antigravity.sign_in_finished", { method: flow.method, phase });
}

/** The user-facing sentence for a failed `authenticate` or verify. Never echoes a URL. */
function failureSentence(method: AntigravityAuthMethod, error: unknown): string {
  const text = error instanceof AcpRpcError
    ? `${error.message} ${typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? "")}`
    : getErrorMessage(error);
  if (/SUBSCRIPTION_REQUIRED/i.test(text)) return "Google requires an eligible Antigravity subscription for this account.";
  if (/access_denied|denied access|cancelled|canceled/i.test(text)) return "Google sign-in was not approved. Start sign-in again.";
  if (/ge_license_cancelled/i.test(text)) return "No Gemini Enterprise license was chosen. Start sign-in again to choose one.";
  if (/ge_license_failed|license/i.test(text) && method === "oauth-business") {
    return "Gemini Enterprise could not find a license for this account. Check the account, or ask your Google Cloud administrator.";
  }
  if (method === "gemini-api-key") return "Antigravity did not accept the Gemini API key. Check the key saved on this page.";
  if (method === "agent-platform") {
    return "Antigravity could not use Agent Platform. Set an API key, or a project and location with Application Default Credentials on this machine.";
  }
  return "Google sign-in failed. Start sign-in again.";
}

function readUrlLine(flow: Flow, line: string): void {
  if (flow.done) return;
  const authAt = line.indexOf(ANTIGRAVITY_AUTH_URL_PREFIX);
  if (authAt >= 0) {
    const parsed = parseAntigravityAuthorizationUrl(line.slice(authAt + ANTIGRAVITY_AUTH_URL_PREFIX.length).trim());
    if (!parsed) {
      logger?.warn("antigravity.sign_in_url_rejected", { method: flow.method });
      return;
    }
    flow.authorizationUrl = parsed.url;
    flow.pending = parsed.pending;
    flow.callbackSent = false;
    flow.phase = "waiting";
    flow.message = "Open the Google sign-in page. On another computer, paste the address it ends on here.";
    return;
  }
  const licenseAt = line.indexOf(ANTIGRAVITY_LICENSE_URL_PREFIX);
  if (licenseAt >= 0) {
    const url = parseLicensePickerUrl(line.slice(licenseAt + ANTIGRAVITY_LICENSE_URL_PREFIX.length).trim());
    if (!url) return;
    flow.licensePickerUrl = url;
    flow.phase = "waiting";
    flow.message = "Choose your Gemini Enterprise license on the page Antigravity opened. It is served by this machine, so open it in a browser here.";
  }
}

async function runFlow(flow: Flow): Promise<void> {
  try {
    const executable = await requirePinnedProviderExecutable("antigravity", () => resolveAntigravityExecutable());
    if (flow.done) return;
    const spawnPlan = buildAntigravitySpawnPlan({
      binaryPath: executable.path,
      ...(executable.args?.length ? { binaryArgs: executable.args } : {}),
      ...(executable.files ? { binaryFiles: executable.files } : {}),
      // `authenticate` opens no session; any existing directory will do.
      cwd: os.homedir(),
      baseEnv: process.env,
    }, flow.method);
    const connection = createAcpConnection({ dialect: antigravityDialect, spawnPlan, ...(logger ? { logger } : {}) });
    flow.connection = connection;
    connection.onDiagnosticLine((line) => readUrlLine(flow, line));
    connection.onExit(() => {
      if (!flow.done) finish(flow, "failed", "Antigravity stopped before the sign-in finished. Start sign-in again.");
    });
    await initializeAcpConnection({ connection, dialect: antigravityDialect, timeoutMs: HANDSHAKE_TIMEOUT_MS });
    if (flow.done) return;
    const remaining = () => Math.max(1_000, flow.expiresAtMs - Date.now());
    await connection.request(ACP_METHOD.authenticate, { methodId: flow.method }, { timeoutMs: remaining() });
    if (flow.done) return;
    flow.phase = "verifying";
    flow.authorizationUrl = null;
    flow.pending = null;
    flow.message = "Checking Antigravity access.";
    // `authenticate` succeeds for an API-key method even without a key; the
    // real check is a session.
    await connection.request(
      ACP_METHOD.sessionNew,
      { cwd: os.homedir(), mcpServers: [] },
      { timeoutMs: Math.min(VERIFY_TIMEOUT_MS, remaining()) },
    );
    finish(flow, "succeeded", browserMethod(flow.method) ? "Signed in to Antigravity." : "Antigravity is connected.");
    void refreshAfterSignIn();
  } catch (error) {
    if (flow.done) return;
    logger?.warn("antigravity.sign_in_failed", {
      method: flow.method,
      code: error instanceof AcpRpcError ? error.code : null,
    });
    finish(flow, "failed", failureSentence(flow.method, error));
  }
}

/** A new login may be a different account: drop cached verdicts and models. */
async function refreshAfterSignIn(): Promise<void> {
  try {
    const probe = await import("./acpAuthProbe");
    probe.resetAcpAuthProbeCache();
    const discovery = await import("../chat/acpHost/acpModelDiscovery");
    discovery.markAcpModelCatalogStale("antigravity");
  } catch (error) {
    logger?.warn("antigravity.sign_in_cache_refresh_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    // Best effort; the next status refresh probes again.
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

export async function getAntigravitySignInState(): Promise<AntigravitySignInState> {
  return snapshot(current);
}

export async function startAntigravitySignIn(args: AntigravitySignInStartArgs): Promise<AntigravitySignInState> {
  const method = args?.method;
  if (!isAntigravityAuthMethod(method)) throw new Error("Choose an Antigravity sign-in method.");
  if (current && !current.done) finish(current, "cancelled", "Replaced by a new sign-in.");

  const flow: Flow = {
    id: randomUUID(),
    method,
    phase: "starting",
    authorizationUrl: null,
    licensePickerUrl: null,
    pending: null,
    callbackSent: false,
    message: browserMethod(method) ? "Starting Google sign-in." : "Checking credentials.",
    expiresAtMs: Date.now() + SIGN_IN_TIMEOUT_MS,
    connection: null,
    timer: null,
    done: false,
  };
  current = flow;

  if (method === "gemini-api-key" && !storedAntigravityGeminiKey()) {
    finish(flow, "failed", "Save a Gemini API key on this page first, then connect.");
    return snapshot(flow);
  }
  if (method === "agent-platform" && args.agentPlatform) {
    try {
      const saved = readAdeAntigravityAgentPlatformConfig();
      const project = args.agentPlatform.project === undefined ? saved.project : args.agentPlatform.project;
      const location = args.agentPlatform.location === undefined ? saved.location : args.agentPlatform.location;
      writeAdeAntigravityAgentPlatformConfig({ project: project ?? null, location: location ?? null });
      const apiKey = args.agentPlatform.apiKey?.trim();
      if (apiKey) {
        const { storeApiCredential } = await import("./apiKeyStore");
        storeApiCredential({
          provider: ANTIGRAVITY_AGENT_PLATFORM_KEY_CREDENTIAL,
          label: "Antigravity Agent Platform",
          key: apiKey,
          envVar: "GOOGLE_API_KEY",
        });
      }
    } catch (error) {
      finish(flow, "failed", `ADE could not save the Agent Platform settings: ${getErrorMessage(error)}`);
      return snapshot(flow);
    }
  }

  flow.timer = setTimeout(() => {
    finish(flow, "failed", browserMethod(method) ? "Google sign-in expired. Start sign-in again." : "Antigravity did not answer in time. Try again.");
  }, SIGN_IN_TIMEOUT_MS);
  flow.timer.unref?.();
  logger?.info("antigravity.sign_in_started", { method });
  void runFlow(flow);
  return snapshot(flow);
}

export async function completeAntigravitySignIn(args: AntigravitySignInCompleteArgs): Promise<AntigravitySignInState> {
  const flow = current;
  if (!flow || flow.id !== args?.flowId || flow.done) {
    throw new Error("This Antigravity sign-in is no longer running. Start sign-in again.");
  }
  if (Date.now() >= flow.expiresAtMs) {
    finish(flow, "failed", "Google sign-in expired. Start sign-in again.");
    throw new Error("Google sign-in expired. Start sign-in again.");
  }
  if (!flow.pending) throw new Error("Wait for the Google sign-in link before you paste an address.");
  if (flow.callbackSent) throw new Error("The address was already sent. Wait for Google to finish.");
  const checked = validateAntigravityCallbackUrl(flow.pending, String(args.callbackUrl ?? ""));
  if (!checked.ok) throw new Error(checked.error);
  flow.callbackSent = true;
  flow.message = "Finishing Google sign-in.";
  try {
    await forwardCallback(checked.url);
  } catch {
    finish(flow, "failed", "ADE could not hand the address to Antigravity. Start sign-in again.");
    throw new Error("ADE could not hand the address to Antigravity. Start sign-in again.");
  }
  return snapshot(flow);
}

export async function cancelAntigravitySignIn(args: AntigravitySignInCancelArgs): Promise<AntigravitySignInState> {
  const flow = current;
  if (flow && flow.id === args?.flowId && !flow.done) finish(flow, "cancelled", "Sign-in cancelled.");
  return snapshot(flow);
}

/** Stop a running flow (process shutdown). */
export function disposeAntigravitySignIn(): void {
  if (current && !current.done) finish(current, "cancelled", "ADE is shutting down.");
}
