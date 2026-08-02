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
 *  2. Green requires either a producer that is not a known non-CI app, or a
 *     satisfied branch-protection gate. Preview/review/comment apps render but
 *     cannot carry a green on their own. See the tradeoff note on
 *     `NON_CI_PRODUCER_APP_SLUGS` for why this is a denylist and not an
 *     allowlist — the allowlist version broke every non-Actions CI provider.
 *  3. Required contexts that never reported hold the rollup back, so a missing
 *     job is visible rather than silently absent.
 *
 * When none of that can be established we return `not_run`, which is a claim
 * about our own knowledge rather than about the code.
 */

/**
 * Producers that are definitively NOT CI: preview deploys, review bots, comment
 * bots, docs builders. These are the apps that made PR #988 read green while
 * nothing verified the code, so they can never carry a pass.
 *
 * This is a denylist rather than an allowlist because the allowlist version was
 * wrong in the dangerous direction. CircleCI (`circleci-checks`), Buildkite,
 * Azure Pipelines, Semaphore and Travis all report through the *Checks API*
 * with their own slugs — not the legacy commit-status API — so an
 * Actions-only allowlist marked every one of those repos permanently
 * "CI has not run", silently and forever. Breaking real CI users to catch a
 * bot is a worse trade than the residual it leaves: an unrecognised bot can
 * still carry a green, which the required-context rule below then catches
 * wherever branch protection is readable.
 */
const NON_CI_PRODUCER_APP_SLUGS = new Set([
  "coderabbitai",
  "vercel",
  "netlify",
  "cloudflare-workers-and-pages",
  "changeset-bot",
  "copilot-pull-request-reviewer",
  "greptile-apps",
  "railway-app",
  "graphite-app",
  "mintlify",
  "cursor",
  "sonarcloud",
  "snyk-io",
  "renovate",
  "dependabot",
]);

/**
 * Fallback sentence for a `not_run` rollup whose `reason` is absent — an older
 * host, or a row written before the reason column existed. Every `not_run`
 * return below sets a reason, so this is the pre-migration path only. Shared
 * because it had already been pasted into eleven files and one copy had lost
 * its full stop.
 */
export const NO_CI_REASON = "No CI has run on this commit.";

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
  /**
   * GraphQL `mergeStateStatus === "blocked"`. Corroborating only: it conflates
   * missing checks with review-required and out-of-date branches, so it may
   * strengthen a not-run finding but must never downgrade a genuine pass.
   */
  mergeStateBlocked: boolean;
  /**
   * Age of the head commit. Distinguishes "CI has not started yet" from "CI
   * never ran", and inside the grace window holds the rollup at `pending`.
   * Null means unknown, which is treated as *stale* — a row whose age we
   * cannot establish must not have a finding hidden behind a grace window.
   */
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
  // A missing slug cannot be vouched for, so it does not count as CI.
  if (!value) return false;
  return !NON_CI_PRODUCER_APP_SLUGS.has(value);
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
  if (value === COMMIT_STATUS_APP_SLUG) return true;
  // Unlike the payload-level predicate, an ABSENT slug counts as CI here.
  // These rows come from `PrCheck` lists, and `appSlug` only started being
  // populated in this change — every persisted row, every older host, and the
  // TUI's own action payloads carry checks with no slug at all. Failing those
  // closed would report "CI has not run" for every legacy payload whose CI
  // genuinely passed, which is the original bug pointing the other way.
  // A named bot is still caught, because the denylist matches on the slug it
  // does send.
  if (!value) return true;
  return isCiProducerAppSlug(value);
}

function isCiProducer(run: ChecksRollupCheckRun): boolean {
  return isCiProducerAppSlug(run.appSlug);
}

/**
 * GitHub's check-run `status` enum is wider than the three values
 * `pipelineStateOf` accepts: `waiting`, `requested` and `pending` also occur,
 * and they arrive with a null conclusion. Folding those into `completed` would
 * make them terminal-but-unknown, and a PR sitting on a deployment-approval
 * gate would report "CI has not run" while its job is very much alive. They are
 * in-flight, so they map to `queued`.
 */
function toPipelineStatus(
  raw: string,
  conclusion: string | null,
): "queued" | "in_progress" | "completed" {
  switch (raw) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "queued":
    case "waiting":
    case "requested":
    case "pending":
    default:
      // A check can carry a terminal conclusion (e.g. `skipped`) before its
      // status flips to `completed`; the code this replaced said so explicitly.
      // Ignoring that here left `hasInFlight` true forever, so the PR could
      // never leave `pending` and the chat card stayed `live` indefinitely.
      return conclusion ? "completed" : "queued";
  }
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
        status: toPipelineStatus(run.status, run.conclusion),
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

  // Branch protection is the one authority that outranks producer guessing: if
  // every required context reported and passed, this commit was verified, no
  // matter which app ran the job. Without this, a repo whose CI is an app we do
  // not recognise would sit at "not run" while its own merge gate was satisfied.
  const requiredKnown = (input.requiredContexts?.length ?? 0) > 0;
  const passedContexts = new Set<string>([
    ...input.checkRuns
      .filter((run) => pipelineStateOf({
        status: toPipelineStatus(run.status, run.conclusion),
        conclusion: run.conclusion,
      }) === "passed")
      .map((run) => run.name.trim()),
    ...input.commitStatuses
      .filter((status) => commitStatusState(status.state) === "passed")
      .map((status) => status.context.trim()),
  ]);
  const allRequiredPassed =
    requiredKnown && (input.requiredContexts ?? []).every((context) => passedContexts.has(context.trim()));

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
    const stale = (input.headCommitAgeMs ?? Number.POSITIVE_INFINITY) >= CI_PENDING_GRACE_MS;
    return {
      // Inside the grace window a required check that has not reported is
      // simply one GitHub has not registered yet. Calling that "not run" made
      // every single push flash a spurious "CI has not run" card before the
      // suite appeared.
      status: ciProducerCount > 0 || !stale ? "pending" : "not_run",
      reason: `${pluralize(missingRequiredContexts.length, "required check has", "required checks have")} not reported${stale ? "" : " yet"}: ${formatContexts(missingRequiredContexts)}.`,
      missingRequiredContexts,
    };
  }

  // Ordered AFTER the in-flight check on purpose: a satisfied branch-protection
  // gate outranks the producer guess and the missing-context rule, but it must
  // not claim "CI passed" while another job is still running — that is the same
  // rollup-disagrees-with-the-rows failure this module exists to prevent.
  if (allRequiredPassed) {
    return { status: "passing", reason: null, missingRequiredContexts };
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
  const stale = (input.headCommitAgeMs ?? Number.POSITIVE_INFINITY) >= CI_PENDING_GRACE_MS;
  if (otherRuns.length > 0) {
    return {
      // A commit pushed seconds ago whose CI suite has not registered yet is
      // pending, not unverified. Only once the grace window closes is absence
      // a finding.
      status: stale ? "not_run" : "pending",
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

/**
 * A flattened check row as the UI surfaces see it — check runs and legacy
 * commit statuses already merged into one list, which is what `PrCheck` is.
 */
export type PrCheckRow = {
  status: string;
  conclusion: string | null;
  appSlug?: string | null;
};

export type PrChecksRowRollup = {
  status: PrChecksStatus;
  counts: { passing: number; failing: number; pending: number; skipped: number; total: number };
};

/**
 * Row-level rollup for surfaces that only ever have the merged check list and
 * no required-context knowledge — the `ade` RPC server, the TUI right pane, the
 * chat toolbars.
 *
 * ADE-135: each of those had grown its own pass/fail rule, and each got it
 * wrong differently — one initialised its verdict to "passing" so zero checks
 * read green, another counted `skipped` into the passed bucket, a third derived
 * green from row counts alone. They share this instead. It applies the same two
 * rules as `rollupChecks`: state comes from `pipelineStateOf`, and only a CI
 * producer's success can carry a green.
 */
export function rollupPrChecks(checks: readonly PrCheckRow[]): PrChecksRowRollup {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  let skipped = 0;

  for (const check of checks) {
    const state = pipelineStateOf({
      status: toPipelineStatus(check.status, check.conclusion),
      conclusion: check.conclusion,
    });
    // Only a CI producer's verdict counts toward pass/fail. Preview, review and
    // comment apps are still tallied in `total` so the UI can say how many
    // checks reported, but they cannot move the rollup.
    if (!isCiProducerCheck(check.appSlug)) continue;
    switch (state) {
      case "passed":
        passing += 1;
        break;
      case "failed":
        failing += 1;
        break;
      case "running":
      case "queued":
        pending += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      default:
        break;
    }
  }

  const counts = { passing, failing, pending, skipped, total: checks.length };
  if (failing > 0) return { status: "failing", counts };
  if (pending > 0) return { status: "pending", counts };
  if (passing > 0) return { status: "passing", counts };
  // No CI producer succeeded. If nothing at all reported we cannot even say
  // something was expected, so stay quiet; otherwise this is the ADE-135 case.
  if (checks.length === 0) return { status: "none", counts };
  return { status: "not_run", counts };
}
