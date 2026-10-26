import type { GitHubRepoRef, PrActionJob } from "../../../shared/types";
import { setBounded } from "../../../shared/boundedMap";
import { createKeyedPromiseCache } from "../../../shared/expiringPromiseCache";

/**
 * The GitHub answers the PR service keeps so that opening and refreshing a PR
 * does not ask GitHub the same thing twice. Every key starts with the repo,
 * so a write through ADE can drop that repo's answers in one sweep.
 */

/** `owner/name`, trimmed and lowercased: GitHub treats repo names case-insensitively. */
export function githubRepoKey(repo: GitHubRepoRef): string {
  return `${repo.owner.trim().toLowerCase()}/${repo.name.trim().toLowerCase()}`;
}

export type SettledCommitCheck = "success" | "failure" | "none";

/**
 * Shared reads: opening a PR asks for its status, checks and reviews
 * together, and each of those read the head's check-runs and combined status
 * (and the reviews) on its own: three check-runs reads and two of the rest
 * for one open. A read in flight is joined; a settled one is reused for 5 s,
 * the same window as the raw pull memo. Failures are never kept. Callers copy
 * what they get, so one that sorts or edits the result cannot change another's.
 */
const SHARED_READ_TTL_MS = 5_000;
const SHARED_READ_MAX_ENTRIES = 192;

/**
 * Quiet reuse: GraphQL is never a free `304`, and the detail refresh asked
 * for the merge box and the review threads every minute even when every REST
 * read beside them had just come back unchanged. The pull's own record is
 * read first anyway (and is a `304` when nothing moved), so its last update,
 * head, base and GitHub's merge state fingerprint the PR: an answer is reused
 * while that fingerprint holds, for at most 3 minutes.
 */
const QUIET_REUSE_MAX_AGE_MS = 3 * 60_000;
const QUIET_REUSE_MAX_ENTRIES = 128;

/**
 * Settled check results of a PR's older commits. Only the head commit's
 * checks move in practice, yet every open read check-runs for each of up to
 * 30 commits. A settled result (success, failure, or nothing ran) is kept for
 * 30 minutes; a pending one is never kept.
 */
const SETTLED_COMMIT_CHECKS_TTL_MS = 30 * 60_000;
const SETTLED_COMMIT_CHECKS_MAX_ENTRIES = 2_000;

/**
 * Jobs of finished runs, by run and attempt. A completed attempt's jobs never
 * change (a re-run is a new attempt, so a new key), yet every detail refresh
 * used to read them again.
 */
const FINISHED_RUN_JOBS_MAX_ENTRIES = 256;

function quietFingerprint(pull: any): string | null {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const updatedAt = text(pull?.updated_at);
  const headSha = text(pull?.head?.sha);
  if (!updatedAt || !headSha) return null;
  return [updatedAt, headSha, text(pull?.base?.sha), text(pull?.mergeable_state), String(pull?.mergeable ?? "")].join("|");
}

function copyJobs(jobs: PrActionJob[]): PrActionJob[] {
  return jobs.map((job) => ({ ...job, steps: [...job.steps] }));
}

export function createPrGithubReadCache(now: () => number = Date.now) {
  const sharedReads = createKeyedPromiseCache<unknown>({
    ttlMs: SHARED_READ_TTL_MS,
    maxEntries: SHARED_READ_MAX_ENTRIES,
    now,
  });
  const quietReuse = new Map<string, { fingerprint: string; at: number; value: unknown }>();
  const settledCommitChecks = new Map<string, { status: SettledCommitCheck; at: number }>();
  const finishedRunJobs = new Map<string, PrActionJob[]>();
  /**
   * Bumped by every forget, so a read that started before a write cannot
   * store its pre-write answer after the write cleared the repo.
   */
  const generationByRepo = new Map<string, number>();
  let generation = 0;
  const generationOf = (repoKey: string): number => generation + (generationByRepo.get(repoKey) ?? 0);

  return {
    /** Joins or reuses a read of `what` (for example `status:<sha>`) in `repo`. */
    shared<T>(repo: GitHubRepoRef, what: string, load: () => Promise<T>): Promise<T> {
      return sharedReads.read(`${githubRepoKey(repo)}|${what}`, load) as Promise<T>;
    },

    /**
     * Reuses a GraphQL answer while `pull` is unchanged. `settled` says
     * whether an answer may be kept: one GitHub is still working out
     * (mergeability computing) is not.
     */
    async whileQuiet<T>(
      repo: GitHubRepoRef,
      what: string,
      pull: unknown,
      load: () => Promise<T>,
      settled: (value: T) => boolean = () => true,
    ): Promise<T> {
      const repoKey = githubRepoKey(repo);
      const key = `${repoKey}|${what}`;
      const fingerprint = quietFingerprint(pull);
      const known = quietReuse.get(key);
      if (fingerprint && known && known.fingerprint === fingerprint && now() - known.at < QUIET_REUSE_MAX_AGE_MS) {
        return structuredClone(known.value) as T;
      }
      const startedAt = generationOf(repoKey);
      const value = await load();
      if (generationOf(repoKey) !== startedAt) return value;
      if (fingerprint && value != null && settled(value)) {
        setBounded(quietReuse, key, { fingerprint, at: now(), value: structuredClone(value) }, QUIET_REUSE_MAX_ENTRIES);
      } else {
        quietReuse.delete(key);
      }
      return value;
    },

    commitCheck(repo: GitHubRepoRef, sha: string): SettledCommitCheck | null {
      const settled = settledCommitChecks.get(`${githubRepoKey(repo)}|${sha}`);
      return settled && now() - settled.at < SETTLED_COMMIT_CHECKS_TTL_MS ? settled.status : null;
    },

    /** Keeps a commit's check result once it has settled; a pending one is ignored. */
    noteCommitCheck(repo: GitHubRepoRef, sha: string, status: SettledCommitCheck | "pending"): void {
      if (status === "pending") return;
      setBounded(settledCommitChecks, `${githubRepoKey(repo)}|${sha}`, { status, at: now() }, SETTLED_COMMIT_CHECKS_MAX_ENTRIES);
    },

    /** A copy of a finished run attempt's jobs, or null when not kept. */
    finishedJobs(repo: GitHubRepoRef, runId: number, attempt: number): PrActionJob[] | null {
      const jobs = finishedRunJobs.get(`${githubRepoKey(repo)}|${runId}|${attempt}`);
      return jobs ? copyJobs(jobs) : null;
    },

    /** Call only when the run and every one of its jobs have completed. */
    noteFinishedJobs(repo: GitHubRepoRef, runId: number, attempt: number, jobs: PrActionJob[]): void {
      setBounded(finishedRunJobs, `${githubRepoKey(repo)}|${runId}|${attempt}`, copyJobs(jobs), FINISHED_RUN_JOBS_MAX_ENTRIES);
    },

    /**
     * Drops a repo's shared and quiet answers after a write that can change
     * them. Settled checks and finished jobs cannot change, so they stay.
     */
    forgetRepo(repo: GitHubRepoRef): void {
      const repoKey = githubRepoKey(repo);
      setBounded(generationByRepo, repoKey, (generationByRepo.get(repoKey) ?? 0) + 1, QUIET_REUSE_MAX_ENTRIES);
      const prefix = `${repoKey}|`;
      sharedReads.forget((key) => key.startsWith(prefix));
      for (const key of Array.from(quietReuse.keys())) {
        if (key.startsWith(prefix)) quietReuse.delete(key);
      }
    },

    /** Drops every shared and quiet answer (a new token or account). */
    clearLive(): void {
      generation += 1;
      sharedReads.clear();
      quietReuse.clear();
    },
  };
}

export type PrGithubReadCache = ReturnType<typeof createPrGithubReadCache>;
