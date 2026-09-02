/**
 * Make Grok attest, in its own words, that ADE took its approvals back.
 *
 * `shared/grokSupervision.ts` explains the two-half neutralization. Both halves
 * lean on `_GROK_CLAUDE_MARKER_OVERRIDE`, an undocumented, underscore-prefixed
 * vendor hatch in a binary that ships roughly daily. Trusting it silently is
 * exactly the failure this whole change exists to fix, so ADE asks Grok itself
 * before it opens a session.
 *
 * ## Why this does NOT parse `grok inspect`
 *
 * It used to, and that gate FAILED OPEN on the precise root cause spec §3
 * documents. `inspect` builds its `Permissions` rows from per-rule provenance
 * (`tag_with_source` over `config.rules`), so a `~/.claude/settings.json`
 * holding only `{"permissions":{"defaultMode":"auto"}}` contributes zero rules
 * and therefore zero rows — while still setting `prompt_policy: Auto`.
 * Measured live on 1.0.13 against fake `HOME`s under /tmp:
 *
 *     defaultMode only      -> Source: (none)               0 loaded
 *     defaultMode + 1 rule  -> Source: .../settings.json    1 loaded
 *     rule only             -> Source: .../settings.json    1 loaded
 *
 * The first row is byte-identical to a fully neutralized machine. A parser can
 * not tell them apart, and the same settings file drove a real ACP session to
 * 0 permission requests and a completed write. Three static pre-checks in a row
 * have now been wrong (single-source parse, print-order dependence, and this),
 * which is why the load-bearing safety net is the RUNTIME invariant in
 * `acpHost/acpSupervisionGuard.ts`. This preflight is an early warning. It is
 * never proof of supervision.
 *
 * ## What it does instead
 *
 * Spawns one throwaway agent process with the session's exact argv and
 * environment plus `--debug --debug-file`, runs `initialize` + `session/new`,
 * and reads two tracing lines out of the debug log. Verified live on 1.0.13
 * with a `defaultMode`-only settings file — the case `inspect` is blind to:
 *
 *     no marker -> "Claude compat disabled" x0, "auto permission mode seeded" x1
 *     marker    -> "Claude compat disabled" x1, "auto permission mode seeded" x0
 *
 * - `auto permission mode seeded from Claude defaultMode / prompt_policy`
 *   (`permission/manager/mod.rs`) reports the ACTUAL manager state, so it sees
 *   the case that has no rules to enumerate.
 * - `Claude compat disabled (marker set in config.toml)` is positive proof the
 *   hatch fired on THIS binary. Measured at 1 for every marker run regardless
 *   of whether the machine has Claude settings at all, so its absence is
 *   meaningful. That makes this signal a live regression detector: if xAI
 *   renames or removes `_GROK_CLAUDE_MARKER_OVERRIDE`, the attestation
 *   disappears and ADE degrades loudly instead of silently losing supervision.
 *
 * Both conditions fail SAFE. A renamed string, an empty log, a crash, or a
 * timeout all read as "not neutralized". There is no input that turns silence
 * into a pass.
 *
 * ## No prompt, no spend, no user content
 *
 * The probe sends `initialize` and `session/new` and then closes. It never
 * sends `session/prompt`, so it costs nothing and the debug log contains
 * handshake tracing only — measured at ~32 KB with zero occurrences of any
 * settings or instruction file content. This is also why `--debug` is NOT put
 * on the user's real session: debug logs of a real turn would carry prompts,
 * file contents, and tool arguments to disk.
 *
 * `inspect` does not honor `--debug-file` (it initializes no logger), so the
 * agent spawn is the only place this signal exists — which is the better place
 * anyway, because it is the code path the session actually uses.
 *
 * ## Accepted residue
 *
 * `session/new` materializes a session directory that `session/close` does not
 * remove, so each probe leaves ~13.7 KB under
 * `$GROK_HOME/sessions/<urlencoded-cwd>/<uuid>/`. Containing it would mean
 * pointing the probe at a private `GROK_HOME`, which would stop it exercising
 * the user's real `~/.grok/config.toml` — including `[ui] permission_mode`,
 * one of the two halves under test — so the residue is the cheaper trade, and
 * ADE must not delete from `~/.grok` either. The cache bounds it to roughly
 * once per lane per Grok version, and `grok sessions list` does not show it.
 *
 * If Grok session disk-adopt or session import is ever built, it MUST skip
 * these: they live beside real sessions and are not filtered by whatever hides
 * them from `sessions list`. Measured discriminator: `events.jsonl` is exactly
 * 0 bytes and `chat_history.jsonl` holds only the system entry.
 *
 * ## Caching
 *
 * Keyed by binary path + cwd + argv, invalidated by the binary's size and
 * mtime — a `grok` upgrade rewrites the file, so that pair is a version
 * fingerprint that costs a `stat` instead of another spawn.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAcpConnection, initializeAcpConnection } from "../chat/acpHost/acpConnection";
import { grokDialect } from "../chat/acpHost/acpDialects";
import { ACP_METHOD } from "../chat/acpHost/acpProtocolTypes";
import type { AcpSpawnPlan } from "../chat/acpHost/acpHostTypes";
import type { Logger } from "../logging/logger";

/** Budget for the whole probe: spawn, handshake, session/new, close. */
export const GROK_PREFLIGHT_TIMEOUT_MS = 20_000;

/** Refresh window even when the binary fingerprint has not moved. */
export const GROK_PREFLIGHT_TTL_MS = 10 * 60_000;

/** Never read more than this from a debug log, however large it grew. */
export const GROK_PREFLIGHT_LOG_READ_CAP_BYTES = 4 * 1024 * 1024;

/** Positive attestation that the Claude-import kill switch fired. */
export const GROK_COMPAT_DISABLED_MARKER = "Claude compat disabled";

/** Evidence that Claude's `permissions.defaultMode` seeded the auto classifier. */
export const GROK_AUTO_SEEDED_MARKER = "auto permission mode seeded";

export type GrokPermissionPreflightStatus =
  /** The hatch fired and no Claude auto-mode was seeded. The only pass. */
  | "neutralized"
  /** Grok reported seeding auto permission mode from Claude. The root cause. */
  | "claude-import-active"
  /** No attestation line. The hatch was renamed, removed, or never applied. */
  | "marker-not-honored"
  /** The probe ran but produced no readable debug log. */
  | "unparsable"
  /** The probe could not run: missing binary, crash, timeout. */
  | "probe-failed";

export type GrokPermissionPreflight = {
  /** True only for a verified `neutralized`. Everything else degrades loudly. */
  ok: boolean;
  status: GrokPermissionPreflightStatus;
  /** Times Grok said the Claude import was disabled. Expected: 1. */
  compatDisabledHits: number;
  /** Times Grok said it seeded auto mode from Claude. Expected: 0. */
  autoSeededHits: number;
  /** Agent version the handshake reported, for diagnostics. */
  version: string | null;
  /** One line, safe to log. Never shown verbatim to the user. */
  detail: string;
};

type CacheEntry = {
  checkedAtMs: number;
  /** Binary fingerprint the entry was measured against. */
  fingerprint: string;
  result: GrokPermissionPreflight;
};

const preflightCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GrokPermissionPreflight>>();

function cacheKey(plan: AcpSpawnPlan): string {
  // argv is part of the identity: `--permission-mode` rides it, and a chat that
  // changed posture deserves its own verdict.
  return `${plan.command}\u0000${plan.cwd}\u0000${JSON.stringify(plan.args)}`;
}

/**
 * Cheap stand-in for the binary version.
 *
 * `grok --version` would be authoritative but costs a spawn on every cache
 * lookup, which defeats the point of the cache. Size and mtime move on every
 * upgrade, so they invalidate exactly when a version check would.
 */
function binaryFingerprint(binaryPath: string): string {
  try {
    const stat = fs.statSync(binaryPath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    // A path we cannot stat cannot be fingerprinted. A fixed marker keeps the
    // cache usable; the probe itself fails loudly if the binary is really gone.
    return "unstattable";
  }
}

/**
 * Insert `--debug --debug-file <path>` into a Grok spawn plan.
 *
 * Both are GLOBAL flags, so they must land before the `agent` subcommand — the
 * same positional rule the dialect documents for `--no-auto-update`. Everything
 * else is copied verbatim so the probe measures the process the session will
 * actually run, including the kill switch already present in `plan.env`.
 */
export function withGrokDebugLogging(plan: AcpSpawnPlan, debugFilePath: string): AcpSpawnPlan {
  const agentIndex = plan.args.indexOf("agent");
  const insertAt = agentIndex >= 0 ? agentIndex : plan.args.length;
  const args = [
    ...plan.args.slice(0, insertAt),
    "--debug",
    "--debug-file",
    debugFilePath,
    ...plan.args.slice(insertAt),
  ];
  return { ...plan, args };
}

/** Read a debug log without letting a pathological file into memory. */
function readCappedLog(filePath: string): string {
  let handle: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, GROK_PREFLIGHT_LOG_READ_CAP_BYTES);
    if (length <= 0) return "";
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(handle, buffer, 0, length, 0);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing to do; the delete below is what matters.
      }
    }
  }
}

/** Best-effort delete. The log must not outlive the verdict. */
function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A log ADE cannot delete is not a reason to fail a session.
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack.length) return 0;
  return haystack.split(needle).length - 1;
}

/** Turn the probe's debug log into a verdict. Pure; the runner calls it. */
export function classifyGrokAttestLog(logText: string, version: string | null): GrokPermissionPreflight {
  const compatDisabledHits = countOccurrences(logText, GROK_COMPAT_DISABLED_MARKER);
  const autoSeededHits = countOccurrences(logText, GROK_AUTO_SEEDED_MARKER);

  if (!logText.trim().length) {
    return {
      ok: false,
      status: "unparsable",
      compatDisabledHits: 0,
      autoSeededHits: 0,
      version,
      detail: "Grok produced no debug log, so ADE could not confirm its permission state.",
    };
  }
  // Checked first: this is the harm itself, not a missing attestation about it.
  if (autoSeededHits > 0) {
    return {
      ok: false,
      status: "claude-import-active",
      compatDisabledHits,
      autoSeededHits,
      version,
      detail: `Grok seeded auto permission mode from the user's Claude settings (${autoSeededHits} time(s)).`,
    };
  }
  // No positive attestation means the hatch did not fire, or its log line was
  // renamed. Either way ADE has not verified anything, so it is not a pass.
  if (compatDisabledHits === 0) {
    return {
      ok: false,
      status: "marker-not-honored",
      compatDisabledHits,
      autoSeededHits,
      version,
      detail:
        "Grok never reported disabling its Claude settings import, so ADE could not confirm "
        + "the _GROK_CLAUDE_MARKER_OVERRIDE hatch still works on this build.",
    };
  }
  return {
    ok: true,
    status: "neutralized",
    compatDisabledHits,
    autoSeededHits,
    version,
    detail: "Grok reported its Claude settings import disabled and seeded no auto permission mode.",
  };
}

export type GrokAttestProbeResult =
  | { ok: true; logText: string; version: string | null }
  | { ok: false; error: string };

export type RunGrokAttestProbe = (args: {
  /** Spawn plan with the debug flags already spliced in. */
  spawnPlan: AcpSpawnPlan;
  debugFilePath: string;
  timeoutMs: number;
}) => Promise<GrokAttestProbeResult>;

/**
 * Default runner: one throwaway `agent stdio` process, handshake only.
 *
 * `session/close` is sent so the agent tears its own session down rather than
 * leaving it in `active_sessions.json`. The debug file is read and deleted here
 * on every exit path, including the failing ones.
 */
const spawnGrokAttestProbe: RunGrokAttestProbe = async ({ spawnPlan, debugFilePath, timeoutMs }) => {
  const connection = createAcpConnection({ dialect: grokDialect, spawnPlan });
  try {
    const { response } = await initializeAcpConnection({
      connection,
      dialect: grokDialect,
      timeoutMs,
    });
    const version = response.agentInfo?.version ?? null;
    const session = await connection.request<{ sessionId?: string }>(
      ACP_METHOD.sessionNew,
      { cwd: spawnPlan.cwd, mcpServers: [] },
      { timeoutMs },
    );
    if (session?.sessionId) {
      // Best effort. A session ADE could not close is not a failed verdict; the
      // process is about to be killed anyway.
      await connection
        .request(ACP_METHOD.sessionClose, { sessionId: session.sessionId }, { timeoutMs: 5_000 })
        .catch(() => undefined);
    }
    return { ok: true, logText: readCappedLog(debugFilePath), version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    connection.dispose("grok permission preflight finished");
    removeQuietly(debugFilePath);
  }
};

export type CheckGrokPermissionNeutralizationArgs = {
  /**
   * The plan the session itself will spawn with. The probe copies it verbatim
   * and only adds the debug flags, so it can never measure a different process
   * than the one ADE is about to run.
   */
  spawnPlan: AcpSpawnPlan;
  logger?: Pick<Logger, "info" | "warn">;
  force?: boolean;
  /** Test seam. Replaces the probe spawn. */
  run?: RunGrokAttestProbe;
  timeoutMs?: number;
  /** Test seam. Directory for the throwaway debug log. */
  debugDir?: string;
};

export function resetGrokPermissionPreflightCache(): void {
  preflightCache.clear();
}

/** Read a cached verdict without spawning anything. */
export function getCachedGrokPermissionPreflight(plan: AcpSpawnPlan): GrokPermissionPreflight | null {
  const entry = preflightCache.get(cacheKey(plan));
  if (!entry) return null;
  if (entry.fingerprint !== binaryFingerprint(plan.command)) return null;
  if (Date.now() - entry.checkedAtMs >= GROK_PREFLIGHT_TTL_MS) return null;
  return entry.result;
}

/**
 * Ask Grok whether ADE's neutralization took.
 *
 * Never throws and never blocks a session: a failed probe is a `false`, not an
 * exception. The caller shows the honest-degradation notice instead.
 */
export async function checkGrokPermissionNeutralization(
  args: CheckGrokPermissionNeutralizationArgs,
): Promise<GrokPermissionPreflight> {
  const key = cacheKey(args.spawnPlan);
  const fingerprint = binaryFingerprint(args.spawnPlan.command);

  if (!args.force) {
    const cached = getCachedGrokPermissionPreflight(args.spawnPlan);
    if (cached) return cached;
    const existing = inFlight.get(key);
    if (existing) return existing;
  }

  const run = args.run ?? spawnGrokAttestProbe;
  // OS temp, never the user's home and never `~/.grok`. Unique per probe so two
  // concurrent lanes cannot read each other's log.
  const debugFilePath = path.join(
    args.debugDir ?? os.tmpdir(),
    `ade-grok-preflight-${randomUUID()}.log`,
  );

  const probe = (async (): Promise<GrokPermissionPreflight> => {
    let outcome: GrokAttestProbeResult;
    try {
      outcome = await run({
        spawnPlan: withGrokDebugLogging(args.spawnPlan, debugFilePath),
        debugFilePath,
        timeoutMs: args.timeoutMs ?? GROK_PREFLIGHT_TIMEOUT_MS,
      });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!outcome.ok) {
      return {
        ok: false,
        status: "probe-failed",
        compatDisabledHits: 0,
        autoSeededHits: 0,
        version: null,
        detail: outcome.error,
      };
    }
    return classifyGrokAttestLog(outcome.logText, outcome.version);
  })()
    .then((result) => {
      preflightCache.set(key, { checkedAtMs: Date.now(), fingerprint, result });
      return result;
    })
    .finally(() => {
      // Belt and braces. The default runner already deletes it; a custom runner
      // or an early throw must not leave a log behind either.
      removeQuietly(debugFilePath);
    });

  inFlight.set(key, probe);
  try {
    const result = await probe;
    if (result.ok) {
      args.logger?.info?.("ai.grok_permission_preflight.ok", {
        cwd: args.spawnPlan.cwd,
        version: result.version,
      });
    } else {
      args.logger?.warn?.("ai.grok_permission_preflight.failed", {
        cwd: args.spawnPlan.cwd,
        status: result.status,
        version: result.version,
        compatDisabledHits: result.compatDisabledHits,
        autoSeededHits: result.autoSeededHits,
        detail: result.detail,
      });
    }
    return result;
  } finally {
    inFlight.delete(key);
  }
}
