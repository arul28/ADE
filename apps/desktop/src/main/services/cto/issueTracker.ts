import type { NormalizedLinearIssue } from "../../../shared/types";

export type IssueTrackerCandidateQuery = {
  projectSlugs: string[];
  stateTypes: string[];
};

export type IssueTrackerWorkpadResult = {
  commentId: string;
};

export type IssueTrackerWorkflowState = {
  id: string;
  name: string;
  type: string;
  teamId: string;
  teamKey: string;
};

export type IssueTracker = {
  fetchCandidateIssues(query: IssueTrackerCandidateQuery): Promise<NormalizedLinearIssue[]>;
  fetchIssueById(issueId: string): Promise<NormalizedLinearIssue | null>;
  fetchIssuesByIds(issueIds: string[]): Promise<Map<string, NormalizedLinearIssue>>;
  fetchWorkflowStates(teamKey: string): Promise<IssueTrackerWorkflowState[]>;
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>;
  createComment(issueId: string, body: string): Promise<IssueTrackerWorkpadResult>;
  updateComment(commentId: string, body: string): Promise<void>;
  addLabel(issueId: string, labelName: string): Promise<void>;
  uploadAttachment(args: { issueId: string; filePath: string; title?: string }): Promise<{ url: string; id?: string }>;
  getConnectionStatus(): Promise<{
    connected: boolean;
    viewerId: string | null;
    viewerName: string | null;
    message: string | null;
  }>;
};
