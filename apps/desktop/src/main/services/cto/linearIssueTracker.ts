import type { IssueTracker } from "./issueTracker";
import type { LinearClient } from "./linearClient";
import { getErrorMessage } from "../shared/utils";

export function createLinearIssueTracker(args: { client: LinearClient }): IssueTracker {
  return {
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

    createComment(issueId, body) {
      return args.client.createComment(issueId, body);
    },

    updateComment(commentId, body) {
      return args.client.updateComment(commentId, body);
    },

    addLabel(issueId, labelName) {
      return args.client.addLabel(issueId, labelName);
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
