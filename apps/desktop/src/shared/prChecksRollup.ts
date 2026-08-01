import type { PrChecksStatus } from "./types/prs";
import { pipelineStateOf, worstPipelineState } from "./prPipelineState";
import type { PrPipelineState } from "./types/prs";

/**
 * Canonical PR checks rollup.
 *
 * ADE-135: this used to be `toChecksStatusFromCheckRuns` inside prService, and
 * it answered "did anything succeed?" rather than "was this code verified?".
 * On PR #988 three third-party apps reported `success` — CodeRabbit while
 * rate-limited, Vercel while cancelled by an ignored-build step, and a comment
 * bot — GitHub Actions registered no suite at all, and the card read
 * "CI passed · 3 jobs". Absence rendered as success.
 *
 * Three rules now govern a green rollup:
 *
 *  1. State mapping is delegated to `prPipelineState`, so `skipped`/`neutral`
 *     can no longer masquerade as success and the rollup can no longer
 *     disagree with the per-job rows rendered beneath it.
 *  2. Green requires a *CI producer* — GitHub Actions or a legacy commit
 *     status. Preview/review/comment apps still render, but cannot carry a
 *     green on their own.
 *  3. Required contexts that never reported hold the rollup back, so a missing
 *     job is visible rather than silently absent.
 *
 * When none of that can be established we return `not_run`, which is a claim
 * about our own knowledge rather than about the code.
 */

/** GitHub App slugs whose successes constitute actual verification. */
const CI_PRODUCER_APP_SLUGS = new Set(["github-actions"]);

/**
 * Below this age a missing CI run is more likely "hasn't started" than
 * "never happened", and the copy softens accordingly. GitHub typically
 * registers a check suite within seconds; five minutes is generous.
 */
export const CI_PENDING_GRACE_MS = 5 * 60 * 1000;

export type ChecksRollupCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  /** `app.slug` from the check-runs payload; null when GitHub omitted it. */
  appSlug: string | null;
};

export type ChecksRollupCommitStatus = {
  context: string;
  /** Legacy commit-status state: success | failure | error | pending. */
  state: string;
};

/** Which tier of the required-context lookup answered. */
export type RequiredContextSource =
  | "rulesets"
  | "branch_protection"
  | "merge_state"
  | "unavailable";

export type ChecksRollupInput = {
  checkRuns: readonly ChecksRollupCheckRun[];
  commitStatuses: readonly ChecksRollupCommitStatus[];
  /**
   * Required check contexts for the base branch, or null when no credential
   * we hold could read them. Null means "unknown", never "none required".
   */
  requiredContexts: readonly string[] | null;
  requiredSource: RequiredContextSource;
  /**
   * GraphQL `mergeStateStatus === "blocked"`. Corroborating only: it conflates
   * missing checks with review-required and out-of-date branches, so it may
   * strengthen a not-run finding but must never downgrade a genuine pass.
   */
  mergeStateBlocked: boolean;
  /** Age of the head commit, used only to choose between "yet" and "never". */
  headCommitAgeMs: number | null;
};

export type ChecksRollup = {
  status: PrChecksStatus;
  /**
   * One sentence explaining a non-obvious rollup, surfaced in the row tooltip,
   * the chat card subtitle, and support triage. Null when the state speaks for
   * itself (a clean pass, a plain failure).
   */
  reason: string | null;
  /** Required contexts with no observed run, in the order the API declared. */
  missingRequiredContexts: string[];
};

/**
 * Shared so every surface groups by the same notion of "real CI producer".
 * The chat card (`prChatCards.ts`) splits its rows with this predicate, and a
 * second copy of the slug list is exactly how the rollup and the card would
 * drift back into disagreeing about what "CI" means.
 */
export function isCiProducerAppSlug(slug: string | null | undefined): boolean {
  const value = (slug ?? "").trim().toLowerCase();
  // A missing slug is treated as non-CI: GitHub always populates it for
  // Actions, so an absent one means we cannot vouch for the producer.
  return CI_PRODUCER_APP_SLUGS.has(value);
}

/**
 * Sentinel `appSlug` prService stamps on legacy combined-status contexts, which
 * are produced by no GitHub App at all.
 */
export const COMMIT_STATUS_APP_SLUG = "commit_status";

/**
 * CI membership for a flattened `PrCheck` row, where check runs and legacy
 * commit statuses arrive in one list.
 *
 * The rollup keeps those two apart (`checkRuns` vs `commitStatuses`) and counts
 * both as CI producers — Jenkins, Buildkite and CircleCI still report through
 * the commit-status API. Surfaces that only have the merged list use this.
 * Anything unattributed stays out: an unknown producer cannot carry a green.
 */
export function isCiProducerCheck(appSlug: string | null | undefined): boolean {
  const value = (appSlug ?? "").trim().toLowerCase();
  return value === COMMIT_STATUS_APP_SLUG || isCiProducerAppSlug(value);
}

function isCiProducer(run: ChecksRollupCheckRun): boolean {
  return isCiProducerAppSlug(run.appSlug);
}

function commitStatusState(state: string): PrPipelineState {
  const value = state.trim().toLowerCase();
  if (value === "success") return "passed";
  if (value === "failure" || value === "error") return "failed";
  if (value === "pending") return "running";
  return "unknown";
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatContexts(contexts: readonly string[], limit = 3): string {
  if (contexts.length <= limit) return contexts.join(", ");
  const shown = contexts.slice(0, limit).join(", ");
  return `${shown}, +${contexts.length - limit} more`;
}

/**
 * Derive the rollup. Pure: every input is supplied by the caller so both the
 * webhook and polling paths, and the tests, exercise identical logic.
 */
export function rollupChecks(input: ChecksRollupInput): ChecksRollup {
  const ciRuns = input.checkRuns.filter(isCiProducer);
  const otherRuns = input.checkRuns.filter((run) => !isCiProducer(run));

  const ciStates: PrPipelineState[] = [
    ...ciRuns.map((run) =>
      pipelineStateOf({
        status:
          run.status === "queued" || run.status === "in_progress" || run.status === "completed"
            ? run.status
            : "completed",
        conclusion: run.conclusion,
      }),
    ),
    ...input.commitStatuses.map((status) => commitStatusState(status.state)),
  ];

  const observedContexts = new Set<string>([
    ...input.checkRuns.map((run) => run.name.trim()).filter(Boolean),
    ...input.commitStatuses.map((status) => status.context.trim()).filter(Boolean),
  ]);
  const missingRequiredContexts = (input.requiredContexts ?? []).filter(
    (context) => !observedContexts.has(context.trim()),
  );

  const ciProducerCount = ciStates.length;
  const hasFailure = ciStates.some((state) => state === "failed");
  const hasInFlight = ciStates.some((state) => state === "running" || state === "queued");
  const hasPass = ciStates.some((state) => state === "passed");
  const worst = worstPipelineState(ciStates);

  // A real failure outranks everything, including missing required checks:
  // the actionable fact is the red job, not the absent one.
  if (hasFailure) {
    return { status: "failing", reason: null, missingRequiredContexts };
  }

  if (hasInFlight) {
    return {
      status: "pending",
      reason:
        missingRequiredContexts.length > 0
          ? `Waiting on ${pluralize(missingRequiredContexts.length, "required check", "required checks")}: ${formatContexts(missingRequiredContexts)}.`
          : null,
      missingRequiredContexts,
    };
  }

  // Required checks are known and some never reported. Something is expected
  // that has not arrived, so the rollup stays open rather than going green.
  if (missingRequiredContexts.length > 0) {
    const stale = (input.headCommitAgeMs ?? 0) >= CI_PENDING_GRACE_MS;
    return {
      status: hasPass || ciProducerCount > 0 ? "pending" : "not_run",
      reason: `${pluralize(missingRequiredContexts.length, "required check has", "required checks have")} not reported${stale ? "" : " yet"}: ${formatContexts(missingRequiredContexts)}.`,
      missingRequiredContexts,
    };
  }

  if (hasPass) {
    return { status: "passing", reason: null, missingRequiredContexts };
  }

  // CI producers reported, but every one of them was skipped or neutral.
  // Nothing was verified, so this is not a pass.
  if (ciProducerCount > 0) {
    return {
      status: "not_run",
      reason:
        worst === "skipped"
          ? `Every CI check was skipped, so nothing verified this commit.`
          : `No CI check reported a result for this commit.`,
      missingRequiredContexts,
    };
  }

  // No CI producer at all. If other apps reported, or GitHub says the merge is
  // blocked, then something was expected here and its absence is the finding.
  const stale = (input.headCommitAgeMs ?? 0) >= CI_PENDING_GRACE_MS;
  if (otherRuns.length > 0) {
    return {
      status: "not_run",
      reason: `${pluralize(otherRuns.length, "check", "checks")} reported, none from a CI provider. CI has ${stale ? "not run on this commit" : "not run yet"}.`,
      missingRequiredContexts,
    };
  }
  if (input.mergeStateBlocked) {
    return {
      status: "not_run",
      reason: `No CI reported on this commit, and GitHub reports the merge as blocked.`,
      missingRequiredContexts,
    };
  }

  // Genuinely nothing anywhere, and nothing told us to expect anything. Stay
  // quiet rather than inventing a warning for repos that simply have no CI.
  return { status: "none", reason: null, missingRequiredContexts };
}
