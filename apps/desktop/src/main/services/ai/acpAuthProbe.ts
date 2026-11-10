/**
 * Protocol-level auth probe for the ACP providers.
 *
 * `authDetector` can only read a credential file off disk, so it reports
 * `verified: false` and says so. This module asks the agent itself: it spawns
 * the CLI with the dialect's own argv, runs `initialize`, then `session/new`.
 * A successful session is the proof. `authenticate` is only a fallback, and
 * only for methods that are not a TTY login — Qwen's `openai` method fails
 * that RPC when the key already lives in settings.json.
 *
 * ## Where this may run
 *
 * NEVER on a status or catalog read, forced or not. Spawning CLIs to answer
 * "which models exist" or "is this signed in" is exactly the mistake
 * `claudeRuntimeProbe` exists to avoid. Call `probeAcpProviderAuth` from the
 * one-provider sign-in check (`ai.verifyProviderSignIn`: right after a sign-in,
 * or on Re-check), from a settings diagnostics action, or from the chat
 * runtime after a real failure.
 *
 * Results are cached per `{provider, cwd}` with the same four beats as
 * `claudeRuntimeProbe`: TTL short-circuit that still republishes health,
 * in-flight dedupe unless forced, cache written on every exit path, in-flight
 * entry cleared in `finally`.
 */

import { boundedAgentReason } from "../../../shared/chatErrorPresentation";
import type { AcpChatProvider } from "../../../shared/types/chat";
import {
  AcpRequestTimeoutError,
  AcpRpcError,
  createAcpConnection,
  initializeAcpConnection,
  ACP_DEFAULT_REQUEST_TIMEOUT_MS,
  ACP_HANDSHAKE_TIMEOUT_MS,
} from "../chat/acpHost/acpConnection";
import { acpDialectFor } from "../chat/acpHost/acpDialects";
import { ACP_METHOD } from "../chat/acpHost/acpProtocolTypes";
import type { Logger } from "../logging/logger";
import {
  grokConfigHome,
  kimiCodeConfigHome,
  qwenConfigHome,
} from "../shared/providerConfigHomes";
import { resolveAcpExecutable } from "./acpExecutables";
import { awaitPinnedToolDownload, pinnedToolForProvider, pinnedToolNotReadyError } from "./pinnedProviderTools";
import { prepareAcpProbeSpawnPlan } from "./acpProbeSpawnPlan";
import {
  getProviderRuntimeHealth,
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
  type ProviderRuntimeFailureDetail,
} from "./providerRuntimeHealth";

/**
 * The probe waits as long as a real chat would: a slower answer here than a
 * chat allows reported "runtime-failed" for an agent whose chats open fine
 * (Antigravity's session/new on a loaded machine). Authenticate keeps the
 * shorter bound; it is only reached after a sign-in failure, so running out
 * of it means "not signed in" too.
 */
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CACHE_TTL_MS = 60_000;

export type AcpAuthProbeResult =
  | { state: "ready"; message: null }
  | { state: "auth-failed"; message: string }
  | { state: "runtime-failed"; message: string };

type CacheKey = string;

const probeCache = new Map<CacheKey, { checkedAtMs: number; result: AcpAuthProbeResult }>();
const inFlightProbes = new Map<CacheKey, Promise<AcpAuthProbeResult>>();

function cacheKey(provider: AcpChatProvider, cwd: string): CacheKey {
  return `${provider}:${cwd}`;
}

/**
 * Config home to export for the probe.
 *
 * Grok uses the vendor-supported `GROK_HOME` override, just like the other
 * ACP config-home variables. The dialect exports this same path on spawn.
 */
export function acpProbeConfigHome(
  provider: AcpChatProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  switch (provider) {
    case "qwen":
      return qwenConfigHome({ env });
    case "kimi":
      return kimiCodeConfigHome({ env });
    case "grok":
      return grokConfigHome({ env });
    // Devin reads `~/.config/devin` (%APPDATA%\devin on Windows) and honors
    // no override env var, so ADE sets nothing — same posture as Grok.
    case "devin":
      return null;
    // GEMINI_HOME stays at the user's default (shared login); ADE sets nothing.
    case "antigravity":
      return null;
  }
}

/**
 * True when a JSON-RPC failure reads as "you are not signed in" rather than
 * "this agent is broken".
 *
 * ACP has no dedicated auth error code, so the message is the only signal. The
 * list stays broad: a false "sign in" is a recoverable instruction, while a
 * false "runtime broken" sends the user hunting a machine problem they do not
 * have.
 */
export function isAcpAuthError(input: unknown): boolean {
  const pieces: string[] = [];
  if (input instanceof Error) {
    pieces.push(input.message);
    if ("data" in input && (input as { data?: unknown }).data != null) {
      try {
        pieces.push(JSON.stringify((input as { data: unknown }).data));
      } catch {
        pieces.push(String((input as { data: unknown }).data));
      }
    }
  } else {
    pieces.push(String(input ?? ""));
  }
  const text = pieces.join(" ").toLowerCase();
  if (!text.trim().length) return false;
  return (
    text.includes("auth_required")
    || text.includes("authentication required")
    || text.includes("authentication_required")
    || text.includes("not authenticated")
    || text.includes("not logged in")
    || text.includes("unauthenticated")
    || text.includes("unauthorized")
    || text.includes("login required")
    || text.includes("please log in")
    || text.includes("please sign in")
    || text.includes("sign in")
    || text.includes("invalid api key")
    || text.includes("missing api key")
    || text.includes("invalid credentials")
    || text.includes("no credentials")
    || text.includes("401")
    || text.includes("403")
  );
}

function loginBlocker(provider: AcpChatProvider): string {
  const dialect = acpDialectFor(provider);
  const keys = dialect.authProbe.apiKeyEnvVars;
  const keyHint = keys.length ? ` or set ${keys.join(" / ")}` : "";
  if (!dialect.authProbe.loginCommand) {
    return `${dialect.displayName} is not signed in. ${dialect.authProbe.signInHint ?? "Sign in from Settings > Providers"}, then refresh AI settings.`;
  }
  return `${dialect.displayName} is not signed in. Run \`${dialect.authProbe.loginCommand}\` in a terminal${keyHint}, then refresh AI settings.`;
}

function publishResult(
  provider: AcpChatProvider,
  result: AcpAuthProbeResult,
  detail?: ProviderRuntimeFailureDetail,
): void {
  // A sign-in that changed state may now be a different account, whose models differ.
  const before = getProviderRuntimeHealth(provider)?.state ?? null;
  if (before !== null && before !== result.state && (before === "ready" || result.state === "ready")) {
    // Loaded on use: model discovery imports this module.
    void import("../chat/acpHost/acpModelDiscovery")
      .then((discovery) => discovery.markAcpModelCatalogStale(provider))
      .catch(() => undefined);
  }
  switch (result.state) {
    case "ready":
      reportProviderRuntimeReady(provider);
      return;
    case "auth-failed":
      reportProviderRuntimeAuthFailure(provider, result.message);
      return;
    case "runtime-failed":
      reportProviderRuntimeFailure(provider, result.message, detail);
      return;
  }
}

/** Drop cached verdicts: one provider's after its sign-in changed, or all. */
export function resetAcpAuthProbeCache(provider?: AcpChatProvider): void {
  if (!provider) {
    probeCache.clear();
    return;
  }
  for (const key of [...probeCache.keys()]) {
    if (key.startsWith(`${provider}:`)) probeCache.delete(key);
  }
}

/** Read a cached verdict without spawning anything. */
export function getCachedAcpAuthProbe(
  provider: AcpChatProvider,
  cwd: string,
): AcpAuthProbeResult | null {
  return probeCache.get(cacheKey(provider, cwd))?.result ?? null;
}

/**
 * Record a verdict the chat runtime learned from a real session.
 *
 * A live session that opened is stronger evidence than any probe, and a live
 * session that failed to authenticate should not need a second spawn to say so.
 */
export function recordAcpAuthProbeResult(
  provider: AcpChatProvider,
  cwd: string,
  result: AcpAuthProbeResult,
): void {
  probeCache.set(cacheKey(provider, cwd), { checkedAtMs: Date.now(), result });
  publishResult(provider, result);
}

export type ProbeAcpProviderAuthArgs = {
  provider: AcpChatProvider;
  /** Working directory to spawn in. A lane worktree, or the project root. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Logger, "info" | "warn">;
  force?: boolean;
  /**
   * The person's Re-check: every request answers within this many ms, and the
   * probe does not wait for a download. A timeout under this limit says
   * nothing about the sign-in, so it is neither cached nor published.
   */
  limitMs?: number;
  /** Test seam, forwarded to `createAcpConnection`. */
  spawnOverride?: Parameters<typeof createAcpConnection>[0]["spawnOverride"];
};

/** A limited probe ran out of time, so it proved nothing about the sign-in. */
export class AcpProbeLimitError extends Error {
  constructor(provider: AcpChatProvider) {
    super(`${acpDialectFor(provider).displayName} did not answer in time.`);
    this.name = "AcpProbeLimitError";
  }
}

/**
 * Ask one ACP agent whether it can authenticate.
 *
 * The probe never sends a prompt: `initialize` proves the binary runs and
 * speaks the protocol, and `session/new` proves the credential is live.
 * `authenticate` is a fallback for agents that still need it after session/new
 * fails as auth. An agent that answers `-32601` to `authenticate` in that
 * fallback is still unsigned-in, because session/new already failed.
 */
export async function probeAcpProviderAuth(
  args: ProbeAcpProviderAuthArgs,
): Promise<AcpAuthProbeResult> {
  const { provider, cwd } = args;
  const key = cacheKey(provider, cwd);
  const now = Date.now();

  const cached = probeCache.get(key);
  if (!args.force && cached && now - cached.checkedAtMs < PROBE_CACHE_TTL_MS) {
    publishResult(provider, cached.result);
    return cached.result;
  }

  const existing = inFlightProbes.get(key);
  if (!args.force && existing) {
    const result = await existing;
    publishResult(provider, result);
    return result;
  }

  // The probe runs ADE's pinned copy, so it waits for that copy's download.
  // A miss is neither cached nor published as runtime health: it is a
  // download state, and the next probe after the download lands must run.
  // A limited probe does not wait: a download is not a sign-in answer.
  const baseEnv = args.env ?? process.env;
  const tool = pinnedToolForProvider(provider);
  if (tool && args.limitMs == null) await awaitPinnedToolDownload(tool.tool);
  const deadline = args.limitMs != null ? Date.now() + args.limitMs : null;
  const within = (defaultMs: number): number =>
    deadline == null ? defaultMs : Math.max(1, Math.min(defaultMs, deadline - Date.now()));
  let limitedTimeout = false;
  const ranOutOfLimit = (error: unknown): boolean => {
    if (deadline == null || !(error instanceof AcpRequestTimeoutError)) return false;
    limitedTimeout = true;
    return true;
  };
  const executable = resolveAcpExecutable(provider, { env: baseEnv });
  if (executable.source === "fallback-command" && !args.spawnOverride) {
    return {
      state: "runtime-failed",
      message: tool
        ? pinnedToolNotReadyError(tool.tool, tool.label).message
        : `ADE has no ${provider} runtime on this machine.`,
    };
  }

  // What the agent wrote to stderr before the probe gave up: the only account
  // of an agent that never answered `initialize` (Antigravity on Windows).
  const probeOutput: ProviderRuntimeFailureDetail = {};
  const probe = (async (): Promise<AcpAuthProbeResult> => {
    const dialect = acpDialectFor(provider);
    let connection: ReturnType<typeof createAcpConnection> | null = null;
    try {
      const spawnPlan = await prepareAcpProbeSpawnPlan(provider, dialect.buildSpawnPlan({
        binaryPath: executable.path,
        ...(executable.args?.length ? { binaryArgs: executable.args } : {}),
        ...(executable.files ? { binaryFiles: executable.files } : {}),
        cwd,
        baseEnv,
        configHome: acpProbeConfigHome(provider, baseEnv),
      }));

      connection = createAcpConnection({
        dialect,
        spawnPlan,
        ...(args.spawnOverride ? { spawnOverride: args.spawnOverride } : {}),
      });
      const response = await initializeAcpConnection({
        connection,
        dialect,
        timeoutMs: within(ACP_HANDSHAKE_TIMEOUT_MS),
      });

      const advertised = response.authMethods ?? [];
      const methodId = dialect.authProbe.methodId ?? advertised[0]?.id ?? null;

      // `session/new` is the real gate. Qwen 0.24.0 advertises `openai` and
      // `openai-responses`, and answers `authenticate` with "Missing API key" even when the key
      // already lives in settings.json — that RPC is how you *submit* a key,
      // not how you prove one is present. A successful session/new is enough.
      try {
        await connection.request(
          ACP_METHOD.sessionNew,
          { cwd, mcpServers: [] },
          { timeoutMs: within(ACP_DEFAULT_REQUEST_TIMEOUT_MS) },
        );
        return { state: "ready", message: null };
      } catch (error) {
        if (ranOutOfLimit(error)) {
          return { state: "runtime-failed", message: error instanceof Error ? error.message : String(error) };
        }
        if (!isAcpAuthError(error)) {
          return {
            state: "runtime-failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (!methodId || dialect.authProbe.probeMayAuthenticate === false) {
        return { state: "auth-failed", message: loginBlocker(provider) };
      }
      // A `type: "terminal"` method means the agent wants to run its own login
      // command in a TTY. Calling it headlessly would hang, so treat the fact
      // that the agent is still offering it as "not signed in".
      const chosen = advertised.find((method) => method.id === methodId) ?? null;
      if (chosen?.type === "terminal") {
        return { state: "auth-failed", message: loginBlocker(provider) };
      }

      try {
        await connection.request(ACP_METHOD.authenticate, { methodId }, { timeoutMs: within(PROBE_TIMEOUT_MS) });
        return { state: "ready", message: null };
      } catch (error) {
        if (error instanceof AcpRpcError && error.isMethodNotFound) {
          // No `authenticate` on this agent. session/new already failed as
          // auth, so this is still a sign-in problem.
          return { state: "auth-failed", message: loginBlocker(provider) };
        }
        // An `authenticate` that never answers headlessly is waiting on a
        // login the user has to do (Grok's), and session/new already failed
        // as sign-in: still not signed in, not a broken agent.
        if (isAcpAuthError(error) || error instanceof AcpRequestTimeoutError) {
          // The agent's own reason (not entitled, key expired) beats a generic hint.
          const reason = !(error instanceof AcpRequestTimeoutError) && error instanceof Error
            ? boundedAgentReason(error.message)
            : "";
          return { state: "auth-failed", message: reason ? `${loginBlocker(provider)} The agent said: ${reason}` : loginBlocker(provider) };
        }
        return {
          state: "runtime-failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      if (ranOutOfLimit(error)) {
        return { state: "runtime-failed", message: error instanceof Error ? error.message : String(error) };
      }
      if (isAcpAuthError(error)) {
        return { state: "auth-failed", message: loginBlocker(provider) };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return {
        state: "runtime-failed",
        message: `ADE could not start its ${dialect.displayName} at ${executable.path}: ${detail}`,
      };
    } finally {
      probeOutput.stderrTail = connection?.readStderrTail().trim() || null;
      // Before the dispose below, which would read as the process's own exit.
      const startup = connection?.readStartupTrace();
      probeOutput.startup = startup ? { ...startup, platform: process.platform } : null;
      connection?.dispose("auth probe finished");
    }
  })().then((result) => {
    if (!limitedTimeout) probeCache.set(key, { checkedAtMs: Date.now(), result });
    return result;
  });

  // A limited probe is not shared: a caller that joined it would publish a
  // timeout that proves nothing.
  if (deadline == null) inFlightProbes.set(key, probe);
  try {
    const result = await probe;
    if (limitedTimeout) {
      args.logger?.info?.("ai.acp_auth_probe.limited_timeout", { provider, limitMs: args.limitMs });
      throw new AcpProbeLimitError(provider);
    }
    const { stderrTail, startup } = result.state === "runtime-failed" ? probeOutput : ({} as ProviderRuntimeFailureDetail);
    publishResult(provider, result, { stderrTail, startup });
    if (result.state === "ready") {
      args.logger?.info?.("ai.acp_auth_probe.ready", { provider, cwd });
    } else {
      args.logger?.warn?.("ai.acp_auth_probe.failed", {
        provider,
        cwd,
        state: result.state,
        message: result.message,
        ...(stderrTail ? { stderrTail: stderrTail.slice(-1_000) } : {}),
        ...(startup ? { startup } : {}),
      });
    }
    return result;
  } finally {
    if (inFlightProbes.get(key) === probe) inFlightProbes.delete(key);
  }
}
