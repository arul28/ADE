import fs from "node:fs";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  IssueInventoryItem,
  LaneSummary,
  PrActionRun,
  PrCheck,
  PrComment,
  PrDetail,
  PrFile,
  PrIssueResolutionPromptPreviewArgs,
  PrIssueResolutionPromptPreviewResult,
  PrIssueResolutionScope,
  PrIssueResolutionStartArgs,
  PrIssueResolutionStartResult,
  PrReviewThread,
  PrSummary,
} from "../../../shared/types";
import { getPrIssueResolutionAvailability } from "../../../shared/prIssueResolution";
import type { createLaneService } from "../lanes/laneService";
import type { createPrService } from "./prService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { createIssueInventoryService } from "./issueInventoryService";
import { mapPermissionMode, readRecentCommits } from "./resolverUtils";

type PreviouslyHandledSummary = {
  fixedCount: number;
  dismissedCount: number;
  escalatedCount: number;
  fixedHeadlines: string[];
  dismissedHeadlines: string[];
};

type IssueResolutionPromptArgs = {
  pr: PrSummary;
  lane: LaneSummary;
  detail: PrDetail | null;
  files: PrFile[];
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  reviewThreads: PrReviewThread[];
  issueComments: PrComment[];
  scope: PrIssueResolutionScope;
  additionalInstructions: string | null;
  recentCommits: Array<{ sha: string; subject: string }>;
  /** Current round number (1-based). */
  round?: number | null;
  /** Summary of prior rounds for incremental resolution. */
  previouslyHandled?: PreviouslyHandledSummary | null;
  /** When provided, use these inventory items instead of raw threads/checks for the issue sections. */
  inventoryItems?: IssueInventoryItem[] | null;
};

export type PrIssueResolutionLaunchDeps = {
  prService: ReturnType<typeof createPrService>;
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "getLaneBaseAndBranch">;
  agentChatService: Pick<ReturnType<typeof createAgentChatService>, "createSession" | "sendMessage">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  issueInventoryService?: ReturnType<typeof createIssueInventoryService> | null;
};

type PreparedIssueResolutionPrompt = {
  pr: PrSummary;
  lane: LaneSummary;
  prompt: string;
  title: string;
  /** New items from inventory that were included in this prompt (for marking as sent). */
  inventoryNewItems?: IssueInventoryItem[];
  /** The round number assigned (for marking items). */
  roundNumber?: number;
};

function truncateText(value: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function stripMarkupNoise(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[_*#>|]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSeverity(value: string): string | null {
  const match = value.match(/\b(Critical|Major|Minor)\b/i);
  return match?.[1] ? match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() : null;
}

function extractHighlightedTitle(value: string): string | null {
  const match = value.match(/\*\*([^*]+)\*\*/);
  return match?.[1] ? stripMarkupNoise(match[1]) : null;
}

function summarizeThreadCommentBody(value: string | null | undefined): { severity: string | null; summary: string } {
  const raw = (value ?? "").trim();
  if (!raw) {
    return {
      severity: null,
      summary: "Review the linked thread for the full comment context.",
    };
  }

  const severity = extractSeverity(raw);
  const title = extractHighlightedTitle(raw);
  let summary = stripMarkupNoise(raw)
    .replace(/\bPotential issue\b/gi, " ")
    .replace(/\b(Critical|Major|Minor)\b/gi, " ")
    .replace(/\bAlso applies to:.*$/i, " ")
    .replace(/\bVerify each finding against.*$/i, " ")
    .replace(/\bThis is an auto-generated comment by CodeRabbit\b/gi, " ")
    .trim();

  if (title) {
    summary = summary.replace(title, " ").trim();
  }
  summary = truncateText(summary, 180);

  const compact = title && summary.length > 0
    ? `${title} — ${summary}`
    : title || summary;

  return {
    severity,
    summary: compact || "Review the linked thread for the full comment context.",
  };
}

function summarizePrBody(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const withoutBotSummary = raw
    .replace(/## Summary by CodeRabbit[\s\S]*$/i, " ")
    .replace(/summary by coderabbit[\s\S]*$/i, " ");
  const plain = stripMarkupNoise(withoutBotSummary);
  if (!plain) return null;
  return truncateText(plain, 420);
}

const NOISY_BOT_AUTHORS = new Set(["vercel", "vercel[bot]", "mintlify", "mintlify[bot]"]);

const NOISY_BODY_PATTERNS = [
  /\[vc\]:/i,
  /mintlify-preview-comment/i,
  /this is an auto-generated comment: summarize by coderabbit/i,
  /this is an auto-generated comment: release notes by coderabbit/i,
  /pre-merge checks/i,
  /thanks for using \[coderabbit\]/i,
  /<!-- internal state start -->/i,
];

function isNoisyIssueComment(comment: PrComment): boolean {
  const author = comment.author.trim().toLowerCase();
  const body = (comment.body ?? "").trim();
  if (!body) return true;
  if (NOISY_BOT_AUTHORS.has(author)) return true;
  return NOISY_BODY_PATTERNS.some((pattern) => pattern.test(body));
}

function formatChecksSummary(checks: PrCheck[], actionRuns: PrActionRun[]): string {
  const failingChecks = checks.filter((check) => check.conclusion === "failure");
  if (failingChecks.length === 0) return "- No actionable failing checks.";

  const lines: string[] = [];
  for (const check of failingChecks) {
    lines.push(`- ${check.name} (${check.conclusion ?? check.status})${check.detailsUrl ? ` — ${check.detailsUrl}` : ""}`);
  }

  const failingRuns = actionRuns.filter((run) =>
    run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required",
  );
  for (const run of failingRuns.slice(0, 8)) {
    const failingJobs = run.jobs.filter((job) => job.conclusion === "failure" || job.status === "in_progress");
    const jobBits = failingJobs.map((job) => {
      const failingSteps = job.steps
        .filter((step) => step.conclusion === "failure" || step.status === "in_progress")
        .map((step) => step.name);
      if (failingSteps.length > 0) {
        return `${job.name} [steps: ${failingSteps.join(", ")}]`;
      }
      return job.name;
    });
    lines.push(
      `- Workflow ${run.name} run #${run.id}: ${run.conclusion ?? run.status}${jobBits.length > 0 ? ` — jobs: ${jobBits.join("; ")}` : ""}${
        run.htmlUrl ? ` — ${run.htmlUrl}` : ""
      }`,
    );
  }

  return lines.join("\n");
}

function formatReviewThreadsSummary(reviewThreads: PrReviewThread[]): string {
  const actionableThreads = reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  if (actionableThreads.length === 0) return "- No actionable unresolved review threads.";

  return actionableThreads.map((thread, index) => {
    const primaryComment = thread.comments[0] ?? null;
    const commentSummary = summarizeThreadCommentBody(primaryComment?.body);
    const location = thread.path
      ? `${thread.path}${thread.line != null ? `:${thread.line}` : ""}`
      : "unknown location";
    const severityPrefix = commentSummary.severity ? `[${commentSummary.severity}] ` : "";
    const authorSuffix = primaryComment?.author ? ` | author: ${primaryComment.author}` : "";
    return `${index + 1}. ${severityPrefix}Thread ${thread.id} at ${location}${authorSuffix}\n   Summary: ${commentSummary.summary}\n   Reference: ${thread.url ?? primaryComment?.url ?? "(no URL available)"}`;
  }).join("\n");
}

function formatIssueCommentsSummary(issueComments: PrComment[]): string {
  const advisory = issueComments
    .filter((comment) => comment.source === "issue")
    .filter((comment) => !isNoisyIssueComment(comment))
    .slice(0, 5);
  if (advisory.length === 0) return "- No advisory top-level issue comments.";
  return advisory
    .map((comment, index) => {
      const body = truncateText(stripMarkupNoise(comment.body ?? ""), 220);
      return `${index + 1}. ${comment.author}${comment.url ? ` — ${comment.url}` : ""}\n   ${body}`;
    })
    .join("\n");
}

function formatChangedFilesSummary(files: PrFile[]): string {
  if (files.length === 0) return "- No changed files reported.";
  return files
    .slice(0, 40)
    .map((file) => `- ${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`)
    .join("\n");
}

function isTestFilePath(filename: string): boolean {
  return /(^|\/)__tests__(\/|$)/.test(filename)
    || /(^|\/)__mocks__(\/|$)/.test(filename)
    || /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(filename);
}

function formatChangedTestFilesSummary(files: PrFile[]): string {
  const changedTests = files
    .filter((file) => isTestFilePath(file.filename))
    .map((file) => {
      const totalChanges = file.additions + file.deletions;
      let emphasis = "changed test file";
      if (file.status === "added") {
        emphasis = "new test file";
      } else if (totalChanges >= 80 || file.additions >= 40) {
        emphasis = "heavily modified test file";
      }
      return `- ${emphasis}: ${file.filename} (+${file.additions}/-${file.deletions})`;
    });

  if (changedTests.length === 0) return "- No changed test files detected in this PR.";
  return changedTests.slice(0, 16).join("\n");
}

function formatRecentCommitsSummary(recentCommits: Array<{ sha: string; subject: string }>): string {
  if (recentCommits.length === 0) return "- No recent commits found in the lane worktree.";
  return recentCommits.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}`).join("\n");
}

function formatInventoryItemsSummary(items: IssueInventoryItem[]): string {
  const newItems = items.filter((i) => i.state === "new");
  if (newItems.length === 0) return "- No new inventory items to address.";

  return newItems.map((item, index) => {
    const location = item.filePath
      ? `${item.filePath}${item.line != null ? `:${item.line}` : ""}`
      : "unknown location";
    const severityPrefix = item.severity ? `[${item.severity[0].toUpperCase()}${item.severity.slice(1)}] ` : "";
    const sourceTag = item.source !== "unknown" ? ` | source: ${item.source}` : "";
    const authorTag = item.author ? ` | author: ${item.author}` : "";
    return `${index + 1}. ${severityPrefix}${item.type === "check_failure" ? "Check" : "Thread"} ${item.externalId} at ${location}${sourceTag}${authorTag}\n   Summary: ${item.headline}\n   Reference: ${item.url ?? "(no URL available)"}`;
  }).join("\n");
}

function buildSelectedScopeDescription(scope: PrIssueResolutionScope): string {
  if (scope === "both") return "checks and review comments";
  if (scope === "comments") return "review comments";
  return "checks";
}

export function buildPrIssueResolutionPrompt(args: IssueResolutionPromptArgs): string {
  const actionableThreads = args.reviewThreads.filter((thread) => !thread.isResolved && !thread.isOutdated);
  const availability = getPrIssueResolutionAvailability(args.checks, args.reviewThreads);
  const prBodySummary = summarizePrBody(args.detail?.body);
  const purposeBits = [
    args.pr.title.trim(),
    prBodySummary ? `PR body summary:\n${prBodySummary}` : null,
    args.lane.description?.trim() ? `Lane description:\n${args.lane.description.trim()}` : null,
  ].filter(Boolean);

  const scopeLabel = buildSelectedScopeDescription(args.scope);
  const roundNumber = args.round ?? null;
  const previouslyHandled = args.previouslyHandled ?? null;
  const useInventory = args.inventoryItems != null && args.inventoryItems.length > 0;

  const promptSections = [
    "You are resolving issues on an existing GitHub pull request inside ADE.",
    "Address every valid issue in the selected scope without asking the user to enumerate them again.",
    "The issue references below are intentionally compact summaries. Use the linked GitHub thread/check URLs or refresh the issue inventory when you need full detail.",
    "",
    "PR context",
    `- ADE PR id (for ADE tools): ${args.pr.id}`,
    `- GitHub PR: #${args.pr.githubPrNumber} — ${args.pr.githubUrl}`,
    `- Title: ${args.pr.title}`,
    `- Base -> head: ${args.pr.baseBranch} -> ${args.pr.headBranch}`,
    `- Lane: ${args.lane.name}`,
    `- Worktree: ${args.lane.worktreePath}`,
    `- Selected scope: ${scopeLabel}`,
  ];
  if (roundNumber != null) {
    promptSections.push(`- Resolution round: ${roundNumber}`);
  }
  promptSections.push(
    `- Actionable failing checks: ${availability.hasActionableChecks ? availability.failingCheckCount : 0}`,
    `- Actionable unresolved review threads: ${actionableThreads.length}`,
    "",
    "Purpose / intent",
    purposeBits.length > 0 ? purposeBits.join("\n\n") : "- No additional PR purpose text was available.",
    "",
    "Recent commits",
    formatRecentCommitsSummary(args.recentCommits),
    "",
    "Changed files",
    formatChangedFilesSummary(args.files),
    "",
    "Changed test files / likely hotspots",
    formatChangedTestFilesSummary(args.files),
  );

  // When inventory items are provided, use them instead of raw threads/checks
  if (useInventory) {
    promptSections.push(
      "",
      "Current issues to address (from inventory — NEW items only)",
      formatInventoryItemsSummary(args.inventoryItems!),
    );
  } else {
    promptSections.push(
      "",
      "Current failing checks",
      formatChecksSummary(args.checks, args.actionRuns),
      "",
      "Current unresolved review threads (summaries + references)",
      formatReviewThreadsSummary(args.reviewThreads),
      "",
      "Advisory top-level issue comments (filtered)",
      formatIssueCommentsSummary(args.issueComments),
    );
  }

  // Insert "Previous rounds" section when running incremental rounds
  const hadPriorWork = previouslyHandled && (previouslyHandled.fixedCount + previouslyHandled.dismissedCount + previouslyHandled.escalatedCount > 0);
  if (hadPriorWork) {
    promptSections.push(
      "",
      "Previous rounds",
      `- Fixed ${previouslyHandled.fixedCount} issues, dismissed ${previouslyHandled.dismissedCount}, escalated ${previouslyHandled.escalatedCount}`,
    );
    if (previouslyHandled.fixedHeadlines.length > 0) {
      promptSections.push(`- Fixed: ${previouslyHandled.fixedHeadlines.slice(0, 8).join(", ")}`);
    }
    if (previouslyHandled.dismissedHeadlines.length > 0) {
      promptSections.push(`- Dismissed: ${previouslyHandled.dismissedHeadlines.slice(0, 8).join(", ")}`);
    }
    promptSections.push(
      "Do not re-address items that are already fixed or dismissed. Focus only on the NEW items listed above.",
    );
  }

  const isIncremental = roundNumber != null && roundNumber > 1;

  promptSections.push(
    "",
    "Goal",
  );
  if (isIncremental) {
    promptSections.push(
      `This is continuation round ${roundNumber}. Get the remaining NEW issues in the selected scope (${scopeLabel}) resolved. Prior rounds have already addressed some items — focus on what remains.`,
    );
  } else {
    promptSections.push(
      `Get the selected PR issue scope (${scopeLabel}) into a good state. The overall goal is to get all CI checks passing and all valid selected review issues handled.`,
    );
  }

  promptSections.push(
    "",
    "Requirements",
    "- Fix all valid issues in the selected scope, not just the first one.",
    "- Start by refreshing the PR issue inventory if ADE tools are available, especially if CI or review state may have changed.",
    "- Verify review comments before changing code. Some comments may be stale, incorrect, or already addressed.",
    "- If you work on review comments, reply on the review thread when useful and resolve the thread only after the fix is truly in place or the thread is clearly outdated/invalid.",
    "- If you are running inside ADE, use ADE-backed PR tools instead of assuming gh auth. The relevant tools include prRefreshIssueInventory, prRerunFailedChecks, prReplyToReviewThread, and prResolveReviewThread.",
    "- If you are running outside ADE, use the linked GitHub thread/check URLs together with your local git and CI tooling.",
    "- Use parallel agents when they will materially speed up independent fixes.",
    "- After each set of changes, run the smallest relevant local validation first.",
    "- Before you push, rerun the complete failing test files or suites locally, not just the specific failing test names. Test runners and sharded CI can hide additional failures behind the first error in a file.",
    "- Treat newly added or heavily modified test files as likely regression hotspots, even if CI only surfaced a different failure first.",
    "- Watch carefully for regressions caused by your fixes. If a change breaks an existing test because the expected behavior legitimately changed, update the test. Do not change tests just to mask a bug.",
    "- Continue iterating until the selected issue set is cleared and CI is green, or stop only with a concrete blocker and explain it clearly.",
  );
  if (isIncremental) {
    promptSections.push(
      "- Focus on the remaining NEW issues. Do not re-address items from prior rounds.",
      "- If a prior fix introduced a regression, address the regression before moving to new items.",
    );
  }

  const trimmedAdditionalInstructions = args.additionalInstructions?.trim() ?? "";
  if (trimmedAdditionalInstructions.length > 0) {
    promptSections.push("", "Additional user instructions", trimmedAdditionalInstructions);
  }

  return promptSections.join("\n");
}

async function preparePrIssueResolutionPrompt(
  deps: PrIssueResolutionLaunchDeps,
  args: PrIssueResolutionStartArgs | PrIssueResolutionPromptPreviewArgs,
): Promise<PreparedIssueResolutionPrompt> {
  const pr = deps.prService.listAll().find((entry) => entry.id === args.prId) ?? null;
  if (!pr) throw new Error(`PR not found: ${args.prId}`);

  const lanes = await deps.laneService.list({ includeArchived: false });
  const lane = lanes.find((entry) => entry.id === pr.laneId) ?? null;
  if (!lane || lane.archivedAt) {
    throw new Error("Resolve issues with agent is only available for linked PRs with a live local lane.");
  }
  if (!fs.existsSync(lane.worktreePath)) {
    throw new Error(`Lane worktree is missing on disk: ${lane.worktreePath}`);
  }

  const [detail, files, checks, actionRuns, reviewThreads, comments] = await Promise.all([
    deps.prService.getDetail(pr.id).catch(() => null),
    deps.prService.getFiles(pr.id).catch(() => [] as PrFile[]),
    deps.prService.getChecks(pr.id),
    deps.prService.getActionRuns(pr.id).catch(() => [] as PrActionRun[]),
    deps.prService.getReviewThreads(pr.id),
    deps.prService.getComments(pr.id).catch(() => [] as PrComment[]),
  ]);

  const availability = getPrIssueResolutionAvailability(checks, reviewThreads);
  if (args.scope === "checks" && !availability.hasActionableChecks) {
    throw new Error("Failing checks are not currently actionable. Checks must be finished running and still failing.");
  }
  if (args.scope === "comments" && !availability.hasActionableComments) {
    throw new Error("There are no actionable unresolved review threads right now.");
  }
  if (args.scope === "both" && (!availability.hasActionableChecks || !availability.hasActionableComments)) {
    throw new Error("Checks and comments are no longer both actionable. Refresh the PR and choose the currently available scope.");
  }

  // If inventory service is available, sync and build incremental context
  const inventoryService = deps.issueInventoryService ?? null;
  let previouslyHandled: PreviouslyHandledSummary | null = null;
  let roundNumber: number | null = null;
  let inventoryNewItems: IssueInventoryItem[] | undefined;

  if (inventoryService) {
    // Sync the inventory with fresh GitHub data
    const snapshot = inventoryService.syncFromPrData(pr.id, checks, reviewThreads, comments);
    const convergence = snapshot.convergence;
    roundNumber = convergence.currentRound + 1;
    inventoryNewItems = inventoryService.getNewItems(pr.id);

    // Build summary of previously handled items across all prior rounds
    if (convergence.currentRound > 0) {
      const fixedItems = snapshot.items.filter((i) => i.state === "fixed");
      const dismissedItems = snapshot.items.filter((i) => i.state === "dismissed");
      const escalatedItems = snapshot.items.filter((i) => i.state === "escalated");

      previouslyHandled = {
        fixedCount: fixedItems.length,
        dismissedCount: dismissedItems.length,
        escalatedCount: escalatedItems.length,
        fixedHeadlines: fixedItems.map((i) => i.headline),
        dismissedHeadlines: dismissedItems.map((i) => i.headline),
      };
    }
  }

  return {
    pr,
    lane,
    prompt: buildPrIssueResolutionPrompt({
      pr,
      lane,
      detail,
      files,
      checks,
      actionRuns,
      reviewThreads,
      issueComments: comments,
      scope: args.scope,
      additionalInstructions: args.additionalInstructions?.trim() || null,
      recentCommits: await readRecentCommits(lane.worktreePath),
      round: roundNumber,
      previouslyHandled,
      inventoryItems: inventoryNewItems ?? null,
    }),
    title: roundNumber != null && roundNumber > 1
      ? `Resolve PR #${pr.githubPrNumber} issues (round ${roundNumber})`
      : `Resolve PR #${pr.githubPrNumber} issues`,
    inventoryNewItems,
    roundNumber: roundNumber ?? undefined,
  };
}

export async function previewPrIssueResolutionPrompt(
  deps: PrIssueResolutionLaunchDeps,
  args: PrIssueResolutionPromptPreviewArgs,
): Promise<PrIssueResolutionPromptPreviewResult> {
  const prepared = await preparePrIssueResolutionPrompt(deps, args);
  return {
    title: prepared.title,
    prompt: prepared.prompt,
  };
}

export async function launchPrIssueResolutionChat(
  deps: PrIssueResolutionLaunchDeps,
  args: PrIssueResolutionStartArgs,
): Promise<PrIssueResolutionStartResult> {
  const descriptor = getModelById(args.modelId);
  if (!descriptor) {
    throw new Error(`Unknown model '${args.modelId}'.`);
  }
  const prepared = await preparePrIssueResolutionPrompt(deps, args);
  const reasoningEffort = args.reasoning?.trim() || undefined;

  const session = await deps.agentChatService.createSession({
    laneId: prepared.lane.id,
    provider: "unified",
    model: descriptor.id,
    modelId: descriptor.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    permissionMode: mapPermissionMode(args.permissionMode),
    surface: "work",
    sessionProfile: "workflow",
  });

  deps.sessionService.updateMeta({ sessionId: session.id, title: prepared.title });

  await deps.agentChatService.sendMessage({
    sessionId: session.id,
    text: prepared.prompt,
    displayText: prepared.title,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });

  // Mark inventory items as sent to agent for this round
  if (deps.issueInventoryService && prepared.inventoryNewItems?.length && prepared.roundNumber != null) {
    deps.issueInventoryService.markSentToAgent(
      prepared.pr.id,
      prepared.inventoryNewItems.map((item) => item.id),
      session.id,
      prepared.roundNumber,
    );
  }

  return {
    sessionId: session.id,
    laneId: prepared.lane.id,
    href: `/work?laneId=${encodeURIComponent(prepared.lane.id)}&sessionId=${encodeURIComponent(session.id)}`,
  };
}
