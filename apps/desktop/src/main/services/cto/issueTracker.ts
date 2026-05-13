import type {
  CtoLinearProject,
  CtoLinearQuickView,
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  NormalizedLinearIssue,
} from "../../../shared/types";

export type IssueTrackerCandidateQuery = {
  projectSlugs: string[];
  stateTypes: string[];
};

export type IssueTrackerIssueSearchQuery = {
  projectId?: string | null;
  projectSlug?: string | null;
  teamKey?: string | null;
  stateTypes?: string[];
  assigneeId?: string | null;
  priority?: number | null;
  query?: string | null;
  first?: number;
  after?: string | null;
  includeArchived?: boolean;
};

export type IssueTrackerIssueSearchResult = {
  issues: NormalizedLinearIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

export type IssueTrackerWorkpadResult = {
  commentId: string;
};

export type IssueTrackerAttachmentAttribute = {
  name: string;
  value: string;
};

export type IssueTrackerAttachmentMessage = {
  subject?: string;
  body?: string;
  timestamp?: string;
};

export type IssueTrackerIssueAttachmentInput = {
  issueId: string;
  title: string;
  url: string;
  subtitle?: string | null;
  iconUrl?: string | null;
  metadata?: Record<string, unknown> & {
    title?: string;
    attributes?: IssueTrackerAttachmentAttribute[];
    messages?: IssueTrackerAttachmentMessage[];
  };
};

export type IssueTrackerWorkflowState = {
  id: string;
  name: string;
  type: string;
  teamId: string;
  teamKey: string;
};

export type IssueTracker = {
  listProjects(): Promise<CtoLinearProject[]>;
  getQuickView(connection: CtoLinearQuickView["connection"]): Promise<CtoLinearQuickView>;
  listUsers(): Promise<LinearCatalogUser[]>;
  listLabels(teamKey?: string | null): Promise<LinearCatalogLabel[]>;
  searchIssues(query: IssueTrackerIssueSearchQuery): Promise<IssueTrackerIssueSearchResult>;
  fetchCandidateIssues(query: IssueTrackerCandidateQuery): Promise<NormalizedLinearIssue[]>;
  fetchIssueById(issueId: string): Promise<NormalizedLinearIssue | null>;
  fetchIssuesByIds(issueIds: string[]): Promise<Map<string, NormalizedLinearIssue>>;
  fetchWorkflowStates(teamKey: string): Promise<IssueTrackerWorkflowState[]>;
  listWorkflowStates(teamKey?: string | null): Promise<LinearCatalogState[]>;
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>;
  createComment(issueId: string, body: string): Promise<IssueTrackerWorkpadResult>;
  updateComment(commentId: string, body: string): Promise<void>;
  addLabel(issueId: string, labelName: string): Promise<void>;
  uploadAttachment(args: { issueId: string; filePath: string; title?: string }): Promise<{ url: string; id?: string }>;
  createIssueAttachment(args: IssueTrackerIssueAttachmentInput): Promise<{ url: string; id?: string }>;
  getConnectionStatus(): Promise<{
    connected: boolean;
    viewerId: string | null;
    viewerName: string | null;
    organizationId?: string | null;
    organizationName?: string | null;
    organizationUrlKey?: string | null;
    organizationLogoUrl?: string | null;
    message: string | null;
  }>;
};
