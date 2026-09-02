/**
 * Protocol-level auth probe for the four ACP providers.
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
 * NEVER on the catalog read path. Spawning four CLIs to answer "which models
 * exist" is exactly the mistake `claudeRuntimeProbe` exists to avoid, and it is
 * why `getAvailableModels` reads `detectCliAuthStatuses({ skipAuthProbe: true })`
 * instead. Call `probeAcpProviderAuth` from a force refresh, from a settings
 * diagnostics action, or from the chat runtime after a real failure.
 *
 * Results are cached per `{provider, cwd}` with the same four beats as
 * `claudeRuntimeProbe`: TTL short-circuit that still republishes health,
 * in-flight dedupe unless forced, cache written on every exit path, in-flight
 * entry cleared in `finally`.
 */

import type { AcpChatProvider } from "../../../shared/types/chat";
import {
  AcpRpcError,
  createAcpConnection,
  initializeAcpConnection,
} from "../chat/acpHost/acpConnection";
import { acpDialectFor } from "../chat/acpHost/acpDialects";
import { ACP_METHOD } from "../chat/acpHost/acpProtocolTypes";
import type { Logger } from "../logging/logger";
import {
  copilotConfigHome,
  kimiCodeConfigHome,
  qwenConfigHome,
} from "../shared/providerConfigHomes";
import { resolveAcpExecutable } from "./acpExecutables";
import {
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "./providerRuntimeHealth";

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
 * Grok is absent on purpose: it reads `~/.grok` and honors no override, so ADE
 * must not invent one. See `providerConfigHomes.grokConfigHome`.
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
    case "copilot":
      return copilotConfigHome({ env });
    case "grok":
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
  return `${dialect.displayName} is installed but not signed in. Run \`${dialect.authProbe.loginCommand}\` in a terminal${keyHint}, then refresh AI settings.`;
}

function publishResult(provider: AcpChatProvider, result: AcpAuthProbeResult): void {
  switch (result.state) {
    case "ready":
      reportProviderRuntimeReady(provider);
      return;
    case "auth-failed":
      reportProviderRuntimeAuthFailure(provider, result.message);
      return;
    case "runtime-failed":
      reportProviderRuntimeFailure(provider, result.message);
      return;
  }
}

export function resetAcpAuthProbeCache(): void {
  probeCache.clear();
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
  /** Test seam, forwarded to `createAcpConnection`. */
  spawnOverride?: Parameters<typeof createAcpConnection>[0]["spawnOverride"];
};

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

  const probe = (async (): Promise<AcpAuthProbeResult> => {
    const dialect = acpDialectFor(provider);
    const baseEnv = args.env ?? process.env;
    const executable = resolveAcpExecutable(provider, { env: baseEnv });
    const spawnPlan = dialect.buildSpawnPlan({
      binaryPath: executable.path,
      cwd,
      baseEnv,
      configHome: acpProbeConfigHome(provider, baseEnv),
    });

    const connection = createAcpConnection({
      dialect,
      spawnPlan,
      ...(args.spawnOverride ? { spawnOverride: args.spawnOverride } : {}),
    });
    try {
      const { response } = await initializeAcpConnection({
        connection,
        dialect,
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      const advertised = response.authMethods ?? [];
      const methodId = dialect.authProbe.methodId ?? advertised[0]?.id ?? null;

      // `session/new` is the real gate. Qwen 0.22.3 advertises `openai` and
      // answers `authenticate` with "Missing API key" even when the key
      // already lives in settings.json — that RPC is how you *submit* a key,
      // not how you prove one is present. A successful session/new is enough.
      try {
        await connection.request(
          ACP_METHOD.sessionNew,
          { cwd, mcpServers: [] },
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
        return { state: "ready", message: null };
      } catch (error) {
        if (!isAcpAuthError(error)) {
          return {
            state: "runtime-failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      if (!methodId) {
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
        await connection.request(ACP_METHOD.authenticate, { methodId }, { timeoutMs: PROBE_TIMEOUT_MS });
        return { state: "ready", message: null };
      } catch (error) {
        if (error instanceof AcpRpcError && error.isMethodNotFound) {
          // No `authenticate` on this agent. session/new already failed as
          // auth, so this is still a sign-in problem.
          return { state: "auth-failed", message: loginBlocker(provider) };
        }
        if (isAcpAuthError(error)) {
          return { state: "auth-failed", message: loginBlocker(provider) };
        }
        return {
          state: "runtime-failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      if (isAcpAuthError(error)) {
        return { state: "auth-failed", message: loginBlocker(provider) };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return {
        state: "runtime-failed",
        message: executable.source === "fallback-command"
          ? `The ${dialect.displayName} CLI (\`${dialect.binaryNames[0]}\`) was not found on this machine.`
          : `${dialect.displayName} was detected at ${executable.path}, but ADE could not start it: ${detail}`,
      };
    } finally {
      connection.dispose("auth probe finished");
    }
  })().then((result) => {
    probeCache.set(key, { checkedAtMs: Date.now(), result });
    return result;
  });

  inFlightProbes.set(key, probe);
  try {
    const result = await probe;
    publishResult(provider, result);
    if (result.state === "ready") {
      args.logger?.info?.("ai.acp_auth_probe.ready", { provider, cwd });
    } else {
      args.logger?.warn?.("ai.acp_auth_probe.failed", {
        provider,
        cwd,
        state: result.state,
        message: result.message,
      });
    }
    return result;
  } finally {
    inFlightProbes.delete(key);
  }
}

/** Probe every ACP provider that is installed. Used by the force-refresh path. */
export async function probeAllAcpProviderAuth(args: {
  providers: readonly AcpChatProvider[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Logger, "info" | "warn">;
  force?: boolean;
}): Promise<Partial<Record<AcpChatProvider, AcpAuthProbeResult>>> {
  const entries = await Promise.all(
    args.providers.map(async (provider) => {
      try {
        return [provider, await probeAcpProviderAuth({ ...args, provider })] as const;
      } catch (error) {
        // A probe must never take the refresh down with it.
        args.logger?.warn?.("ai.acp_auth_probe.threw", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        return [provider, null] as const;
      }
    }),
  );
  const out: Partial<Record<AcpChatProvider, AcpAuthProbeResult>> = {};
  for (const [provider, result] of entries) {
    if (result) out[provider] = result;
  }
  return out;
}
