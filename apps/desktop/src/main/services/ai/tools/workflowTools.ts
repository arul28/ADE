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

const execFileAsync = promisify(execFile);

export interface WorkflowToolDeps {
  laneService: ReturnType<typeof createLaneService>;
  prService?: ReturnType<typeof createPrService> | null;
  computerUseArtifactBrokerService?: ComputerUseArtifactBrokerService | null;
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
    sessionId,
    laneId,
  } = deps;

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
        return {
          success: false,
          error: `Failed to create lane: ${err instanceof Error ? err.message : String(err)}`,
        };
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
          return {
            success: false,
            error: `Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });
  }

  // ── capture_screenshot ──────────────────────────────────────────────
  if (computerUseArtifactBrokerService) {
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
        try {
          // Use macOS screencapture to grab the screen
          const tmpPath = path.join(
            fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ade-screenshot-")),
            `screenshot-${Date.now()}.png`,
          );

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
            uri: artifact?.uri ?? tmpPath,
            title: artifact?.title ?? title,
          };
        } catch (err) {
          return {
            success: false,
            error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
          };
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
      return {
        type: "completion_report",
        sessionId,
        laneId,
        timestamp: nowIso(),
        summary,
        status,
        artifacts: artifacts ?? [],
        ...(blockerDescription ? { blockerDescription } : {}),
      };
    },
  });

  return tools;
}
