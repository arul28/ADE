import type { IssueTracker } from "./issueTracker";
import type { LinearClient } from "./linearClient";
import { getErrorMessage } from "../shared/utils";

export function createLinearIssueTracker(args: { client: LinearClient }): IssueTracker {
  return {
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

    async getConnectionStatus() {
      try {
        const viewer = await args.client.getViewer();
        return {
          connected: Boolean(viewer.id),
          viewerId: viewer.id,
          viewerName: viewer.name,
          message: viewer.id ? null : "Linear API token is valid but viewer lookup returned no id.",
        };
      } catch (error) {
        return {
          connected: false,
          viewerId: null,
          viewerName: null,
          message: getErrorMessage(error),
        };
      }
    },
  };
}

export type LinearIssueTracker = ReturnType<typeof createLinearIssueTracker>;
