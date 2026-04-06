// ---------------------------------------------------------------------------
// Workflow Tools — lane creation, PR creation, screenshot capture, and
// structured completion reporting for chat agents.
// ---------------------------------------------------------------------------

import { tool, type Tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import type { createLaneService } from "../../lanes/laneService";
import type { createPrService } from "../../prs/prService";
import type { ComputerUseArtifactBrokerService } from "../../computerUse/computerUseArtifactBrokerService";
import { nowIso } from "../../shared/utils";
import { getPrIssueResolutionAvailability } from "../../../../shared/prIssueResolution";
import {
  createDefaultComputerUsePolicy,
  isComputerUseModeEnabled,
  type AgentChatCompletionReport,
  type ComputerUsePolicy,
} from "../../../../shared/types";

const execFileAsync = promisify(execFile);

function formatToolError(prefix: string, err: unknown): { success: false; error: string } {
  return { success: false, error: `${prefix}: ${err instanceof Error ? err.message : String(err)}` };
}

export interface WorkflowToolDeps {
  laneService: ReturnType<typeof createLaneService>;
  prService?: ReturnType<typeof createPrService> | null;
  computerUseArtifactBrokerService?: ComputerUseArtifactBrokerService | null;
  computerUsePolicy?: ComputerUsePolicy | null;
  onReportCompletion?: ((report: AgentChatCompletionReport) => Promise<void> | void) | null;
  /** The session ID used as owner for artifacts. */
  sessionId: string;
  /** The lane ID the current session is running in. */
  laneId: string;
}

export function createWorkflowTools(
  deps: WorkflowToolDeps,
): Record<string, Tool> {
  const {
    laneService,
    prService,
    computerUseArtifactBrokerService,
    computerUsePolicy,
    onReportCompletion,
    sessionId,
    laneId,
  } = deps;
  const resolvedComputerUsePolicy = createDefaultComputerUsePolicy(computerUsePolicy ?? undefined);
  const localComputerUseAllowed =
    isComputerUseModeEnabled(resolvedComputerUsePolicy.mode)
    && resolvedComputerUsePolicy.allowLocalFallback;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {};

  // ── create_lane ─────────────────────────────────────────────────────
  tools.createLane = tool({
    description:
      "Create a new development lane (git worktree + branch). " +
      "Use this before starting work that should be isolated from the main branch.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("Short descriptive name for the lane (e.g. 'fix-auth-bug')"),
      description: z
        .string()
        .optional()
        .describe("Optional longer description of the lane's purpose"),
      parentLaneId: z
        .string()
        .optional()
        .describe("Parent lane ID to branch from. Defaults to the primary lane."),
    }),
    execute: async ({ name, description, parentLaneId }) => {
      try {
        const lane = await laneService.create({
          name,
          description,
          parentLaneId,
        });
        return {
          success: true,
          laneId: lane.id,
          name: lane.name,
          branch: lane.branchRef,
          worktreePath: lane.worktreePath,
        };
      } catch (err) {
        return formatToolError("Failed to create lane", err);
      }
    },
  });

  // ── create_pr_from_lane ─────────────────────────────────────────────
  if (prService) {
    tools.createPrFromLane = tool({
      description:
        "Create a GitHub pull request from a lane's branch. " +
        "The lane must have committed changes pushed to the remote.",
      inputSchema: z.object({
        laneId: z
          .string()
          .describe("The lane ID to create a PR from. Defaults to the current lane.")
          .optional(),
        title: z.string().describe("PR title"),
        body: z
          .string()
          .optional()
          .default("")
          .describe("PR body/description in markdown"),
        draft: z
          .boolean()
          .optional()
          .default(false)
          .describe("Create as a draft PR"),
        baseBranch: z
          .string()
          .optional()
          .describe("Target branch for the PR (defaults to repo default)"),
      }),
      execute: async ({ laneId: targetLaneId, title, body, draft, baseBranch }) => {
        try {
          const pr = await prService.createFromLane({
            laneId: targetLaneId ?? laneId,
            title,
            body: body ?? "",
            draft: Boolean(draft),
            baseBranch,
          });
          return {
            success: true,
            prId: pr.id,
            prNumber: pr.githubPrNumber,
            url: pr.githubUrl,
            title: pr.title,
            state: pr.state,
          };
        } catch (err) {
          return formatToolError("Failed to create PR", err);
        }
      },
    });
  }

  // ── capture_screenshot ──────────────────────────────────────────────
  if (computerUseArtifactBrokerService && localComputerUseAllowed) {
    tools.captureScreenshot = tool({
      description:
        "Capture a screenshot of the current screen. " +
        "Useful for visual verification of UI changes or documenting work.",
      inputSchema: z.object({
        title: z
          .string()
          .optional()
          .default("Screenshot")
          .describe("Descriptive title for the screenshot"),
        description: z
          .string()
          .optional()
          .describe("Optional description of what the screenshot shows"),
      }),
      execute: async ({ title, description }) => {
        if (!resolvedComputerUsePolicy.allowLocalFallback) {
          return {
            success: false,
            error: "Local computer-use fallback is disabled for this chat session.",
          };
        }
        let tmpDir: string | null = null;
        try {
          tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ade-screenshot-"));
          const tmpPath = path.join(tmpDir, `screenshot-${Date.now()}.png`);

          // Use macOS screencapture to grab the screen
          await execFileAsync("screencapture", ["-x", tmpPath], {
            timeout: 15_000,
          });

          if (!fs.existsSync(tmpPath)) {
            return { success: false, error: "Screenshot capture produced no file" };
          }

          const result = computerUseArtifactBrokerService.ingest({
            backend: {
              style: "local_fallback",
              name: "screencapture",
              toolName: "captureScreenshot",
            },
            inputs: [
              {
                kind: "screenshot",
                title: title ?? "Screenshot",
                description: description ?? null,
                path: tmpPath,
                mimeType: "image/png",
              },
            ],
            owners: [
              { kind: "chat_session", id: sessionId, relation: "produced_by" },
            ],
          });

          const artifact = result.artifacts[0];
          return {
            success: true,
            artifactId: artifact?.id ?? null,
            uri: artifact?.uri ?? null,
            title: artifact?.title ?? title,
          };
        } catch (err) {
          return formatToolError("Screenshot failed", err);
        } finally {
          try {
            if (tmpDir) {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            }
          } catch {
            // Best-effort cleanup only.
          }
        }
      },
    });
  }

  // ── pr_get_review_comments ─────────────────────────────────────────
  if (prService) {
    tools.prGetReviewComments = tool({
      description:
        "Fetch all comments and reviews on a pull request. " +
        "Use this to check for reviewer feedback that needs to be addressed " +
        "before a PR can be merged. Returns both issue-level and inline review comments.",
      inputSchema: z.object({
        prId: z
          .string()
          .describe("The ADE PR ID to get comments for"),
      }),
      execute: async ({ prId }) => {
        try {
          const [comments, reviews, checks] = await Promise.all([
            prService.getComments(prId),
            prService.getReviews(prId),
            prService.getChecks(prId),
          ]);

          const actionableComments = comments.filter((c) => {
            // Filter out bot comments and empty bodies
            if (!c.body?.trim()) return false;
            const author = c.author?.toLowerCase() ?? "";
            return !author.includes("[bot]") && !author.includes("github-actions");
          });

          const pendingReviews = reviews.filter(
            (r) => r.state === "changes_requested" || r.state === "commented"
          );

          return {
            success: true,
            summary: {
              totalComments: comments.length,
              actionableComments: actionableComments.length,
              reviewsRequiringChanges: pendingReviews.filter((r) => r.state === "changes_requested").length,
              checksStatus: checks.some((c) => c.conclusion === "failure")
                ? "failing"
                : checks.every((c) => c.conclusion === "success")
                  ? "passing"
                  : "pending",
            },
            comments: actionableComments.map((c) => ({
              id: c.id,
              author: c.author,
              body: c.body,
              source: c.source,
              path: c.path,
              line: c.line,
              url: c.url,
              createdAt: c.createdAt,
            })),
            reviews: pendingReviews.map((r) => ({
              reviewer: r.reviewer,
              state: r.state,
              body: r.body,
              submittedAt: r.submittedAt,
            })),
          };
        } catch (err) {
          return formatToolError("Failed to get PR comments", err);
        }
      },
    });

    // ── pr_reply_to_comment ───────────────────────────────────────────
    tools.prReplyToComment = tool({
      description:
        "Reply to a specific comment on a pull request. " +
        "Use this to respond to reviewer feedback — either acknowledging " +
        "the fix or providing a justified explanation for why the code is correct.",
      inputSchema: z.object({
        prId: z
          .string()
          .describe("The ADE PR ID"),
        body: z
          .string()
          .describe("The reply body in markdown"),
        inReplyToCommentId: z
          .string()
          .optional()
          .describe("The comment ID to reply to (for threaded replies)"),
      }),
      execute: async ({ prId, body, inReplyToCommentId }) => {
        try {
          const comment = await prService.addComment({
            prId,
            body,
            inReplyToCommentId,
          });
          return {
            success: true,
            commentId: comment.id,
          };
        } catch (err) {
          return formatToolError("Failed to post reply", err);
        }
      },
    });

    // ── pr_get_checks ─────────────────────────────────────────────────
    tools.prGetChecks = tool({
      description:
        "Get the CI check status for a pull request. " +
        "Use this to verify all checks are passing before requesting merge.",
      inputSchema: z.object({
        prId: z
          .string()
          .describe("The ADE PR ID to check"),
      }),
      execute: async ({ prId }) => {
        try {
          const checks = await prService.getChecks(prId);
          const passing = checks.filter((c) => c.conclusion === "success");
          const failing = checks.filter((c) => c.conclusion === "failure");
          const pending = checks.filter((c) => c.status !== "completed");

          const overall = failing.length > 0 ? "failing" : pending.length > 0 ? "pending" : "passing";
          return {
            success: true,
            overall,
            total: checks.length,
            passing: passing.length,
            failing: failing.length,
            pending: pending.length,
            checks: checks.map((c) => ({
              name: c.name,
              status: c.status,
              conclusion: c.conclusion,
              url: c.detailsUrl,
            })),
          };
        } catch (err) {
          return formatToolError("Failed to get checks", err);
        }
      },
    });

    tools.prRefreshIssueInventory = tool({
      description:
        "Refresh the current pull request issue inventory, including checks, failing workflow details, unresolved review threads, and advisory issue comments. " +
        "Use this to understand what still needs to be fixed before the PR is ready.",
      inputSchema: z.object({
        prId: z.string().describe("The ADE PR ID to inspect"),
      }),
      execute: async ({ prId }) => {
        try {
          const [checks, actionRuns, reviewThreads, comments] = await Promise.all([
            prService.getChecks(prId),
            prService.getActionRuns(prId),
            prService.getReviewThreads(prId),
            prService.getComments(prId),
          ]);
          const availability = getPrIssueResolutionAvailability(checks, reviewThreads);
          const failingRuns = actionRuns
            .filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required")
            .map((run) => ({
              id: run.id,
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              url: run.htmlUrl,
              failingJobs: run.jobs
                .filter((job) => job.conclusion === "failure" || job.status === "in_progress")
                .map((job) => ({
                  id: job.id,
                  name: job.name,
                  status: job.status,
                  conclusion: job.conclusion,
                  failingSteps: job.steps
                    .filter((step) => step.conclusion === "failure" || step.status === "in_progress")
                    .map((step) => step.name),
                })),
            }));

          return {
            success: true,
            summary: availability,
            checks: checks.map((check) => ({
              name: check.name,
              status: check.status,
              conclusion: check.conclusion,
              url: check.detailsUrl,
            })),
            failingWorkflowRuns: failingRuns,
            reviewThreads: reviewThreads
              .filter((thread) => !thread.isResolved && !thread.isOutdated)
              .map((thread) => ({
                id: thread.id,
                path: thread.path,
                line: thread.line,
                url: thread.url,
                comments: thread.comments.map((comment) => ({
                  id: comment.id,
                  author: comment.author,
                  body: comment.body,
                  url: comment.url,
                })),
              })),
            issueComments: comments
              .filter((comment) => comment.source === "issue")
              .map((comment) => ({
                id: comment.id,
                author: comment.author,
                body: comment.body,
                url: comment.url,
              })),
          };
        } catch (err) {
          return formatToolError("Failed to refresh PR issue inventory", err);
        }
      },
    });

    tools.prRerunFailedChecks = tool({
      description:
        "Rerun failed CI checks for a pull request through ADE's GitHub integration. " +
        "Use this after pushing a fix or when the current failed runs should be retried.",
      inputSchema: z.object({
        prId: z.string().describe("The ADE PR ID to rerun checks for"),
      }),
      execute: async ({ prId }) => {
        try {
          await prService.rerunChecks({ prId });
          return {
            success: true,
            prId,
          };
        } catch (err) {
          return formatToolError("Failed to rerun checks", err);
        }
      },
    });

    tools.prReplyToReviewThread = tool({
      description:
        "Reply to a GitHub pull request review thread. " +
        "Use this when you need to explain a fix or justify why a review thread is not being changed.",
      inputSchema: z.object({
        prId: z.string().describe("The ADE PR ID"),
        threadId: z.string().describe("The GitHub review thread node ID"),
        body: z.string().describe("The markdown reply to post"),
      }),
      execute: async ({ prId, threadId, body }) => {
        try {
          const comment = await prService.replyToReviewThread({ prId, threadId, body });
          return {
            success: true,
            comment,
          };
        } catch (err) {
          return formatToolError("Failed to reply to review thread", err);
        }
      },
    });

    tools.prResolveReviewThread = tool({
      description:
        "Resolve a GitHub pull request review thread through ADE's GitHub integration. " +
        "Use this only after the underlying issue is actually fixed or the thread is clearly stale/invalid.",
      inputSchema: z.object({
        prId: z.string().describe("The ADE PR ID"),
        threadId: z.string().describe("The GitHub review thread node ID"),
      }),
      execute: async ({ prId, threadId }) => {
        try {
          await prService.resolveReviewThread({ prId, threadId });
          return {
            success: true,
            prId,
            threadId,
          };
        } catch (err) {
          return formatToolError("Failed to resolve review thread", err);
        }
      },
    });
  }

  // ── report_completion ───────────────────────────────────────────────
  tools.reportCompletion = tool({
    description:
      "Submit a structured completion report when your task is done. " +
      "Include a summary, list of artifacts produced, and final status.",
    inputSchema: z.object({
      summary: z.string().describe("Concise summary of what was accomplished"),
      status: z
        .enum(["completed", "partial", "blocked"])
        .describe("Final status of the work"),
      artifacts: z
        .array(
          z.object({
            type: z.string().describe("Artifact type (e.g. 'file', 'pr', 'screenshot', 'test_results')"),
            description: z.string().describe("What this artifact is"),
            reference: z
              .string()
              .optional()
              .describe("Path, URL, or ID referencing the artifact"),
          }),
        )
        .optional()
        .default([])
        .describe("List of artifacts produced during the work"),
      blockerDescription: z
        .string()
        .optional()
        .describe("If status is 'blocked', describe what is blocking progress"),
    }),
    execute: async ({ summary, status, artifacts, blockerDescription }) => {
      const report: AgentChatCompletionReport = {
        timestamp: nowIso(),
        summary,
        status,
        artifacts: artifacts ?? [],
        ...(blockerDescription ? { blockerDescription } : {}),
      };
      await onReportCompletion?.(report);
      return {
        type: "completion_report",
        sessionId,
        laneId,
        ...report,
      };
    },
  });

  return tools;
}
