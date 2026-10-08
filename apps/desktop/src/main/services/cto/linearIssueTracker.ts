import type { IssueTracker } from "./issueTracker";
import { parseLinearIssueCreateInput } from "../../../shared/linearIssueCreateInput";
import type { LinearClient } from "./linearClient";
import { getErrorMessage } from "../shared/utils";
import { OPEN_ISSUE_STATE_TYPES } from "./linearClientShared";

// Titles this close (word overlap) to an open issue in the same team count as a
// duplicate follow-up.
const FOLLOW_UP_DUPLICATE_THRESHOLD = 0.8;

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function titleSimilarity(left: string, right: string): number {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export function createLinearIssueTracker(args: { client: LinearClient }): IssueTracker {
  return {
    runGraphQL(params) {
      return args.client.runGraphQL(params);
    },

    listProjects() {
      return args.client.listProjects();
    },

    getQuickView(connection) {
      return args.client.getQuickView(connection);
    },

    listUsers() {
      return args.client.listUsers();
    },

    listLabels(teamKey) {
      return args.client.listLabels(teamKey);
    },

    searchIssues(query) {
      return args.client.searchIssues(query);
    },

    countIssues(query) {
      return args.client.countIssues(query);
    },

    listCustomViews() {
      return args.client.listCustomViews();
    },

    fetchCandidateIssues(query) {
      return args.client.fetchCandidateIssues(query);
    },

    fetchIssueById(issueId) {
      return args.client.fetchIssueById(issueId);
    },

    fetchIssuesByIds(issueIds) {
      return args.client.fetchIssuesByIds(issueIds);
    },

    fetchWorkflowStates(teamKey) {
      return args.client.fetchWorkflowStates(teamKey);
    },

    listWorkflowStates(teamKey) {
      return args.client.listWorkflowStates(teamKey);
    },

    updateIssueState(issueId, stateId) {
      return args.client.updateIssueState(issueId, stateId);
    },

    updateIssueAssignee(issueId, assigneeId) {
      return args.client.updateIssueAssignee(issueId, assigneeId);
    },

    updateIssuePriority(issueId, priority) {
      return args.client.updateIssuePriority(issueId, priority);
    },

    async updateIssue(issueId, patch) {
      await args.client.updateIssue(issueId, patch);
      return args.client.fetchIssueById(issueId);
    },

    createComment(issueId, body) {
      return args.client.createComment(issueId, body);
    },

    updateComment(commentId, body) {
      return args.client.updateComment(commentId, body);
    },

    addLabel(issueId, labelName) {
      return args.client.addLabel(issueId, labelName);
    },

    addIssueLabel(issueId, labelId) {
      return args.client.addIssueLabel(issueId, labelId);
    },

    removeIssueLabel(issueId, labelId) {
      return args.client.removeIssueLabel(issueId, labelId);
    },

    uploadAttachment(params) {
      return args.client.uploadAttachment(params);
    },

    createIssueAttachment(params) {
      return args.client.createIssueAttachment(params);
    },

    fetchIssueComments(issueId) {
      return args.client.fetchIssueComments(issueId);
    },

    createIssue(input) {
      return args.client.createIssue(parseLinearIssueCreateInput(input));
    },
    getIssueCreateOptions(teamKeyOrId) {
      return args.client.getIssueCreateOptions(teamKeyOrId);
    },
    listProjectMilestones(projectId) {
      return args.client.listProjectMilestones(projectId);
    },
    uploadFile({ filename, contentType, dataBase64 }) {
      const name = filename.trim().replace(/[\\/]/g, "_").slice(0, 200) || "upload";
      return args.client.uploadFileBytes({
        filename: name,
        contentType: contentType.trim() || "application/octet-stream",
        bytes: new Uint8Array(Buffer.from(dataBase64, "base64")),
      });
    },

    createIssueRelation(params) {
      return args.client.createIssueRelation(params);
    },

    async createFollowUpIssue(input) {
      // Resolve the source first: callers pass identifiers ("VER-404"),
      // parent/relation inputs want the issue's id, and a follow-up with no
      // team takes the source's team (the duplicate check needs it too).
      const sourceRef = input.sourceIssueId?.trim() || null;
      const source = sourceRef ? await args.client.fetchIssueById(sourceRef) : null;
      if (sourceRef && !source) throw new Error(`Linear issue ${sourceRef} was not found.`);
      const teamKey = input.teamKey?.trim() || source?.teamKey || "";
      if (!input.allowDuplicate) {
        // Two reads: full-text search ranks similar titles, and a direct title
        // filter sees issues filed seconds ago (the search index lags).
        const [ranked, direct] = await Promise.all([
          args.client.searchIssues({ query: input.title, teamKey, stateTypes: OPEN_ISSUE_STATE_TYPES, first: 10 }).catch(() => null),
          args.client.findOpenIssuesByTitle(input.title, teamKey).catch(() => []),
        ]);
        const duplicate = [...direct, ...(ranked?.issues ?? [])]
          .find((issue) => titleSimilarity(issue.title, input.title) >= FOLLOW_UP_DUPLICATE_THRESHOLD);
        if (duplicate) {
          return {
            created: false,
            reason: "duplicate",
            duplicateOf: {
              id: duplicate.id,
              identifier: duplicate.identifier,
              title: duplicate.title,
              url: duplicate.url,
              stateName: duplicate.stateName,
            },
          };
        }
      }
      const sourceIssueId = source?.id ?? null;
      const relation = input.relation ?? (sourceIssueId ? "related" : null);
      const issue = await args.client.createIssue({
        ...input,
        teamKey,
        projectId: input.projectId ?? (source?.projectId || null),
        parentId: relation === "sub_issue" && sourceIssueId ? sourceIssueId : input.parentId,
      });
      if (sourceIssueId && relation && relation !== "sub_issue") {
        // The new issue is the subject: "blocks" = the new issue blocks the source.
        await args.client.createIssueRelation({ issueId: issue.id, relatedIssueId: sourceIssueId, type: relation });
      }
      return { created: true, issue, relation };
    },

    async getIssuePickerData() {
      const [projects, users, states, labels] = await Promise.all([
        args.client.listProjects().catch(() => []),
        args.client.listUsers().catch(() => []),
        args.client.listWorkflowStates().catch(() => []),
        args.client.listLabels().catch(() => []),
      ]);
      return { projects, users, states, labels };
    },

    async cancelIssue(issueId) {
      const issue = await args.client.fetchIssueById(issueId);
      if (!issue) throw new Error(`Linear issue ${issueId} was not found.`);
      if (issue.stateType === "completed" || issue.stateType === "canceled") return { canceled: false, issue };
      const states = await args.client.listWorkflowStates(issue.teamKey);
      const canceled = states.find((state) => state.type === "canceled" && state.teamKey === issue.teamKey);
      if (!canceled) throw new Error(`Team ${issue.teamKey} has no Canceled state.`);
      await args.client.updateIssueState(issue.id, canceled.id);
      return { canceled: true, issue: await args.client.fetchIssueById(issue.id) };
    },

    listNotifications(params) {
      return args.client.listNotifications(params);
    },

    markNotification(params) {
      return args.client.markNotification(params.notificationId, params.action);
    },

    createProjectUpdate(params) {
      return args.client.createProjectUpdate(params);
    },

    async getConnectionStatus() {
      try {
        const identity = await args.client.getConnectionIdentity();
        return {
          connected: Boolean(identity.viewerId),
          viewerId: identity.viewerId,
          viewerName: identity.viewerName,
          organizationId: identity.organizationId,
          organizationName: identity.organizationName,
          organizationUrlKey: identity.organizationUrlKey,
          organizationLogoUrl: identity.organizationLogoUrl,
          message: identity.viewerId ? null : "Linear API token is valid but viewer lookup returned no id.",
        };
      } catch (error) {
        return {
          connected: false,
          viewerId: null,
          viewerName: null,
          organizationId: null,
          organizationName: null,
          organizationUrlKey: null,
          organizationLogoUrl: null,
          message: getErrorMessage(error),
        };
      }
    },
  };
}

export type LinearIssueTracker = ReturnType<typeof createLinearIssueTracker>;
