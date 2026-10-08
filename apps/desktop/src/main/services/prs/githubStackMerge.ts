import { githubApiFailure } from "../github/githubApiFailure";
import { asString, getErrorMessage, isRecord } from "../shared/utils";
import type { GitHubRepoRef } from "../../../shared/types/git";
import type { GitHubPrStack, GitHubPrStackEntry, LandHeadChange, LandPrArgs, LandResult, MergeMethod } from "../../../shared/types/prs";
import { openStackEntriesThrough } from "./githubStackStore";
import { formatMergeError, isHeadModifiedMergeError } from "./resolverUtils";
import { formatHeadChangeMessage, type PrHeadChangeDetector } from "./prHeadChange";

/**
 * Merging a PR that is in a GitHub Stack. GitHub supports this only through the
 * async merge API: `PUT .../merge-async` merges every open PR from the stack
 * base up to the requested one, all or none, or adds them to the merge queue.
 * The merge runs in the background, so ADE polls `GET .../merge-async/{uuid}`.
 * Branch rules run during the merge, so a rule failure comes from the poll,
 * not from the first call.
 */

type AsyncMergeResult = {
  status: "pending" | "merged" | "enqueued" | "failed";
  uuid: string | null;
  sha: string | null;
  message: string | null;
};

function parseAsyncMergeResult(raw: unknown): AsyncMergeResult {
  const body = isRecord(raw) ? raw : {};
  const details = isRecord(body.details) ? body.details : {};
  const status = asString(body.status).trim().toLowerCase();
  return {
    status: status === "merged" || status === "enqueued" || status === "failed" ? status : "pending",
    uuid: asString(details.uuid).trim() || null,
    sha: asString(details.sha).trim() || null,
    message: asString(details.message).trim() || null,
  };
}

/** How long `land` waits for a stack merge before it answers "still merging". */
const FOREGROUND_WAIT_MS = 20_000;
/** How long ADE keeps polling in the background after that. */
const BACKGROUND_WAIT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 2_000;
/**
 * A bypass merge from above the bottom merges one layer at a time. How long it
 * waits for GitHub to restack the next layer onto the base, and how long one
 * layer's merge may run.
 */
const LAYER_READY_WAIT_MS = 3 * 60_000;
const LAYER_MERGE_WAIT_MS = 5 * 60_000;
/** Start attempts per layer while GitHub is still restacking it. */
const LAYER_START_ATTEMPTS = 6;
const LAYER_RETRY_DELAY_MS = 5_000;
/** A ref in a URL path: each segment encoded, the branch's own slashes kept. */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** GitHub's compare API lists at most this many files; a full list proves nothing. */
const COMPARE_FILE_CAP = 300;

/**
 * What each covered layer must still be when its turn comes: the stale-head
 * guard of a single merge, carried through a layered run. The bottom layer is
 * not restacked before it merges, so its head SHA is enough (`content` null).
 * GitHub rewrites a higher layer's SHAs when it restacks it onto the base, so
 * that layer is held to a fingerprint of its own changes instead: the same
 * commits leaving the same files as when the merge was confirmed.
 */
type LayerGuard = { prNumber: number; headSha: string; content: string | null };

/** GitHub refused the merge on branch rules (reviews, checks, protected ref). */
const RULES_REFUSAL = /protected ref|approving review|required status|review is required|branch rules?|branch protection/i;

/** A rules refusal is the one an override fixes, so the message says where it is. */
function withBypassHint(message: string, args: Pick<LandPrArgs, "bypassRules">): string {
  if (args.bypassRules || !RULES_REFUSAL.test(message)) return message;
  return `${message} To override, merge again with "Bypass branch rules" (needs bypass permission).`;
}

/**
 * A refusal that means "not yet": GitHub has not finished restacking the layer
 * onto the base after the layer below merged. A rule or permission refusal is
 * final and is not in this list.
 */
function isRestackPendingFailure(message: string, status: number | null): boolean {
  if (RULES_REFUSAL.test(message) || /bypass|permission|not authorized/i.test(message)) return false;
  if (status === 409) return true;
  return /not mergeable|mergeable state|base branch was modified|being (re)?based|rebas(e|ing) in progress|try again/i.test(message);
}

type PullRequestRowRef = { id: string; lane_id: string };

export type GithubStackMergeDeps = {
  githubService: {
    apiRequest: <T>(args: {
      method: "GET" | "PUT" | "DELETE";
      path: string;
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined | null>;
    }) => Promise<{ data: T }>;
  };
  githubStackStore: { reconcile: (repo: GitHubRepoRef, stackNumber: number) => Promise<GitHubPrStack> };
  operationService: {
    finish: (args: { operationId: string; status: "succeeded" | "failed"; metadataPatch?: Record<string, unknown> }) => void;
  };
  laneService: { archive: (args: { laneId: string }) => Promise<unknown> };
  logger: { warn: (event: string, meta?: Record<string, unknown>) => void };
  fetchPr: (repo: GitHubRepoRef, prNumber: number, options: { fresh: true }) => Promise<any>;
  /** A fetched PR's head branch when it lives in `repo`; null for a fork. */
  sameRepoHeadBranch: (pull: unknown, repo: GitHubRepoRef) => string | null;
  deleteRemoteHeadBranch: (repo: GitHubRepoRef, prNumber: number, headBranch: string) => Promise<boolean>;
  getRowForRepoPr: (repoOwner: string, repoName: string, prNumber: number) => PullRequestRowRef | null;
  recordMergeOutcome: (prId: string, outcome: { method?: MergeMethod | null; mergedByLogin?: string | null }) => void;
  resolveViewerLoginForMerge: () => Promise<string | null>;
  forgetActivityInputs: (repo: GitHubRepoRef, prNumber: number) => void;
  markHotRefresh: (prIds: string[]) => void;
  refreshOne: (prId: string) => Promise<unknown>;
  refreshDefaultBranchAfterMerge?: (baseBranch: string) => Promise<void>;
  invalidateGithubSnapshotCache: () => void;
  delay: (ms: number) => Promise<void>;
  headChange: PrHeadChangeDetector;
};

export function createGithubStackMerge(deps: GithubStackMergeDeps) {
  const { githubService, logger } = deps;

  /**
   * Clean up after a stack merge. Lighter than a single-PR merge's cleanup:
   * GitHub rebases and retargets the rest of the stack itself, so ADE must not
   * auto-rebase child lanes on top of that. Only the requested PR's lane is
   * archived; the other merged layers keep theirs.
   */
  const finishMerge = async (
    repo: GitHubRepoRef,
    stackNumber: number,
    prNumbers: number[],
    args: LandPrArgs,
    requestedPrNumber: number,
  ): Promise<{ branchDeleted: boolean; laneArchived: boolean }> => {
    const mergedByLogin = await deps.resolveViewerLoginForMerge();
    let branchDeleted = false;
    let laneArchived = false;
    // Top of the stack first, so a lower branch is never deleted while a PR
    // above it may still use it as its base.
    for (const prNumber of [...prNumbers].reverse()) {
      deps.forgetActivityInputs(repo, prNumber);
      const row = deps.getRowForRepoPr(repo.owner, repo.name, prNumber);
      if (row) deps.recordMergeOutcome(row.id, { method: args.method, mergedByLogin });
      if (args.deleteRemoteBranch && (await deleteMergedBranch(repo, prNumber))) branchDeleted = true;
      if (args.archiveLane && row && prNumber === requestedPrNumber) {
        try {
          await deps.laneService.archive({ laneId: row.lane_id });
          laneArchived = true;
        } catch (error) {
          logger.warn("prs.lane_archive_failed", { prId: row.id, laneId: row.lane_id, error: getErrorMessage(error) });
        }
      }
      if (row) {
        deps.markHotRefresh([row.id]);
        await deps.refreshOne(row.id).catch(() => {});
      }
    }
    if (deps.refreshDefaultBranchAfterMerge) {
      const mergedBaseBranches = new Set<string>();
      for (const prNumber of prNumbers) {
        const pull = await deps.fetchPr(repo, prNumber, { fresh: true }).catch(() => null);
        const baseBranch = asString(pull?.base?.ref).trim();
        if (baseBranch) mergedBaseBranches.add(baseBranch);
      }
      for (const baseBranch of mergedBaseBranches) {
        try {
          await deps.refreshDefaultBranchAfterMerge(baseBranch);
        } catch (error) {
          logger.warn("prs.default_branch_refresh_failed", {
            stackNumber,
            baseBranch,
            error: getErrorMessage(error),
          });
        }
      }
    }
    deps.invalidateGithubSnapshotCache();
    await deps.githubStackStore.reconcile(repo, stackNumber).catch((error) => {
      logger.warn("prs.stack_reconcile_after_merge_failed", { stackNumber, error: getErrorMessage(error) });
    });
    return { branchDeleted, laneArchived };
  };

  /**
   * Delete a merged stack PR's head branch, but only when GitHub reports the PR
   * merged and no open PR still uses the branch as its base. GitHub retargets
   * the PR above in the background; until it has, deleting the branch closes
   * that PR.
   */
  const deleteMergedBranch = async (repo: GitHubRepoRef, prNumber: number): Promise<boolean> => {
    const pull = await deps.fetchPr(repo, prNumber, { fresh: true }).catch(() => null);
    if (!asString(pull?.merged_at)) return false;
    const headBranch = deps.sameRepoHeadBranch(pull, repo);
    if (!headBranch) return false;
    const dependents = await githubService.apiRequest<unknown[]>({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      query: { state: "open", base: headBranch, per_page: 1 },
    }).then(({ data }) => (Array.isArray(data) ? data.length : 1)).catch(() => 1);
    if (dependents > 0) {
      logger.warn("prs.stack_merge_branch_kept", { repo: `${repo.owner}/${repo.name}`, prNumber, headBranch });
      return false;
    }
    return await deps.deleteRemoteHeadBranch(repo, prNumber, headBranch);
  };

  /**
   * Start an async merge of `prNumber`. A 409 means a merge of this PR is
   * already running; GitHub sends that merge's id, so follow it instead of
   * starting a second one.
   */
  const startMerge = async (
    repo: GitHubRepoRef,
    prNumber: number,
    body: Record<string, unknown>,
  ): Promise<{ started: AsyncMergeResult } | { error: unknown }> => {
    try {
      const response = await githubService.apiRequest<unknown>({
        method: "PUT",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/merge-async`,
        body,
      });
      return { started: parseAsyncMergeResult(response.data) };
    } catch (error) {
      const failure = githubApiFailure(error);
      const running = failure?.status === 409 ? parseAsyncMergeResult(failure.body) : null;
      return running?.uuid ? { started: running } : { error };
    }
  };

  /** The PR's merge, read fresh from GitHub; null while it is not merged. */
  const mergedOnGitHub = async (repo: GitHubRepoRef, prNumber: number): Promise<{ sha: string | null } | null> => {
    const pull = await deps.fetchPr(repo, prNumber, { fresh: true }).catch(() => null);
    return asString(pull?.merged_at) ? { sha: asString(pull?.merge_commit_sha) || null } : null;
  };

  const pollMerge = async (
    repo: GitHubRepoRef,
    prNumber: number,
    from: AsyncMergeResult,
    deadline: number,
  ): Promise<AsyncMergeResult> => {
    let current = from;
    while (current.status === "pending" && current.uuid && Date.now() < deadline) {
      await deps.delay(POLL_INTERVAL_MS);
      try {
        const { data } = await githubService.apiRequest<unknown>({
          method: "GET",
          path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/merge-async/${encodeURIComponent(current.uuid)}`,
        });
        current = { ...parseAsyncMergeResult(data), uuid: current.uuid };
      } catch (error) {
        // 404: GitHub dropped the result. Stop polling; the PR state is the
        // truth from here.
        if (githubApiFailure(error)?.status === 404) break;
      }
    }
    if (current.status === "pending") {
      // Out of time, or GitHub dropped the result. The PR itself still says
      // whether the merge happened.
      const merged = await mergedOnGitHub(repo, prNumber);
      if (merged) return { ...current, status: "merged", sha: merged.sha };
    }
    return current;
  };

  /** Refresh these PRs' rows soon: the merge queue decides when they land. */
  const markHotRows = (repo: GitHubRepoRef, prNumbers: number[]) => {
    for (const number of prNumbers) {
      const row = deps.getRowForRepoPr(repo.owner, repo.name, number);
      if (row) deps.markHotRefresh([row.id]);
    }
  };

  /**
   * Wait until `prNumber` is the bottom open PR of the stack, the only place
   * GitHub honors a bypass. After the layer below merges, GitHub moves this
   * one onto the base in the background.
   */
  const waitUntilBottom = async (
    repo: GitHubRepoRef,
    stackNumber: number,
    prNumber: number,
  ): Promise<"ready" | "merged" | { stop: string }> => {
    const deadline = Date.now() + LAYER_READY_WAIT_MS;
    let lastError: string | null = null;
    for (;;) {
      try {
        const stack = await deps.githubStackStore.reconcile(repo, stackNumber);
        const entry = stack.entries.find((candidate) => candidate.githubPrNumber === prNumber);
        if (!entry) return { stop: `#${prNumber} is no longer in Stack #${stackNumber}.` };
        if (entry.mergedAt) return "merged";
        if (entry.state !== "open") return { stop: `#${prNumber} is closed.` };
        if (openStackEntriesThrough(stack, prNumber).length === 1) return "ready";
      } catch (error) {
        lastError = getErrorMessage(error);
      }
      if (Date.now() >= deadline) {
        return {
          stop: lastError
            ? `ADE could not read Stack #${stackNumber} from GitHub: ${lastError}`
            : `GitHub did not move #${prNumber} to the bottom of Stack #${stackNumber} in time.`,
        };
      }
      await deps.delay(POLL_INTERVAL_MS * 2);
    }
  };

  /**
   * A fingerprint of a layer's own changes: the commits in `head` that `base`
   * lacks, and the files they leave behind (name and content). `tooLarge` when
   * GitHub's compare result is truncated and so proves nothing; null when
   * GitHub cannot say.
   */
  const layerContentBetween = async (
    repo: GitHubRepoRef,
    base: string,
    head: string,
  ): Promise<string | "tooLarge" | null> => {
    try {
      const { data } = await githubService.apiRequest<unknown>({
        method: "GET",
        path: `/repos/${repo.owner}/${repo.name}/compare/${encodeRefPath(base)}...${encodeRefPath(head)}`,
      });
      if (!isRecord(data) || !Array.isArray(data.commits) || !Array.isArray(data.files)) return null;
      const totalCommits = Number(data.total_commits);
      if (Number.isFinite(totalCommits) && totalCommits > data.commits.length) return "tooLarge";
      if (data.files.length >= COMPARE_FILE_CAP) return "tooLarge";
      return JSON.stringify({
        messages: data.commits.map((commit) => asString(isRecord(commit) && isRecord(commit.commit) ? commit.commit.message : "").trim()),
        files: data.files
          .map((file) => (isRecord(file) ? `${asString(file.filename)}:${asString(file.status)}:${asString(file.sha)}` : ""))
          .sort(),
      });
    } catch {
      return null;
    }
  };

  const snapshotLayerGuards = async (
    repo: GitHubRepoRef,
    entries: GitHubPrStackEntry[],
  ): Promise<LayerGuard[] | { stop: string }> => {
    const guards: LayerGuard[] = [];
    let previousHeadSha: string | null = null;
    for (const entry of entries) {
      if (!entry.headSha) return { stop: `ADE could not read #${entry.githubPrNumber}'s head from GitHub.` };
      let content: string | null = null;
      if (previousHeadSha) {
        const read = await layerContentBetween(repo, previousHeadSha, entry.headSha);
        if (read === "tooLarge") {
          return {
            stop: `#${entry.githubPrNumber} is too large for GitHub to list its changes, so ADE cannot guard a bypass merge of it. Merge the stack one PR at a time from the bottom.`,
          };
        }
        if (!read) return { stop: `ADE could not read #${entry.githubPrNumber}'s changes from GitHub to guard the merge.` };
        content = read;
      }
      guards.push({ prNumber: entry.githubPrNumber, headSha: entry.headSha, content });
      previousHeadSha = entry.headSha;
    }
    return guards;
  };

  /**
   * The head to merge a layer at now, or why not. A restacked layer must hold
   * exactly the changes it had when the merge was confirmed; anything pushed
   * since would otherwise merge with the bypass.
   */
  const verifyLayerHead = async (repo: GitHubRepoRef, guard: LayerGuard): Promise<{ sha: string } | { stop: string }> => {
    const expected = guard.content;
    if (!expected) return { sha: guard.headSha };
    const pull = await deps.fetchPr(repo, guard.prNumber, { fresh: true }).catch(() => null);
    const headSha = asString(pull?.head?.sha).trim();
    // The base branch's current tip, not `base.sha`, which can lag behind the
    // squash merge of the layer below and add that commit to the comparison.
    const base = asString(pull?.base?.ref).trim() || asString(pull?.base?.sha).trim();
    if (!headSha || !base) return { stop: "ADE could not read its head from GitHub." };
    if (headSha === guard.headSha) return { sha: headSha };
    const current = await layerContentBetween(repo, base, headSha);
    if (current === "tooLarge") return { stop: "it is now too large for GitHub to list its changes. Review it and merge again." };
    if (!current) return { stop: "ADE could not read its changes from GitHub." };
    return current === expected
      ? { sha: headSha }
      : { stop: "its changes moved after you confirmed the merge. Review them and merge again." };
  };

  /**
   * Bypass-merge one layer that is already the bottom open PR. Each attempt
   * re-checks the head: GitHub may still be restacking the layer, which
   * rewrites its SHA ("Head branch was modified"). For the bottom layer, which
   * is never restacked, a moved head is final. A refusal is checked against
   * the PR itself first: another click, machine or agent may have merged it.
   */
  const mergeLayer = async (
    repo: GitHubRepoRef,
    guard: LayerGuard,
    method: MergeMethod,
  ): Promise<AsyncMergeResult> => {
    const prNumber = guard.prNumber;
    const failed = (message: string): AsyncMergeResult => ({ status: "failed", uuid: null, sha: null, message });
    let lastMessage = "GitHub could not merge this PR.";
    for (let attempt = 1; attempt <= LAYER_START_ATTEMPTS; attempt += 1) {
      const head = await verifyLayerHead(repo, guard);
      if ("stop" in head) return failed(head.stop);
      const body = { merge_method: method, merge_action: "default", bypass_rules: true, sha: head.sha };
      const start = await startMerge(repo, prNumber, body);
      let status: number | null = null;
      if ("started" in start) {
        const final = await pollMerge(repo, prNumber, start.started, Date.now() + LAYER_MERGE_WAIT_MS);
        if (final.status !== "failed") return final;
        lastMessage = final.message ?? lastMessage;
      } else {
        lastMessage = getErrorMessage(start.error);
        status = githubApiFailure(start.error)?.status ?? null;
      }
      const merged = await mergedOnGitHub(repo, prNumber);
      if (merged) return { status: "merged", uuid: null, sha: merged.sha, message: null };
      if (isHeadModifiedMergeError(lastMessage)) {
        if (!guard.content) return failed("its head changed after you confirmed the merge. Review it and merge again.");
      } else if (!isRestackPendingFailure(lastMessage, status)) {
        return failed(formatMergeError(lastMessage, null));
      }
      if (attempt < LAYER_START_ATTEMPTS) await deps.delay(LAYER_RETRY_DELAY_MS);
    }
    return failed(formatMergeError(lastMessage, null));
  };

  /**
   * The bypass merge of a PR above the bottom of its stack: each covered PR,
   * bottom first, merges on its own with `bypass_rules`, and the next one
   * waits until GitHub has moved it onto the base. A layer that fails stops
   * the run; the layers already merged stay merged and the result names them.
   * Answers after the foreground wait and keeps going in the background, like
   * a single stack merge.
   */
  const landLayerByLayer = async (run: {
    repo: GitHubRepoRef;
    prNumber: number;
    args: LandPrArgs;
    stackNumber: number;
    stackPrNumbers: number[];
    coveredEntries: GitHubPrStackEntry[];
    base: LandResult;
    finishOperation: (status: "succeeded" | "failed", metadataPatch: Record<string, unknown>) => void;
  }): Promise<LandResult> => {
    const { repo, prNumber, args, stackNumber, stackPrNumbers, coveredEntries, base, finishOperation } = run;
    const meta = { stackNumber, stackPrNumbers, layered: true };
    const list = (numbers: number[]) => numbers.map((number) => `#${number}`).join(", ");

    const sequence = async (): Promise<LandResult> => {
      const guards = await snapshotLayerGuards(repo, coveredEntries);
      if (!Array.isArray(guards)) {
        finishOperation("failed", { ...meta, error: guards.stop });
        return { ...base, error: guards.stop, stackPrNumbers };
      }
      const merged: number[] = [];
      let lastSha: string | null = null;
      // The layers that merged before the run stopped still get their cleanup.
      const cleanUpMerged = async () => {
        if (merged.length === 0) return;
        await finishMerge(repo, stackNumber, merged, args, prNumber).catch((error) => {
          logger.warn("prs.stack_layer_cleanup_failed", { stackNumber, error: getErrorMessage(error) });
        });
      };
      const stopAt = async (number: number, reason: string): Promise<LandResult> => {
        await cleanUpMerged();
        const error = merged.length > 0
          ? `Merged ${list(merged)}. #${number} did not merge: ${reason}`
          : `#${number} did not merge: ${reason}`;
        finishOperation("failed", { ...meta, mergedPrNumbers: merged, error });
        return { ...base, error, stackPrNumbers };
      };
      for (const guard of guards) {
        const number = guard.prNumber;
        const ready = await waitUntilBottom(repo, stackNumber, number);
        if (ready === "merged") {
          merged.push(number);
          continue;
        }
        if (ready !== "ready") return await stopAt(number, ready.stop);
        const outcome = await mergeLayer(repo, guard, args.method);
        if (outcome.status === "merged") {
          merged.push(number);
          lastSha = outcome.sha;
          continue;
        }
        if (outcome.status === "enqueued") {
          // The queue owns the order from here; ADE cannot merge the next
          // layer before this one lands.
          await cleanUpMerged();
          markHotRows(repo, stackPrNumbers.filter((candidate) => !merged.includes(candidate)));
          finishOperation("succeeded", { ...meta, mergedPrNumbers: merged, mergeStatus: "enqueued" });
          return {
            ...base,
            mergeStatus: "enqueued",
            stackPrNumbers,
            error: `GitHub added #${number} to the merge queue. Merge the rest of Stack #${stackNumber} after it lands.`,
          };
        }
        return await stopAt(
          number,
          outcome.status === "pending"
            ? "GitHub did not finish the merge in time."
            : outcome.message ?? "GitHub could not merge this PR.",
        );
      }
      const cleanup = await finishMerge(repo, stackNumber, merged, args, prNumber);
      finishOperation("succeeded", { ...meta, mergedPrNumbers: merged, mergeStatus: "merged", mergeCommitSha: lastSha, ...cleanup });
      return { ...base, success: true, mergeCommitSha: lastSha, mergeStatus: "merged", stackPrNumbers, ...cleanup };
    };

    const running = sequence().catch((error): LandResult => {
      const message = getErrorMessage(error);
      logger.warn("prs.stack_layer_merge_failed", { stackNumber, error: message });
      finishOperation("failed", { ...meta, error: message });
      return { ...base, error: message, stackPrNumbers };
    });
    const answered = await Promise.race([
      running,
      deps.delay(FOREGROUND_WAIT_MS).then(() => null),
    ]);
    if (answered) return answered;
    return {
      ...base,
      mergeStatus: "pending",
      stackPrNumbers,
      error: `GitHub is merging ${list(stackPrNumbers)} one at a time with the bypass. The PRs update as each one lands.`,
    };
  };

  /** Merge `target`, a PR in GitHub Stack `stackNumber`. Finishes `operationId`. */
  const land = async (
    target: { repo: GitHubRepoRef; prNumber: number },
    args: LandPrArgs,
    stackNumber: number,
    operationId: string,
  ): Promise<LandResult> => {
    const { repo, prNumber } = target;
    const base: LandResult = {
      prId: args.prId,
      prNumber,
      success: false,
      mergeCommitSha: null,
      branchDeleted: false,
      laneArchived: false,
      error: null,
    };
    const finishOperation = (status: "succeeded" | "failed", metadataPatch: Record<string, unknown>) => {
      try {
        deps.operationService.finish({ operationId, status, metadataPatch });
      } catch { /* already finished -- ignore */ }
    };

    // The stack decides which PRs this merge covers. Read it fresh, because a
    // lower layer may have merged already.
    let stackPrNumbers: number[] = [prNumber];
    let coveredEntries: GitHubPrStackEntry[] = [];
    try {
      const stack = await deps.githubStackStore.reconcile(repo, stackNumber);
      coveredEntries = openStackEntriesThrough(stack, prNumber);
      if (coveredEntries.length > 0) stackPrNumbers = coveredEntries.map((entry) => entry.githubPrNumber);
    } catch (error) {
      logger.warn("prs.stack_reconcile_before_merge_failed", { stackNumber, error: getErrorMessage(error) });
    }

    // The head moved past what the user looked at: nothing merges, and the
    // result says what landed so the user can merge again against it.
    const finishHeadChanged = (rawMsg: string, headChanged: LandHeadChange): LandResult => {
      finishOperation("failed", { error: rawMsg, stackNumber });
      return { ...base, error: formatHeadChangeMessage(headChanged), stackPrNumbers, headChanged };
    };
    const headMoved = async (rawMsg: string): Promise<LandResult | null> => {
      const headChanged = await deps.headChange.afterMergeRefusal(repo, prNumber, args.expectedHeadSha, rawMsg);
      return headChanged ? finishHeadChanged(rawMsg, headChanged) : null;
    };

    const headChangedBefore = await deps.headChange.detect(repo, prNumber, args.expectedHeadSha);
    if (headChangedBefore) {
      return finishHeadChanged(
        `PR head is ${headChangedBefore.currentHeadSha}, expected ${headChangedBefore.expectedHeadSha}`,
        headChangedBefore,
      );
    }

    // GitHub honors `bypass_rules` only when the merge covers just the bottom
    // open PR. Above it, ADE merges the covered PRs one at a time from the
    // bottom, each with the bypass.
    if (args.bypassRules && stackPrNumbers.length > 1) {
      return await landLayerByLayer({ repo, prNumber, args, stackNumber, stackPrNumbers, coveredEntries, base, finishOperation });
    }

    const body: Record<string, unknown> = { merge_method: args.method, merge_action: "default" };
    if (args.expectedHeadSha?.trim()) body.sha = args.expectedHeadSha.trim();
    if (args.bypassRules) body.bypass_rules = true;

    const start = await startMerge(repo, prNumber, body);
    if ("error" in start) {
      const rawMsg = getErrorMessage(start.error);
      const moved = await headMoved(rawMsg);
      if (moved) return moved;
      finishOperation("failed", { error: rawMsg, stackNumber });
      return { ...base, error: withBypassHint(formatMergeError(rawMsg, args.expectedHeadSha), args), stackPrNumbers };
    }
    const started = start.started;

    const settle = async (final: AsyncMergeResult): Promise<LandResult> => {
      const meta = { stackNumber, stackPrNumbers, asyncMergeUuid: final.uuid };
      if (final.status === "merged") {
        const cleanup = await finishMerge(repo, stackNumber, stackPrNumbers, args, prNumber);
        finishOperation("succeeded", { ...meta, mergeStatus: "merged", mergeCommitSha: final.sha, ...cleanup });
        return { ...base, success: true, mergeCommitSha: final.sha, mergeStatus: "merged", stackPrNumbers, ...cleanup };
      }
      if (final.status === "failed") {
        const message = withBypassHint(final.message ?? "GitHub could not merge the stack.", args);
        const moved = await headMoved(message);
        if (moved) return moved;
        finishOperation("failed", { ...meta, error: message });
        return { ...base, error: message, stackPrNumbers };
      }
      if (final.status === "enqueued") {
        // GitHub accepted the merge; the queue decides when it lands.
        finishOperation("succeeded", { ...meta, mergeStatus: "enqueued" });
        markHotRows(repo, stackPrNumbers);
        return { ...base, mergeStatus: "enqueued", stackPrNumbers, error: `GitHub added Stack #${stackNumber} to the merge queue.` };
      }
      return {
        ...base,
        mergeStatus: "pending",
        stackPrNumbers,
        error: `GitHub is still merging Stack #${stackNumber}. The PRs update when it finishes.`,
      };
    };

    const first = await pollMerge(repo, prNumber, started, Date.now() + FOREGROUND_WAIT_MS);
    if (first.status !== "pending") return await settle(first);

    // Still running. Answer now, and keep polling so the cleanup still runs.
    // If the app quits first, the operation stays open and the PR poller shows
    // the merged state; only the optional lane and branch cleanup is lost.
    void pollMerge(repo, prNumber, first, Date.now() + BACKGROUND_WAIT_MS)
      .then(async (final) => {
        if (final.status !== "pending") {
          await settle(final);
          return;
        }
        // The outcome is unknown, so this is not a failure. GitHub can still
        // finish the merge after ADE stops polling; leave the operation open
        // (as the app-quit path above does) and let the PR poller show the
        // merged or unmerged state when GitHub settles.
        logger.warn("prs.stack_merge_background_wait_exhausted", {
          stackNumber,
          stackPrNumbers,
          asyncMergeUuid: final.uuid,
        });
      })
      .catch((error) => {
        logger.warn("prs.stack_merge_background_poll_failed", { stackNumber, error: getErrorMessage(error) });
      });
    return await settle(first);
  };

  return { land };
}
