import type { GitHubRepoRef } from "../../../shared/types/git";
import type { RequiredContextSource } from "../../../shared/prChecksRollup";

/**
 * Resolve the required status-check contexts for a base branch (ADE-135).
 *
 * Three tiers, because which one answers depends entirely on the credential
 * ADE happens to hold — it may be a GitHub App user token, a PAT, the gh CLI's
 * oauth token, or an environment token, and those differ in what GitHub will
 * show them:
 *
 *   1. `/rules/branches/{branch}` — repository rulesets. Needs only *read*
 *      access, so it works for every credential source we support. This is the
 *      tier that actually answers for most repos, including ADE's own, where
 *      it reports `ci-pass` as the single required context.
 *   2. `/branches/{branch}/protection` — classic branch protection. Requires
 *      *admin*, so it 403s for most contributors, but it is the only source for
 *      repos that never migrated to rulesets.
 *   3. `mergeStateStatus === "blocked"` — already fetched for the merge box.
 *      It cannot name contexts and it conflates "required checks missing" with
 *      "review required" and "branch out of date", so it is corroborating
 *      evidence only: enough to say something was expected, never enough to
 *      contradict a genuine pass.
 *
 * When all three come up empty we return `null` contexts, which means
 * "unknown" — never "none required". The rollup then falls back to the
 * producer rule alone rather than inventing certainty it does not have.
 */

export type RequiredChecksResult = {
  /** Required contexts, or null when no credential we hold could read them. */
  contexts: string[] | null;
  source: RequiredContextSource;
};

type CacheEntry = { value: RequiredChecksResult; expiresAt: number };

export type RequiredChecksResolver = {
  resolve: (
    repo: GitHubRepoRef,
    baseBranch: string,
    mergeStateBlocked: boolean,
  ) => Promise<RequiredChecksResult>;
  invalidate: (repo: GitHubRepoRef, baseBranch: string) => void;
};

/**
 * Branch protection changes on a human timescale, and this sits on the PR
 * refresh path which runs per webhook delivery. Five minutes keeps a busy
 * repo's rollups correct without re-asking GitHub for every check_run event.
 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function cacheKey(repo: GitHubRepoRef, baseBranch: string): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${baseBranch}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contextFromEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  const record = asRecord(entry);
  if (!record) return null;
  const context = record.context;
  return typeof context === "string" ? context.trim() || null : null;
}

/** Union of contexts across every applicable ruleset, first-seen order kept. */
function contextsFromRules(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const contexts: string[] = [];
  const seen = new Set<string>();
  for (const rule of data) {
    const record = asRecord(rule);
    if (!record || record.type !== "required_status_checks") continue;
    const parameters = asRecord(record.parameters);
    const required = parameters?.required_status_checks;
    if (!Array.isArray(required)) continue;
    for (const entry of required) {
      const context = contextFromEntry(entry);
      if (!context || seen.has(context)) continue;
      seen.add(context);
      contexts.push(context);
    }
  }
  return contexts;
}

function contextsFromProtection(data: unknown): string[] {
  const record = asRecord(data);
  const required = asRecord(record?.required_status_checks);
  if (!required) return [];
  const contexts: string[] = [];
  const seen = new Set<string>();
  // `checks` is the modern shape (context + app id); `contexts` is the legacy
  // string array. GitHub still returns both, so read whichever is populated.
  for (const source of [required.checks, required.contexts]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const context = contextFromEntry(entry);
      if (!context || seen.has(context)) continue;
      seen.add(context);
      contexts.push(context);
    }
  }
  return contexts;
}

export function createRequiredChecksResolver(args: {
  apiRequest: <T>(options: { method: "GET"; path: string }) => Promise<{ data: T }>;
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
  ttlMs?: number;
  now?: () => number;
}): RequiredChecksResolver {
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const now = args.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  const readRules = async (repo: GitHubRepoRef, baseBranch: string): Promise<string[] | null> => {
    try {
      const { data } = await args.apiRequest<unknown>({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/rules/branches/${encodeURIComponent(baseBranch)}`,
      });
      return contextsFromRules(data);
    } catch (error) {
      args.logger?.warn("prs.required_checks.rules_failed", {
        repo: `${repo.owner}/${repo.name}`,
        baseBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const readProtection = async (repo: GitHubRepoRef, baseBranch: string): Promise<string[] | null> => {
    try {
      const { data } = await args.apiRequest<unknown>({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(baseBranch)}/protection`,
      });
      return contextsFromProtection(data);
    } catch {
      // 403 for non-admins is the expected case, not an incident. The rules
      // tier above already logged if it also failed, so stay quiet here.
      return null;
    }
  };

  const resolve = async (
    repo: GitHubRepoRef,
    baseBranch: string,
    mergeStateBlocked: boolean,
  ): Promise<RequiredChecksResult> => {
    const branch = baseBranch.trim();
    if (!repo.owner || !repo.name || !branch) {
      return { contexts: null, source: "unavailable" };
    }

    // Tier 3 is derived per-PR while the cache is per-branch, so the overlay is
    // applied on the way out of both the cached and the freshly-read path.
    // Applying it only to fresh reads made two PRs on the same blocked branch
    // disagree purely on cache timing.
    const withMergeStateOverlay = (value: RequiredChecksResult): RequiredChecksResult =>
      value.contexts === null && mergeStateBlocked ? { contexts: null, source: "merge_state" } : value;

    const key = cacheKey(repo, branch);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return withMergeStateOverlay(cached.value);
    }

    let result: RequiredChecksResult;
    const fromRules = await readRules(repo, branch);
    if (fromRules && fromRules.length > 0) {
      result = { contexts: fromRules, source: "rulesets" };
    } else {
      const fromProtection = await readProtection(repo, branch);
      if (fromProtection && fromProtection.length > 0) {
        result = { contexts: fromProtection, source: "branch_protection" };
      } else if (fromRules !== null || fromProtection !== null) {
        // A readable source that lists no required checks is a real answer:
        // this branch requires nothing. Distinct from "we could not look".
        result = { contexts: [], source: fromRules !== null ? "rulesets" : "branch_protection" };
      } else {
        result = { contexts: null, source: "unavailable" };
      }
    }

    cache.set(key, { value: result, expiresAt: now() + ttlMs });

    // Tier 3 never overrides a real answer; it only labels the unknown case so
    // the rollup can say *something* was expected here.
    return withMergeStateOverlay(result);
  };

  const invalidate = (repo: GitHubRepoRef, baseBranch: string): void => {
    cache.delete(cacheKey(repo, baseBranch.trim()));
  };

  return { resolve, invalidate };
}
