// ---------------------------------------------------------------------------
// Linear Tools — agent-callable tools for reading and writing to Linear.
// These tools wrap the existing linearClient and are gated on credentials
// being configured. Available to all agent types (CTO, workers, chat).
// ---------------------------------------------------------------------------

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { LinearClient } from "../../cto/linearClient";
import type { LinearCredentialService } from "../../cto/linearCredentialService";

export interface LinearToolDeps {
  linearClient: LinearClient | null;
  credentials: LinearCredentialService | null;
}

export function createLinearTools(
  deps: LinearToolDeps,
): Record<string, Tool> {
  const { linearClient, credentials } = deps;

  // Only expose tools when Linear credentials are configured.
  if (!linearClient || !credentials || !credentials.getToken()) {
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {};

  // ── linear_get_issue ──────────────────────────────────────────────
  tools.linearGetIssue = tool({
    description:
      "Fetch a Linear issue by its ID or identifier (e.g. 'ABC-42'). " +
      "Returns the full issue details including state, labels, assignee, and description.",
    inputSchema: z.object({
      issueId: z
        .string()
        .describe("The Linear issue ID (UUID) or identifier (e.g. 'PROJ-123')"),
    }),
    execute: async ({ issueId }) => {
      try {
        const issue = await linearClient.fetchIssueById(issueId);
        if (!issue) {
          return { success: false, error: `Issue not found: ${issueId}` };
        }
        return {
          success: true,
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            url: issue.url,
            state: issue.stateName,
            stateType: issue.stateType,
            priority: issue.priorityLabel,
            labels: issue.labels,
            assignee: issue.assigneeName,
            creator: issue.creatorName,
            projectSlug: issue.projectSlug,
            teamKey: issue.teamKey,
            hasOpenBlockers: issue.hasOpenBlockers,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to fetch issue: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_search_issues ──────────────────────────────────────────
  tools.linearSearchIssues = tool({
    description:
      "Search for Linear issues in a project by state type. " +
      "Returns a list of matching issues with key fields.",
    inputSchema: z.object({
      projectSlug: z
        .string()
        .describe("The Linear project slug to search in"),
      stateTypes: z
        .array(z.enum(["backlog", "unstarted", "started", "completed", "canceled"]))
        .default(["unstarted", "started"])
        .describe("Issue state types to filter by"),
    }),
    execute: async ({ projectSlug, stateTypes }) => {
      try {
        const issues = await linearClient.fetchCandidateIssues({
          projectSlugs: [projectSlug],
          stateTypes,
        });
        return {
          success: true,
          count: issues.length,
          issues: issues.slice(0, 50).map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            state: issue.stateName,
            priority: issue.priorityLabel,
            assignee: issue.assigneeName,
            labels: issue.labels,
            url: issue.url,
          })),
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to search issues: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_add_comment ────────────────────────────────────────────
  tools.linearAddComment = tool({
    description:
      "Post a comment on a Linear issue. Use this to report progress, " +
      "ask questions, or document findings on the issue you're working on.",
    inputSchema: z.object({
      issueId: z
        .string()
        .describe("The Linear issue ID (UUID) to comment on"),
      body: z
        .string()
        .describe("The comment body in markdown format"),
    }),
    execute: async ({ issueId, body }) => {
      try {
        const result = await linearClient.createComment(issueId, body);
        return {
          success: true,
          commentId: result.commentId,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to add comment: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_update_issue_state ─────────────────────────────────────
  tools.linearUpdateIssueState = tool({
    description:
      "Move a Linear issue to a different workflow state. " +
      "First use linearListStates to find the correct state ID for the target state name.",
    inputSchema: z.object({
      issueId: z
        .string()
        .describe("The Linear issue ID (UUID) to update"),
      stateId: z
        .string()
        .describe("The target workflow state ID (UUID). Use linearListStates to look this up."),
    }),
    execute: async ({ issueId, stateId }) => {
      try {
        await linearClient.updateIssueState(issueId, stateId);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: `Failed to update issue state: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_list_states ────────────────────────────────────────────
  tools.linearListStates = tool({
    description:
      "List all workflow states for a Linear team. " +
      "Use this to look up state IDs before calling linearUpdateIssueState.",
    inputSchema: z.object({
      teamKey: z
        .string()
        .optional()
        .describe("The team key (e.g. 'ENG'). If omitted, returns states for all teams."),
    }),
    execute: async ({ teamKey }) => {
      try {
        const states = await linearClient.listWorkflowStates(teamKey);
        return {
          success: true,
          states: states.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            teamKey: s.teamKey,
          })),
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to list states: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_add_label ──────────────────────────────────────────────
  tools.linearAddLabel = tool({
    description:
      "Add a label to a Linear issue by label name.",
    inputSchema: z.object({
      issueId: z
        .string()
        .describe("The Linear issue ID (UUID)"),
      labelName: z
        .string()
        .describe("The label name to add (must match an existing label)"),
    }),
    execute: async ({ issueId, labelName }) => {
      try {
        await linearClient.addLabel(issueId, labelName);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: `Failed to add label: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── linear_graphql ────────────────────────────────────────────────
  tools.linearGraphql = tool({
    description:
      "Execute a raw GraphQL query or mutation against the Linear API. " +
      "Use this for operations not covered by the other Linear tools, " +
      "such as creating sub-issues, updating assignees, or querying custom fields. " +
      "Refer to the Linear API docs for the schema.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("The GraphQL query or mutation string"),
      variables: z
        .record(z.string(), z.unknown())
        .optional()
        .default({})
        .describe("Variables for the GraphQL operation"),
    }),
    execute: async ({ query, variables }) => {
      try {
        const data = await linearClient.request({ query, variables });
        return { success: true, data };
      } catch (err) {
        return {
          success: false,
          error: `GraphQL request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  });

  return tools;
}
