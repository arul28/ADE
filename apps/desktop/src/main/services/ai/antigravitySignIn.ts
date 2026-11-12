/**
 * Antigravity sign-in, run as an explicit user action in the process that
 * owns the provider row (the brain on that machine; the
 * `ai.antigravitySignIn*` runtime actions route it there).
 *
 *   start    begin the chosen method's sign-in
 *   status   the flow's state plus the disk check (cheap; polled by Settings
 *            only while a flow runs)
 *   complete hand the code (pasted, or read from the address Google's last page
 *            shows) to the waiting sign-in
 *   cancel   end the flow and its process
 *
 * Google account (`oauth-personal`): ADE runs the pinned CLI's own terminal
 * sign-in, `agy acp --login`. It prints a Google link whose `redirect_uri` is
 * `https://antigravity.google/oauth-callback`, a page that shows a code, and
 * then reads the code from stdin (ADE takes it out of a pasted address). Nothing
 * listens on the machine, so the same paste works from any computer, the
 * phone and ADE Cloud. ADE validates the link and the pasted value, writes the
 * value to the CLI's stdin, and never logs either.
 *
 * Gemini Enterprise (`oauth-business`): the ACP `authenticate` request. The
 * CLI opens the OS browser itself (it ignores BROWSER) and waits on a
 * `localhost` listener without printing the link, so it can only finish on
 * the machine that runs the agent.
 *
 * Key methods (Gemini API key, Agent Platform): `authenticate` with the
 * credentials in the agent's environment for this run only; later chats get
 * the same variables from `antigravityCredentialEnv`.
 *
 * Every method ends with one `session/new` that proves the login works.
 * One flow per process: a new start replaces a running one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { antigravityDialect, antigravitySpawnEnv, buildAntigravitySpawnPlan } from "../chat/acpHost/acpDialects/antigravity";
import { allocateAcpScratchDir, prepareAcpScratchDir, removeAcpScratchDir } from "../chat/acpHost/acpScratchDirs";
import { resolveAntigravityExecutable, type AcpExecutableResolution } from "./acpExecutables";
import {
  ANTIGRAVITY_AGENT_PLATFORM_KEY_CREDENTIAL,
  inspectAntigravityCredentials,
  invalidateAntigravityAuthCache,
  isAntigravityAuthMethod,
  pointAntigravitySettingsAtGoogle,
  readAdeAntigravityAgentPlatformConfig,
  storedAntigravityGeminiKey,
  writeAdeAntigravityAgentPlatformConfig,
} from "./antigravityAuth";
import { requirePinnedProviderExecutable } from "./pinnedProviderTools";
import { providerSelfUpdateEnv } from "../../../shared/pinnedToolSpawnEnv";
import { getErrorMessage } from "../shared/utils";

/** A sign-in that has not finished in this long is abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 90_000;
const MAX_URL_LENGTH = 16_384;
/** Where Google sends the browser after `agy acp --login`: a page that shows the code. */
export const ANTIGRAVITY_LOGIN_REDIRECT_URI = "https://antigravity.google/oauth-callback";

type Flow = {
  id: string;
  method: AntigravityAuthMethod;
  phase: AntigravitySignInState["phase"];
  authorizationUrl: string | null;
  /** The `state` of the printed link; a pasted address must carry the same one. */
  state: string | null;
  codeSent: boolean;
  message: string | null;
  expiresAtMs: number;
  connection: AcpConnection | null;
  child: ChildProcess | null;
  scratchDir: string | null;
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

// ── Link and code validation ────────────────────────────────────────────────

/**
 * Google's sign-in link as `agy acp --login` printed it. Accepted only when it
 * is the real Google endpoint, sends the browser to Antigravity's code page,
 * and names one `state`.
 */
export function parseAntigravityLoginUrl(raw: string): { url: string; state: string } | null {
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
    || !/^\/o\/oauth2(\/v2)?\/auth$/.test(url.pathname)
    || url.username || url.password || url.hash
    || state.length !== 1 || !state[0] || state[0].length > 512 || /\s/.test(state[0])
    || redirect.length !== 1 || redirect[0] !== ANTIGRAVITY_LOGIN_REDIRECT_URI
    || url.searchParams.get("response_type") !== "code"
  ) {
    return null;
  }
  return { url: url.toString(), state: state[0] };
}

/** Google authorization codes: `4/0A…`, URL-safe characters only. */
const AUTH_CODE = /^[A-Za-z0-9/_.~-]{10,2048}$/;

/**
 * What the user pasted: the code Antigravity's page shows, or that page's full
 * address. An address must be Antigravity's code page with this flow's single
 * `state` and one `code`. Returns the line to hand the CLI, or an error sentence.
 */
export function readAntigravityLoginPaste(
  expectedState: string,
  raw: string,
): { ok: true; line: string } | { ok: false; error: string } {
  const notOurs = "This address does not belong to the current Antigravity sign-in. Paste the code the Antigravity page shows.";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return { ok: false, error: "Paste the code the Antigravity page shows." };
  if (!/^https?:\/\//i.test(trimmed)) {
    return AUTH_CODE.test(trimmed)
      ? { ok: true, line: trimmed }
      : { ok: false, error: "That is not an Antigravity sign-in code. Copy the whole code from the Antigravity page." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: notOurs };
  }
  if (`${url.origin}${url.pathname}` !== ANTIGRAVITY_LOGIN_REDIRECT_URI || url.username || url.password) {
    return { ok: false, error: notOurs };
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) return { ok: false, error: notOurs };
  const errors = url.searchParams.getAll("error");
  if (errors.length) return { ok: false, error: "Google sign-in was not approved. Start sign-in again." };
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !AUTH_CODE.test(codes[0] ?? "")) {
    return { ok: false, error: "That address carries no sign-in code. Paste the code the Antigravity page shows." };
  }
  // The CLI is handed the code itself: that is what a pasted code gives it too.
  return { ok: true, line: codes[0]! };
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
        licensePickerUrl: null,
        acceptsCallbackUrl: flow.phase === "waiting" && Boolean(flow.state) && !flow.codeSent,
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

function stopChild(flow: Flow): void {
  const child = flow.child;
  flow.child = null;
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  if (flow.scratchDir) removeAcpScratchDir(flow.scratchDir);
  flow.scratchDir = null;
}

function finish(flow: Flow, phase: "succeeded" | "failed" | "cancelled", message: string): void {
  if (flow.done) return;
  flow.done = true;
  flow.phase = phase;
  flow.message = message;
  flow.state = null;
  flow.authorizationUrl = null;
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = null;
  stopChild(flow);
  flow.connection?.dispose(`antigravity sign-in ${phase}`);
  flow.connection = null;
  invalidateAntigravityAuthCache();
  logger?.info("antigravity.sign_in_finished", { method: flow.method, phase });
}

/** The user-facing sentence for a failed sign-in or verify. Never echoes a URL or code. */
function failureSentence(method: AntigravityAuthMethod, error: unknown): string {
  const text = error instanceof AcpRpcError
    ? `${error.message} ${typeof error.data === "string" ? error.data : JSON.stringify(error.data ?? "")}`
    : getErrorMessage(error);
  if (text === GOOGLE_SETTING_BLOCKED) return text;
  if (/SUBSCRIPTION_REQUIRED/i.test(text)) return "Google requires an eligible Antigravity subscription for this account.";
  if (/access_denied|denied access|cancelled|canceled/i.test(text)) return "Google sign-in was not approved. Start sign-in again.";
  if (/invalid_grant|code.*(invalid|expired)/i.test(text)) return "Google did not accept that code. Start sign-in again and paste the new code.";
  if (/license/i.test(text) && method === "oauth-business") {
    return "Gemini Enterprise could not find a license for this account. Check the account, or ask your Google Cloud administrator.";
  }
  if (method === "gemini-api-key") return "Antigravity did not accept the Gemini API key. Check the key saved on this page.";
  if (method === "agent-platform") {
    return "Antigravity could not use Agent Platform. Set an API key, or a project and location with Application Default Credentials on this machine.";
  }
  return "Google sign-in failed. Start sign-in again.";
}

async function pinnedExecutable(): Promise<AcpExecutableResolution> {
  return requirePinnedProviderExecutable("antigravity", () => resolveAntigravityExecutable());
}

/** One `session/new` on a fresh agent: the proof that the new login works. */
async function verifySession(flow: Flow, executable: AcpExecutableResolution): Promise<void> {
  const spawnPlan = buildAntigravitySpawnPlan({
    binaryPath: executable.path,
    ...(executable.args?.length ? { binaryArgs: executable.args } : {}),
    cwd: os.homedir(),
    baseEnv: { ...process.env, ...providerSelfUpdateEnv("antigravity") },
  }, flow.method);
  const connection = createAcpConnection({ dialect: antigravityDialect, spawnPlan, ...(logger ? { logger } : {}) });
  flow.connection = connection;
  connection.onExit(() => {
    if (!flow.done) finish(flow, "failed", "Antigravity stopped before the sign-in finished. Start sign-in again.");
  });
  await initializeAcpConnection({ connection, dialect: antigravityDialect, timeoutMs: HANDSHAKE_TIMEOUT_MS });
  if (flow.done) return;
  const remaining = Math.max(1_000, flow.expiresAtMs - Date.now());
  if (!browserMethod(flow.method) || flow.method === "oauth-business") {
    // Enterprise and the key methods sign in through `authenticate`, which
    // records the method in the CLI's settings. Enterprise opens the browser
    // on this machine by itself.
    await connection.request(ACP_METHOD.authenticate, { methodId: flow.method }, { timeoutMs: remaining });
    if (flow.done) return;
  }
  flow.phase = "verifying";
  flow.authorizationUrl = null;
  flow.state = null;
  flow.message = "Checking Antigravity access.";
  // `authenticate` succeeds for an API-key method even without a key; the
  // real check is a session.
  await connection.request(
    ACP_METHOD.sessionNew,
    { cwd: os.homedir(), mcpServers: [] },
    { timeoutMs: Math.min(VERIFY_TIMEOUT_MS, remaining) },
  );
}

/**
 * `agy acp --login`: read the printed link, wait for the pasted code
 * (`completeAntigravitySignIn` writes it to stdin), and resolve when the CLI
 * exits. Output is scanned, never logged: it carries the link.
 */
function runTerminalLogin(flow: Flow, executable: AcpExecutableResolution): Promise<void> {
  return new Promise((resolve, reject) => {
    const scratchDir = allocateAcpScratchDir("antigravity");
    flow.scratchDir = scratchDir;
    prepareAcpScratchDir(scratchDir);
    const env = antigravitySpawnEnv({
      baseEnv: { ...process.env, ...providerSelfUpdateEnv("antigravity") },
      scratchDir,
      method: flow.method,
    });
    let child: ChildProcess;
    try {
      child = spawn(executable.path, [...(executable.args ?? []), "acp", "--login"], {
        cwd: os.homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    flow.child = child;
    let tail = "";
    const scan = (chunk: Buffer) => {
      if (flow.done) return;
      tail = `${tail}${chunk.toString("utf8")}`.slice(-MAX_URL_LENGTH * 2);
      if (flow.authorizationUrl) return;
      for (const token of tail.split(/\s+/)) {
        if (!token.startsWith("https://accounts.google.com/")) continue;
        const parsed = parseAntigravityLoginUrl(token);
        if (!parsed) continue;
        flow.authorizationUrl = parsed.url;
        flow.state = parsed.state;
        flow.codeSent = false;
        flow.phase = "waiting";
        flow.message = "Open the Google sign-in page, then paste the code the Antigravity page shows.";
        return;
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.once("error", reject);
    // The CLI can close its input before the code is written; that write's
    // EPIPE fails this sign-in instead of escaping into the runtime.
    child.stdin?.on("error", reject);
    child.once("exit", (code, signal) => {
      flow.child = null;
      if (flow.done) return resolve();
      if (code === 0) return resolve();
      // Only a fixed sentence leaves this function; the output may hold the link.
      reject(new Error(/invalid_grant/i.test(tail) ? "invalid_grant" : `antigravity login exited (${signal ?? code})`));
    });
  });
}

/** agy's settings name a key method ADE could not switch: the person can. */
const GOOGLE_SETTING_BLOCKED = "Antigravity is set to sign in with an API key, so it would ignore your Google login. "
  + "In ~/.gemini/antigravity-cli/settings.json, set auth.type to \"oauth-personal\", then sign in again.";

async function runFlow(flow: Flow): Promise<void> {
  try {
    const executable = await pinnedExecutable();
    if (flow.done) return;
    if (flow.method === "oauth-personal") {
      await runTerminalLogin(flow, executable);
      if (flow.done) return;
      if (!flow.codeSent) throw new Error("antigravity login ended before a code was entered");
      stopChild(flow);
      // A key method left in agy's settings would hide the new login.
      const settings = pointAntigravitySettingsAtGoogle();
      if (settings === "failed") throw new Error(GOOGLE_SETTING_BLOCKED);
      if (settings === "switched") logger?.info("antigravity.sign_in_settings_switched", { to: "oauth-personal" });
    } else if (flow.method === "oauth-business") {
      flow.message = "Finish the Gemini Enterprise sign-in in the browser Antigravity opened on this computer.";
    }
    await verifySession(flow, executable);
    if (flow.done) return;
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
    const { noteProviderLoginChanged } = await import("./providerLoginChanged");
    noteProviderLoginChanged("antigravity");
  } catch (error) {
    logger?.warn("antigravity.sign_in_cache_refresh_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    // Best effort; the sign-in check after it drops the same caches.
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
    state: null,
    codeSent: false,
    message: browserMethod(method) ? "Starting Google sign-in." : "Checking credentials.",
    expiresAtMs: Date.now() + SIGN_IN_TIMEOUT_MS,
    connection: null,
    child: null,
    scratchDir: null,
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
  if (!flow.state || !flow.child?.stdin) throw new Error("Wait for the Google sign-in link before you paste a code.");
  if (flow.codeSent) throw new Error("The code was already sent. Wait for Antigravity to finish.");
  const checked = readAntigravityLoginPaste(flow.state, String(args.callbackUrl ?? ""));
  if (!checked.ok) throw new Error(checked.error);
  flow.codeSent = true;
  flow.message = "Finishing Google sign-in.";
  flow.child.stdin.write(`${checked.line}\n`);
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
