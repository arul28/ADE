// Leaf pieces shared by the Linear client modules: request types, the
// rate-budget check, issue field fragments, and issue normalization.

import type { LinearIssueRef, NormalizedLinearIssue } from "../../../shared/types";
import { isRecord, toOptionalString as asString, asArray } from "../shared/utils";
import { linearPriorityLabel } from "../../../shared/laneLinearIssue";

/** Linear workflow state types that count as open work. */
export const OPEN_ISSUE_STATE_TYPES = ["triage", "backlog", "unstarted", "started"];

export function priorityIsValid(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;
}

function isOpenStateType(stateType: string): boolean {
  return stateType !== "completed" && stateType !== "canceled" && stateType !== "duplicate";
}

function isRelatedRelationType(type: string | null): boolean {
  return type === "related" || type === "duplicate";
}

function toIssueRef(value: unknown): LinearIssueRef | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  const state = isRecord(value.state) ? value.state : null;
  return {
    id,
    identifier: asString(value.identifier) ?? "",
    title: asString(value.title) ?? "",
    stateId: state ? asString(state.id) ?? "" : "",
    stateName: state ? asString(state.name) ?? "" : "",
    stateType: state ? asString(state.type) ?? "" : "",
  };
}

function dedupeIssueRefs(refs: Array<LinearIssueRef | null>): LinearIssueRef[] {
  const seen = new Map<string, LinearIssueRef>();
  for (const ref of refs) {
    if (ref && !seen.has(ref.id)) seen.set(ref.id, ref);
  }
  return [...seen.values()];
}

export function toNormalizedIssue(node: Record<string, unknown>): NormalizedLinearIssue | null {
  const id = asString(node.id);
  const identifier = asString(node.identifier);
  const title = asString(node.title);
  if (!id || !identifier || !title) return null;

  // Linear allows issues without a project (they live in a team only), so
  // `project` is optional during normalization — falling through to empty
  // strings keeps the existing display fallbacks (`projectName || projectSlug
  // || teamKey`) intact. `team` and `state` remain required since every
  // Linear issue has them.
  const project = isRecord(node.project) ? node.project : null;
  const team = isRecord(node.team) ? node.team : null;
  const state = isRecord(node.state) ? node.state : null;
  if (!team || !state) return null;

  const projectId = project ? (asString(project.id) ?? "") : "";
  const projectSlug = project ? (asString(project.slug) ?? asString(project.slugId) ?? "") : "";
  const teamId = asString(team.id);
  const teamKey = asString(team.key);
  const stateId = asString(state.id);
  const stateName = asString(state.name);
  const stateType = asString(state.type);
  if (!teamId || !teamKey || !stateId || !stateName || !stateType) return null;

  const labelsNodes = isRecord(node.labels) ? asArray(node.labels.nodes) : [];
  const labels = labelsNodes
    .map((entry) => (isRecord(entry) ? asString(entry.name) : null))
    .filter((entry): entry is string => entry != null)
    .map((entry) => entry.toLowerCase());

  const labelColors = labelsNodes
    .filter((ln: unknown): ln is Record<string, unknown> => isRecord(ln))
    .map((ln) => {
      const labelId = asString(ln.id);
      return {
        ...(labelId ? { id: labelId } : {}),
        name: asString(ln.name) ?? "",
        color: asString(ln.color) ?? null,
      };
    });

  const cycle = isRecord(node.cycle) ? node.cycle : null;
  const cycleId = cycle ? asString(cycle.id) : null;
  const cycleName = cycle ? asString(cycle.name) : null;
  const cycleStartsAt = cycle ? asString(cycle.startsAt) : null;
  const cycleEndsAt = cycle ? asString(cycle.endsAt) : null;

  const childIssues = (isRecord(node.children) ? asArray(node.children.nodes) : [])
    .map(toIssueRef)
    .filter((entry): entry is LinearIssueRef => entry != null);

  const parentIssue = toIssueRef(node.parent);

  // Linear stores "A blocks B" once, as a relation on A. B sees it through
  // `inverseRelations` (its source `issue` is the blocker), so "blocked by"
  // comes from inverse `blocks` relations — never from sub-issues.
  const inverseRelationNodes = isRecord(node.inverseRelations)
    ? asArray(node.inverseRelations.nodes).filter(isRecord)
    : [];
  const outgoingRelationNodes = isRecord(node.relations)
    ? asArray(node.relations.nodes).filter(isRecord)
    : null;
  const blockedByIssues = dedupeIssueRefs(
    inverseRelationNodes
      .filter((relation) => asString(relation.type) === "blocks")
      .map((relation) => toIssueRef(relation.issue)),
  );
  const blockingIssues = outgoingRelationNodes
    ? dedupeIssueRefs(
      outgoingRelationNodes
        .filter((relation) => asString(relation.type) === "blocks")
        .map((relation) => toIssueRef(relation.relatedIssue)),
    )
    : undefined;
  const relatedIssues = outgoingRelationNodes
    ? dedupeIssueRefs([
      ...outgoingRelationNodes
        .filter((relation) => isRelatedRelationType(asString(relation.type)))
        .map((relation) => toIssueRef(relation.relatedIssue)),
      ...inverseRelationNodes
        .filter((relation) => isRelatedRelationType(asString(relation.type)))
        .map((relation) => toIssueRef(relation.issue)),
    ])
    : undefined;
  const blockerIssueIds = blockedByIssues.map((entry) => entry.id);
  const hasOpenBlockers = blockedByIssues.some((entry) => isOpenStateType(entry.stateType));

  const assignee = isRecord(node.assignee) ? node.assignee : null;
  const owner = isRecord(node.creator) ? node.creator : null;
  const priority = Number(node.priority ?? 0);
  const metadataRecord = isRecord(node.metadata) ? node.metadata : null;
  const metadataTagsRaw = metadataRecord && Array.isArray(metadataRecord.tags)
    ? (metadataRecord.tags as unknown[])
    : [];
  const metadataTags = metadataTagsRaw.filter((tag): tag is string => typeof tag === "string");

  return {
    id,
    identifier,
    title,
    description: asString(node.description) ?? "",
    url: asString(node.url),
    projectId,
    projectSlug,
    projectName: project ? asString(project.name) : null,
    teamId,
    teamKey,
    teamName: asString(team.name),
    stateId,
    stateName,
    stateType,
    priority: Number.isFinite(priority) ? priority : 0,
    priorityLabel: linearPriorityLabel(Number.isFinite(priority) ? priority : 0),
    labels,
    labelColors,
    cycleId,
    cycleName,
    cycleStartsAt,
    cycleEndsAt,
    childIssues,
    parentIssue,
    blockedByIssues,
    ...(blockingIssues ? { blockingIssues } : {}),
    ...(relatedIssues ? { relatedIssues } : {}),
    branchName: asString(node.branchName),
    metadataTags,
    assigneeId: assignee ? asString(assignee.id) : null,
    assigneeName: assignee ? (asString(assignee.displayName) ?? asString(assignee.name)) : null,
    assigneeAvatarUrl: assignee ? asString(assignee.avatarUrl) : null,
    ownerId: owner ? asString(owner.id) : null,
    creatorId: owner ? asString(owner.id) : null,
    creatorName: owner ? (asString(owner.displayName) ?? asString(owner.name)) : null,
    blockerIssueIds,
    hasOpenBlockers,
    dueDate: asString(node.dueDate),
    estimate: typeof node.estimate === "number" && Number.isFinite(node.estimate) ? node.estimate : null,
    archivedAt: asString(node.archivedAt),
    completedAt: asString(node.completedAt),
    canceledAt: asString(node.canceledAt),
    startedAt: asString(node.startedAt),
    createdAt: asString(node.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(node.updatedAt) ?? new Date().toISOString(),
    raw: node,
  };
}

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
