import type { IssueRef } from "../issueRefs";

export type IssueTrackerKind = "linear" | "github" | "jira";

export type IssueTrackerCapabilities = {
  create: boolean;
  comment: boolean;
  edit: boolean;
  labels: boolean;
  assignees: boolean;
  states: boolean;
  templates: boolean;
};

export type IssueState = {
  id: string;
  name: string;
  type?: string | null;
};

export type IssueComment = {
  id: string;
  body: string;
  author: string | null;
  createdAt: string;
  updatedAt?: string | null;
  url?: string | null;
};

export type IssueSummary = {
  kind: IssueTrackerKind;
  id: string;
  reference: IssueRef;
  title: string;
  state: IssueState | null;
  url: string | null;
  labels: string[];
  assignees: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type IssueDetail = IssueSummary & {
  body: string;
  comments: IssueComment[];
  commentsCursor: string | null;
};

export type IssuePage = {
  issues: IssueSummary[];
  nextCursor: string | null;
};

export type IssueCommentsPage = {
  comments: IssueComment[];
  nextCursor: string | null;
};

export type IssueTrackerErrorReason =
  | "not-connected"
  | "unauthenticated"
  | "forbidden"
  | "rate-limited"
  | "not-found"
  | "invalid"
  | "failed";

export type IssueTrackerResolution = {
  kind: IssueTrackerKind;
  reference: IssueRef;
  capabilities: IssueTrackerCapabilities;
};

export type IssueListArgs = {
  tracker?: IssueTrackerKind;
  scope?: string;
  state?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
};

export type IssueCreateArgs = {
  tracker: IssueTrackerKind;
  scope: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: string;
  template?: string;
  issueType?: string;
};

export type IssueUpdateArgs = {
  reference: string | IssueRef;
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
};

export type IssueTrackerAdapter = {
  kind: IssueTrackerKind;
  capabilities: IssueTrackerCapabilities;
  getViewer(): Promise<{ id: string | null; name: string | null }>;
  listIssues(args: Omit<IssueListArgs, "tracker">): Promise<IssuePage>;
  getIssue(reference: IssueRef): Promise<IssueDetail>;
  getComments(reference: IssueRef, cursor?: string | null): Promise<IssueCommentsPage>;
  comment(reference: IssueRef, body: string): Promise<void>;
  update(reference: IssueRef, patch: Omit<IssueUpdateArgs, "reference">): Promise<void>;
  setState(reference: IssueRef, state: string): Promise<void>;
  create(args: Omit<IssueCreateArgs, "tracker">): Promise<IssueDetail>;
  listStates(args: { scope?: string; reference?: IssueRef }): Promise<IssueState[]>;
};

export type IssueTrackerService = {
  resolve(args: { reference: string | IssueRef }): Promise<IssueTrackerResolution>;
  getViewer(args: { tracker: IssueTrackerKind }): Promise<{ id: string | null; name: string | null }>;
  list(args: IssueListArgs): Promise<IssuePage>;
  get(args: { reference: string | IssueRef }): Promise<IssueDetail>;
  getComments(args: { reference: string | IssueRef; cursor?: string | null }): Promise<IssueCommentsPage>;
  comment(args: { reference: string | IssueRef; body: string }): Promise<void>;
  update(args: IssueUpdateArgs): Promise<void>;
  setState(args: { reference: string | IssueRef; state: string }): Promise<void>;
  create(args: IssueCreateArgs): Promise<IssueDetail>;
  listStates(args: { tracker?: IssueTrackerKind; scope?: string; reference?: string | IssueRef }): Promise<IssueState[]>;
  isConnected(kind: IssueTrackerKind): Promise<boolean>;
};
