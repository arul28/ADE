/**
 * Brake for the `computeStatus` merge-box GraphQL read.
 *
 * `fetchMergeStateViaGraphql` is called once per `getStatus` / `getStatusByGithub`,
 * and `getStatus` is on the PR detail pane's 2.5s mergeability re-poll — so its
 * request rate is set by however many surfaces are watching a PR, not by
 * anything this service controls. It had no brake of its own: on 2026-08-21 a
 * single PR logged `prs.computeStatus.stack_graphql_fallback` and
 * `prs.computeStatus.graphql_failed` 5,601 times *each* in two hours (~47
 * iterations/min), every one rejecting with "API rate limit already exceeded".
 * Two defects compounded there and both are addressed here:
 *
 * 1. The stack -> no-stack fallback retried the *same* endpoint immediately on
 *    *any* failure, so a rate limit cost two requests instead of one. A schema
 *    failure (the repo's GraphQL schema has no `stack` field) is the only
 *    failure the fallback can fix, and it is a property of the repo, so it is
 *    remembered rather than rediscovered on every call.
 * 2. Nothing rose in cost as the failures repeated. GitHub asks integrations to
 *    stop requesting entirely while limited, so a rate-limit answer arms a
 *    per-repo cooldown that runs to the reset instant GitHub named (or five
 *    minutes, whichever is later) during which no attempt is made at all.
 *
 * The 11,202 identical warn lines are their own defect, so the cooldown also
 * carries the log budget: one line per armed window, not one per short-circuit.
 *
 * State is in-memory, like `githubReadBackoff` and the reconcile throttles it
 * sits beside — a cooldown that outlived the process would describe a quota
 * that has since reset.
 */

/**
 * Floor for a rate-limit cooldown. GitHub's reset instant wins when it is
 * further out; this covers a rate-limit answer that carries no reset at all
 * (a secondary limit with no `retry-after`, or a client-side short-circuit
 * whose credential health entry has expired).
 */
export const MERGE_STATE_GRAPHQL_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/**
 * Minimum spacing between stack -> no-stack fallback attempts for one PR. The
 * fallback exists to recover from schema drift, which `noteStackFieldUnsupported`
 * already remembers; anything reaching this throttle is a transient failure the
 * caller's own re-poll will retry anyway, so spacing it costs nothing.
 */
export const MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS = 5 * 60_000;

export type MergeStateGraphqlCooldown = {
  /** Epoch ms the cooldown runs to. */
  untilMs: number;
  /**
   * True for the first short-circuit of this armed window only. Reading it
   * consumes the window's log budget — the point is one warn per cooldown, not
   * one per caller.
   */
  shouldLog: boolean;
};

export type MergeStateGraphqlBrake = {
  /** The live cooldown for `repoKey`, or null when the read may proceed. */
  cooldown: (repoKey: string, nowMs?: number) => MergeStateGraphqlCooldown | null;
  /** Arms (or extends) the per-repo cooldown. Returns the deadline it applied. */
  armRateLimitCooldown: (
    repoKey: string,
    rateLimitResetAtMs: number | null,
    nowMs?: number,
  ) => number;
  /** True when this repo's GraphQL schema is known not to carry `stack`. */
  isStackFieldUnsupported: (repoKey: string) => boolean;
  /** Records that GitHub rejected the `stack` field for this repo. */
  noteStackFieldUnsupported: (repoKey: string) => void;
  /** True when `prKey` may spend a fallback request now; stamps it when it does. */
  allowFallback: (prKey: string, nowMs?: number) => boolean;
  /**
   * Drops the cooldown and fallback stamps for one repo, or for every repo when
   * called with no argument. The schema memo survives on purpose: losing a
   * credential does not add a `stack` field to the repo's schema.
   */
  clear: (repoKey?: string) => void;
};

type CooldownEntry = { untilMs: number; logged: boolean };

export function createMergeStateGraphqlBrake(): MergeStateGraphqlBrake {
  const cooldowns = new Map<string, CooldownEntry>();
  const stackUnsupportedRepos = new Set<string>();
  const lastFallbackAtMsByPr = new Map<string, number>();

  const readCooldown = (repoKey: string, nowMs: number): CooldownEntry | null => {
    const entry = cooldowns.get(repoKey);
    if (!entry) return null;
    if (entry.untilMs <= nowMs) {
      cooldowns.delete(repoKey);
      return null;
    }
    return entry;
  };

  return {
    cooldown: (repoKey, nowMs = Date.now()) => {
      const entry = readCooldown(repoKey, nowMs);
      if (!entry) return null;
      const shouldLog = !entry.logged;
      entry.logged = true;
      return { untilMs: entry.untilMs, shouldLog };
    },

    armRateLimitCooldown: (repoKey, rateLimitResetAtMs, nowMs = Date.now()) => {
      const reset = rateLimitResetAtMs != null && Number.isFinite(rateLimitResetAtMs)
        ? rateLimitResetAtMs
        : 0;
      const untilMs = Math.max(nowMs + MERGE_STATE_GRAPHQL_RATE_LIMIT_COOLDOWN_MS, reset);
      const existing = readCooldown(repoKey, nowMs);
      // Never shorten a live cooldown, and never re-open its log budget: a
      // second rate-limit answer inside one window is the same incident.
      if (existing && existing.untilMs >= untilMs) return existing.untilMs;
      cooldowns.set(repoKey, { untilMs, logged: existing?.logged ?? false });
      return untilMs;
    },

    isStackFieldUnsupported: (repoKey) => stackUnsupportedRepos.has(repoKey),

    noteStackFieldUnsupported: (repoKey) => {
      stackUnsupportedRepos.add(repoKey);
    },

    allowFallback: (prKey, nowMs = Date.now()) => {
      const last = lastFallbackAtMsByPr.get(prKey) ?? 0;
      if (last > 0 && nowMs - last < MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS) return false;
      // One entry per PR the process ever fell back on, and nothing reads a key
      // again once its PR is closed — sweep on write, like `githubReadBackoff`.
      for (const [key, stampedAtMs] of lastFallbackAtMsByPr) {
        if (nowMs - stampedAtMs >= MERGE_STATE_GRAPHQL_FALLBACK_MIN_INTERVAL_MS) {
          lastFallbackAtMsByPr.delete(key);
        }
      }
      lastFallbackAtMsByPr.set(prKey, nowMs);
      return true;
    },

    clear: (repoKey) => {
      if (repoKey === undefined) {
        cooldowns.clear();
        lastFallbackAtMsByPr.clear();
        return;
      }
      cooldowns.delete(repoKey);
      for (const key of lastFallbackAtMsByPr.keys()) {
        if (key.startsWith(`${repoKey}#`)) lastFallbackAtMsByPr.delete(key);
      }
    },
  };
}
