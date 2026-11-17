// Leaf pieces shared by the Linear client modules: request types, the
// rate-budget check, issue field fragments, and issue normalization.

import type { NormalizedLinearIssue } from "../../../shared/types";
import { isRecord, asArray } from "../shared/utils";

/** Linear workflow state types that count as open work. */
export const OPEN_ISSUE_STATE_TYPES = ["triage", "backlog", "unstarted", "started"];

export { priorityIsValid, toNormalizedIssue } from "../../../shared/linearIssueNormalize";
import { toNormalizedIssue } from "../../../shared/linearIssueNormalize";

export type LinearRateBudget = {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  complexityRemaining: number | null;
  complexityLimit: number | null;
  observedAt: number;
};

export type LinearRequestMeter = { requests: number; complexity: number };

// Counts are extra: skip them when less than this share of either hourly
// budget is left, so they never starve reads and writes the user asked for.
const COUNT_BUDGET_FLOOR = 0.2;

export function budgetIsLow(budget: LinearRateBudget | null): boolean {
  if (!budget || Date.now() - budget.observedAt > 60 * 60_000) return false;
  const low = (remaining: number | null, limit: number | null) =>
    remaining != null && limit != null && limit > 0 && remaining / limit < COUNT_BUDGET_FLOOR;
  return low(budget.requestsRemaining, budget.requestsLimit) || low(budget.complexityRemaining, budget.complexityLimit);
}

export type LinearRequestParams = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string | null;
  maxRetries?: number;
  meter?: LinearRequestMeter;
};

/** The client's GraphQL transport (auth refresh, retries, rate headers). */
export type LinearRequest = <TData = Record<string, unknown>>(params: LinearRequestParams) => Promise<TData>;

const ISSUE_REF_FIELDS = `id identifier title state { id name type }`;

const ISSUE_BASE_FIELDS = `
    id
    identifier
    title
    description
    url
    branchName
    priority
    createdAt
    updatedAt
    dueDate
    estimate
    archivedAt
    completedAt
    canceledAt
    startedAt
    project { id name slug: slugId }
    team { id key name }
    state { id name type }
    assignee { id name displayName avatarUrl }
    creator { id name displayName }
    labels { nodes { id name color } }
    cycle { id name startsAt endsAt }
    parent { ${ISSUE_REF_FIELDS} }
  `;

// List reads stay light: sub-issues and "blocked by" only. Outgoing relations
// (blocks / related) come from the detail read below.
export const ISSUE_FIELDS_FRAGMENT = `
    ${ISSUE_BASE_FIELDS}
    children(first: 25) { nodes { ${ISSUE_REF_FIELDS} } }
    inverseRelations(first: 10) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }
  `;

export const ISSUE_DETAIL_FIELDS_FRAGMENT = `
    ${ISSUE_BASE_FIELDS}
    children(first: 50) { nodes { ${ISSUE_REF_FIELDS} } }
    relations(first: 25) { nodes { type relatedIssue { ${ISSUE_REF_FIELDS} } } }
    inverseRelations(first: 25) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }
  `;

export type IssueConnectionData = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: Array<Record<string, unknown>>;
  totalCount?: number;
};

export const normalizeIssueNodes = (nodes: unknown): NormalizedLinearIssue[] =>
  asArray(nodes)
    .map((entry) => (isRecord(entry) ? toNormalizedIssue(entry) : null))
    .filter((entry): entry is NormalizedLinearIssue => entry != null);
