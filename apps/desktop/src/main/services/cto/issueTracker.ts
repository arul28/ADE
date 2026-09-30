import type {
  CtoCountLinearIssuesResult,
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoUpdateLinearIssueArgs,
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  LinearInboxNotification,
  LinearIssueCreateInput,
  LinearIssueRelationKind,
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
  stateIds?: string[];
  assigneeId?: string | null;
  assignedToViewer?: boolean;
  activeCycle?: boolean;
  customViewId?: string | null;
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
  totalCount?: number | null;
};

export type IssueTrackerIssueCountQuery = {
  queries: Record<string, IssueTrackerIssueSearchQuery>;
  cap?: number;
};

export type IssueTrackerIssueUpdate = Omit<CtoUpdateLinearIssueArgs, "issueId">;

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

export type IssueTrackerFollowUpInput = LinearIssueCreateInput & {
  /** The issue being worked on; the new issue is linked to it. */
  sourceIssueId?: string | null;
  /** How the new issue relates to the source. Defaults to "related". */
  relation?: LinearIssueRelationKind | "sub_issue" | null;
  allowDuplicate?: boolean;
};

export type IssueTrackerFollowUpResult =
  | { created: true; issue: NormalizedLinearIssue; relation: string | null }
  | { created: false; reason: "duplicate"; duplicateOf: Pick<NormalizedLinearIssue, "id" | "identifier" | "title" | "url" | "stateName"> };

export type IssueTracker = {
  runGraphQL(args: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string | null;
    maxRetries?: number;
  }): Promise<unknown>;
  listProjects(): Promise<CtoLinearProject[]>;
  getQuickView(connection: CtoLinearQuickView["connection"]): Promise<CtoLinearQuickView>;
  listUsers(): Promise<LinearCatalogUser[]>;
  listLabels(teamKey?: string | null): Promise<LinearCatalogLabel[]>;
  searchIssues(query: IssueTrackerIssueSearchQuery): Promise<IssueTrackerIssueSearchResult>;
  /** Live issue counts per key; each key is one filter. */
  countIssues(query: IssueTrackerIssueCountQuery): Promise<CtoCountLinearIssuesResult>;
  /** The viewer's issue custom views whose saved filter can be applied. */
  listCustomViews(): Promise<CtoLinearCustomView[]>;
  fetchCandidateIssues(query: IssueTrackerCandidateQuery): Promise<NormalizedLinearIssue[]>;
  fetchIssueById(issueId: string): Promise<NormalizedLinearIssue | null>;
  fetchIssuesByIds(issueIds: string[]): Promise<Map<string, NormalizedLinearIssue>>;
  fetchWorkflowStates(teamKey: string): Promise<IssueTrackerWorkflowState[]>;
  listWorkflowStates(teamKey?: string | null): Promise<LinearCatalogState[]>;
  updateIssueState(issueId: string, stateId: string): Promise<void>;
  updateIssueAssignee(issueId: string, assigneeId: string | null): Promise<void>;
  updateIssuePriority(issueId: string, priority: number): Promise<void>;
  /** One `issueUpdate` with every given field, then a fresh detail read. */
  updateIssue(issueId: string, patch: IssueTrackerIssueUpdate): Promise<NormalizedLinearIssue | null>;
  createComment(issueId: string, body: string): Promise<IssueTrackerWorkpadResult>;
  updateComment(commentId: string, body: string): Promise<void>;
  addLabel(issueId: string, labelName: string): Promise<void>;
  addIssueLabel(issueId: string, labelId: string): Promise<void>;
  removeIssueLabel(issueId: string, labelId: string): Promise<void>;
  uploadAttachment(args: { issueId: string; filePath: string; title?: string }): Promise<{ url: string; id?: string }>;
  createIssueAttachment(args: IssueTrackerIssueAttachmentInput): Promise<{ url: string; id?: string }>;
  fetchIssueComments(issueId: string): Promise<Array<{
    id: string;
    body: string;
    createdAt: string;
    userName: string;
    userDisplayName: string;
  }>>;
  createIssue(input: LinearIssueCreateInput): Promise<NormalizedLinearIssue>;
  createIssueRelation(args: { issueId: string; relatedIssueId: string; type: LinearIssueRelationKind }): Promise<{ id: string }>;
  /**
   * Files a follow-up found while working on `sourceIssueId`: refuses when an
   * open issue in the same team already has a very similar title (unless
   * `allowDuplicate`), then creates it and links it to the source issue.
   */
  createFollowUpIssue(args: IssueTrackerFollowUpInput): Promise<IssueTrackerFollowUpResult>;
  /** Projects, users, workflow states and labels for issue pickers; each list is empty when its read fails. */
  getIssuePickerData(): Promise<CtoGetLinearIssuePickerDataResult>;
  /**
   * Moves the issue to its team's Canceled state. Reads the live issue first,
   * so an issue that is already completed or canceled is left as it is.
   */
  cancelIssue(issueId: string): Promise<{ canceled: boolean; issue: NormalizedLinearIssue | null }>;
  listNotifications(args?: { first?: number; includeRead?: boolean }): Promise<LinearInboxNotification[]>;
  markNotification(args: { notificationId: string; action: "read" | "archive" }): Promise<void>;
  createProjectUpdate(args: { projectId: string; body: string; health?: "onTrack" | "atRisk" | "offTrack" | null }): Promise<{ id: string; url: string | null }>;
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
