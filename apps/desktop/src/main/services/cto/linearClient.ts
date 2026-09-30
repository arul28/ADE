import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type {
  CtoCountLinearIssuesResult,
  CtoLinearIssueCount,
  CtoLinearCustomView,
  LinearInboxNotification,
  LinearIssueCreateInput,
  LinearIssueRelationKind,
  CtoLinearQuickView,
  CtoLinearQuickViewProject,
  CtoLinearQuickViewTeam,
  CtoLinearProject,
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  LinearIssueRef,
  LinearPriorityLabel,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { LinearCredentialService } from "./linearCredentialService";
import type {
  IssueTrackerIssueAttachmentInput,
  IssueTrackerIssueCountQuery,
  IssueTrackerIssueSearchQuery,
  IssueTrackerIssueSearchResult,
  IssueTrackerIssueUpdate,
} from "./issueTracker";
import { isRecord, toOptionalString as asString, asArray, sleep, getErrorMessage } from "../shared/utils";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

function mapPriorityLabel(priority: number): LinearPriorityLabel {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "normal";
  if (priority === 4) return "low";
  return "none";
}

function toAuthorizationHeaderValue(token: string, authMode: "manual" | "oauth" | null | undefined): string {
  const trimmed = token.trim();
  if (authMode === "oauth") {
    return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  }
  if (authMode === "manual") {
    return trimmed.replace(/^bearer\s+/i, "");
  }
  return trimmed;
}

function priorityIsValid(value: number | null | undefined): value is number {
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

function toNormalizedIssue(node: Record<string, unknown>): NormalizedLinearIssue | null {
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
    priorityLabel: mapPriorityLabel(Number.isFinite(priority) ? priority : 0),
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

export type LinearClientArgs = {
  credentials: LinearCredentialService;
  logger?: Logger | null;
  fetchImpl?: typeof fetch;
};

export type LinearWebhookSummary = {
  id: string;
  url: string;
  enabled: boolean;
  label: string | null;
  resourceTypes: string[];
  allPublicTeams: boolean;
};

type LinearRateBudget = {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  complexityRemaining: number | null;
  complexityLimit: number | null;
  observedAt: number;
};

type LinearRequestMeter = { requests: number; complexity: number };

// Counts are extra: skip them when less than this share of either hourly
// budget is left, so they never starve reads and writes the user asked for.
const COUNT_BUDGET_FLOOR = 0.2;

function budgetIsLow(budget: LinearRateBudget | null): boolean {
  if (!budget || Date.now() - budget.observedAt > 60 * 60_000) return false;
  const low = (remaining: number | null, limit: number | null) =>
    remaining != null && limit != null && limit > 0 && remaining / limit < COUNT_BUDGET_FLOOR;
  return low(budget.requestsRemaining, budget.requestsLimit) || low(budget.complexityRemaining, budget.complexityLimit);
}

export function createLinearClient(args: LinearClientArgs) {
  const fetchImpl = args.fetchImpl ?? fetch;

  const ensureFreshAuth = async (opts?: { force?: boolean }): Promise<void> => {
    try {
      await args.credentials.ensureFreshToken?.(opts);
    } catch {
      // Best effort: a refresh failure must not block the request. If the token
      // is truly dead, the request below surfaces its own auth error.
    }
  };

  // Latest rate-limit budget Linear reported (X-RateLimit-* headers). Null
  // until a response carries the headers.
  let rateBudget: LinearRateBudget | null = null;

  const readRateHeaders = (res: Response, meter?: LinearRequestMeter): void => {
    const read = (name: string): number | null => {
      const raw = typeof res.headers?.get === "function" ? res.headers.get(name) : null;
      const value = raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const complexity = read("x-complexity");
    if (meter) {
      meter.requests += 1;
      if (complexity != null) meter.complexity += complexity;
    }
    const requestsRemaining = read("x-ratelimit-requests-remaining");
    const complexityRemaining = read("x-ratelimit-complexity-remaining");
    if (requestsRemaining == null && complexityRemaining == null) return;
    rateBudget = {
      requestsRemaining,
      requestsLimit: read("x-ratelimit-requests-limit"),
      complexityRemaining,
      complexityLimit: read("x-ratelimit-complexity-limit"),
      observedAt: Date.now(),
    };
  };

  const request = async <TData = Record<string, unknown>>(params: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string | null;
    maxRetries?: number;
    meter?: LinearRequestMeter;
  }): Promise<TData> => {
    // Proactively refresh an OAuth token that is at/near expiry before sending.
    await ensureFreshAuth();
    const maxRetries = Math.max(0, Math.floor(params.maxRetries ?? 3));
    let attempt = 0;
    let backoffMs = 500;
    let didAuthRefresh = false;

    while (true) {
      attempt += 1;
      // Re-read per attempt so a refresh between attempts uses the new token.
      const token = toAuthorizationHeaderValue(
        args.credentials.getTokenOrThrow(),
        args.credentials.getStatus().authMode
      );
      let res: Response;
      try {
        res = await fetchImpl(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: token,
          },
          body: JSON.stringify({
            query: params.query,
            variables: params.variables ?? {},
            ...(params.operationName ? { operationName: params.operationName } : {}),
          }),
        });
      } catch (error) {
        if (attempt > maxRetries) throw error;
        await sleep(backoffMs);
        backoffMs = Math.min(15_000, Math.floor(backoffMs * 2));
        continue;
      }

      readRateHeaders(res, params.meter);
      const payload = await res.json().catch(() => ({})) as {
        data?: TData;
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      };

      const message = payload.errors?.[0]?.message ?? null;
      const errorCode = payload.errors?.[0]?.extensions?.code ?? null;

      // Reactive refresh: if the access token was rejected, refresh once and
      // retry with the new token (covers a token already expired by the time
      // the request fired, or one with no recorded expiry).
      const isAuthError =
        res.status === 401 ||
        errorCode === "AUTHENTICATION_ERROR" ||
        (message ? /authentication|unauthor|invalid.*token|token.*expired/i.test(message) : false);
      if (isAuthError && !didAuthRefresh && args.credentials.getStatus().authMode === "oauth") {
        didAuthRefresh = true;
        await ensureFreshAuth({ force: true });
        continue;
      }

      const isRateLimited =
        res.status === 429 ||
        errorCode === "RATELIMITED" ||
        (message ? /rate\s*limit|too\s*many\s*requests/i.test(message) : false);

      if ((!res.ok || payload.errors?.length) && (isRateLimited || res.status >= 500) && attempt <= maxRetries) {
        await sleep(backoffMs);
        backoffMs = Math.min(15_000, Math.floor(backoffMs * 2));
        continue;
      }

      if (!res.ok || payload.errors?.length || !payload.data) {
        const detail = message ?? `Linear GraphQL request failed (HTTP ${res.status})`;
        throw new Error(detail);
      }

      return payload.data;
    }
  };

  const getViewer = async (): Promise<{ id: string | null; name: string | null }> => {
    const data = await request<{ viewer?: { id?: string; name?: string; displayName?: string } }>({
      query: `query Viewer { viewer { id name displayName } }`,
      maxRetries: 1,
    });
    return {
      id: asString(data.viewer?.id),
      name: asString(data.viewer?.displayName) ?? asString(data.viewer?.name),
    };
  };

  const runGraphQL = async (params: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string | null;
    maxRetries?: number;
  }): Promise<unknown> => {
    return request({
      query: params.query,
      variables: params.variables,
      operationName: params.operationName,
      maxRetries: params.maxRetries,
    });
  };

  const getConnectionIdentity = async (): Promise<{
    viewerId: string | null;
    viewerName: string | null;
    organizationId: string | null;
    organizationName: string | null;
    organizationUrlKey: string | null;
    organizationLogoUrl: string | null;
  }> => {
    const data = await request<{
      viewer?: { id?: string; name?: string; displayName?: string };
      organization?: { id?: string; name?: string; urlKey?: string | null; logoUrl?: string | null };
    }>({
      query: `
        query LinearConnectionIdentity {
          viewer { id name displayName }
          organization { id name urlKey logoUrl }
        }
      `,
      maxRetries: 1,
    });
    return {
      viewerId: asString(data.viewer?.id),
      viewerName: asString(data.viewer?.displayName) ?? asString(data.viewer?.name),
      organizationId: asString(data.organization?.id),
      organizationName: asString(data.organization?.name),
      organizationUrlKey: asString(data.organization?.urlKey),
      organizationLogoUrl: asString(data.organization?.logoUrl),
    };
  };

  const listProjects = async (): Promise<CtoLinearProject[]> => {
    const projects = new Map<string, CtoLinearProject>();
    let after: string | null = null;
    for (let page = 0; page < 25; page += 1) {
      const data = await request<{
        projects?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<Record<string, unknown>>;
        };
      }>({
        query: `
          query Projects($after: String) {
            projects(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                name
                slug: slugId
                icon
                color
                teams {
                  nodes {
                    key
                    name
                  }
                }
              }
            }
          }
        `,
        variables: { after },
        maxRetries: 2,
      });

      const pageProjects = asArray(data.projects?.nodes)
        .map((node): CtoLinearProject | null => {
          if (!isRecord(node)) return null;
          const id = asString(node.id);
          const name = asString(node.name);
          const slug = asString(node.slug);
          if (!id || !name || !slug) return null;
          const teamName =
            (isRecord(node.teams)
              ? asArray(node.teams.nodes)
                .map((entry) => (isRecord(entry) ? asString(entry.name) : null))
                .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
              : null) ?? "Unassigned";
          const teamKey =
            (isRecord(node.teams)
              ? asArray(node.teams.nodes)
                .map((entry) => (isRecord(entry) ? asString(entry.key) : null))
                .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
              : null) ?? null;
          return teamKey
            ? {
                id,
                name,
                slug,
                teamName,
                teamKey,
                icon: asString(node.icon),
                color: asString(node.color),
              }
            : {
                id,
                name,
                slug,
                teamName,
                icon: asString(node.icon),
                color: asString(node.color),
              };
        })
        .filter((entry): entry is CtoLinearProject => entry != null);

      for (const project of pageProjects) {
        projects.set(project.id, project);
      }

      if (!data.projects?.pageInfo?.hasNextPage) break;
      const nextCursor = asString(data.projects.pageInfo.endCursor);
      if (!nextCursor || nextCursor === after) break;
      after = nextCursor;
    }

    return [...projects.values()]
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  const listUsers = async (): Promise<LinearCatalogUser[]> => {
    const data = await request<{
      users?: {
        nodes?: Array<Record<string, unknown>>;
      };
    }>({
      query: `
        query Users {
          users(first: 250, filter: { active: { eq: true } }) {
            nodes {
              id
              name
              displayName
              email
              avatarUrl
              active
            }
          }
        }
      `,
      maxRetries: 2,
    });

    return asArray(data.users?.nodes)
      .map((node): LinearCatalogUser | null => {
        if (!isRecord(node)) return null;
        const id = asString(node.id);
        const name = asString(node.name);
        if (!id || !name) return null;
        return {
          id,
          name,
          displayName: asString(node.displayName),
          email: asString(node.email),
          avatarUrl: asString(node.avatarUrl),
          active: node.active !== false,
        };
      })
      .filter((entry): entry is LinearCatalogUser => entry != null)
      .sort((left, right) => (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name));
  };

  const listLabels = async (teamKey?: string | null): Promise<LinearCatalogLabel[]> => {
    const data = await request<{
      issueLabels?: {
        nodes?: Array<Record<string, unknown>>;
      };
    }>({
      query: `
        query IssueLabels {
          issueLabels(first: 250) {
            nodes {
              id
              name
              color
              team {
                id
                key
              }
            }
          }
        }
      `,
      maxRetries: 2,
    });

    return asArray(data.issueLabels?.nodes)
      .map((node) => {
        if (!isRecord(node)) return null;
        const id = asString(node.id);
        const name = asString(node.name);
        if (!id || !name) return null;
        const team = isRecord(node.team) ? node.team : null;
        return {
          id,
          name,
          color: asString(node.color),
          teamId: team ? asString(team.id) : null,
          teamKey: team ? asString(team.key) : null,
        };
      })
      .filter((entry) => {
        if (!entry) return false;
        if (!teamKey?.trim()) return true;
        return entry.teamKey?.toLowerCase() === teamKey.trim().toLowerCase();
      })
      .filter((entry): entry is LinearCatalogLabel => entry != null)
      .sort((left, right) => left.name.localeCompare(right.name));
  };

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
  const ISSUE_FIELDS_FRAGMENT = `
    ${ISSUE_BASE_FIELDS}
    children(first: 25) { nodes { ${ISSUE_REF_FIELDS} } }
    inverseRelations(first: 10) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }
  `;

  const ISSUE_DETAIL_FIELDS_FRAGMENT = `
    ${ISSUE_BASE_FIELDS}
    children(first: 50) { nodes { ${ISSUE_REF_FIELDS} } }
    relations(first: 25) { nodes { type relatedIssue { ${ISSUE_REF_FIELDS} } } }
    inverseRelations(first: 25) { nodes { type issue { ${ISSUE_REF_FIELDS} } } }
  `;

  const fetchIssuesPage = async (projectSlug: string, stateTypes: string[], after: string | null) => {
    const data = await request<{
      issues?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<Record<string, unknown>>;
      };
    }>({
      query: `
        query IssuesByProject($projectSlug: String!, $stateTypes: [String!], $after: String) {
          issues(
            first: 50,
            after: $after,
            filter: {
              project: { slugId: { eq: $projectSlug } },
              state: { type: { in: $stateTypes } }
            }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${ISSUE_FIELDS_FRAGMENT}
            }
          }
        }
      `,
      variables: {
        projectSlug,
        stateTypes,
        after,
      },
    });

    const nodes = asArray(data.issues?.nodes)
      .map((entry) => (isRecord(entry) ? toNormalizedIssue(entry) : null))
      .filter((entry): entry is NormalizedLinearIssue => entry != null);

    return {
      nodes,
      hasNextPage: Boolean(data.issues?.pageInfo?.hasNextPage),
      endCursor: asString(data.issues?.pageInfo?.endCursor),
    };
  };

  const fetchAllPagesForSlug = async (projectSlug: string, stateTypes: string[]): Promise<NormalizedLinearIssue[]> => {
    const issues: NormalizedLinearIssue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await fetchIssuesPage(projectSlug, stateTypes, cursor);
      issues.push(...res.nodes);
      if (!res.hasNextPage || !res.endCursor) break;
      cursor = res.endCursor;
    }
    return issues;
  };

  const fetchCandidateIssues = async (params: {
    projectSlugs: string[];
    stateTypes: string[];
  }): Promise<NormalizedLinearIssue[]> => {
    const results = await Promise.all(
      params.projectSlugs.map((slug) => fetchAllPagesForSlug(slug, params.stateTypes))
    );
    return results.flat();
  };

  const CUSTOM_VIEW_FILTER_TTL_MS = 60_000;
  const customViewFilterCache = new Map<string, { filter: Record<string, unknown>; fetchedAt: number }>();

  const fetchCustomViewFilter = async (viewId: string): Promise<Record<string, unknown>> => {
    const cached = customViewFilterCache.get(viewId);
    if (cached && Date.now() - cached.fetchedAt < CUSTOM_VIEW_FILTER_TTL_MS) return cached.filter;
    const data = await request<{ customView?: { filterData?: unknown; modelName?: string } }>({
      query: `
        query CustomViewFilter($id: String!) {
          customView(id: $id) { id modelName filterData }
        }
      `,
      variables: { id: viewId },
      maxRetries: 1,
    });
    const filter = data.customView?.filterData;
    if (!isRecord(filter)) throw new Error("This Linear view has no issue filter ADE can apply.");
    customViewFilterCache.set(viewId, { filter, fetchedAt: Date.now() });
    return filter;
  };

  // Every filter except the text query. The text query is either a full-text
  // `searchIssues` term or, as a fallback, a title/description clause.
  const buildIssueBaseFilter = (params: IssueTrackerIssueSearchQuery): Record<string, unknown> => {
    const filter: Record<string, unknown> = {};
    const projectId = params.projectId?.trim();
    const projectSlug = params.projectSlug?.trim();
    const teamKey = params.teamKey?.trim();
    const stateTypes = (params.stateTypes ?? []).map((entry) => entry.trim()).filter(Boolean);
    const stateIds = (params.stateIds ?? []).map((entry) => entry.trim()).filter(Boolean);
    const assigneeId = params.assigneeId?.trim();

    if (projectId) {
      filter.project = { id: { eq: projectId } };
    } else if (projectSlug) {
      filter.project = { slugId: { eq: projectSlug } };
    }
    if (teamKey) {
      filter.team = { key: { eq: teamKey } };
    }
    if (stateTypes.length > 0 || stateIds.length > 0) {
      filter.state = {
        ...(stateTypes.length > 0 ? { type: { in: stateTypes } } : {}),
        ...(stateIds.length > 0 ? { id: { in: stateIds } } : {}),
      };
    }
    if (assigneeId) {
      filter.assignee = { id: { eq: assigneeId } };
    } else if (params.assignedToViewer === true) {
      filter.assignee = { isMe: { eq: true } };
    }
    if (params.activeCycle === true) {
      filter.cycle = { isActive: { eq: true } };
    }
    if (priorityIsValid(params.priority)) {
      filter.priority = { eq: params.priority };
    }
    return filter;
  };

  const andFilters = (...filters: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> => {
    const parts = filters.filter((entry): entry is Record<string, unknown> => entry != null && Object.keys(entry).length > 0);
    if (parts.length === 0) return {};
    if (parts.length === 1) return parts[0]!;
    return { and: parts };
  };

  const resolveIssueFilter = async (params: IssueTrackerIssueSearchQuery): Promise<Record<string, unknown>> => {
    const base = buildIssueBaseFilter(params);
    const viewId = params.customViewId?.trim();
    if (!viewId) return base;
    return andFilters(await fetchCustomViewFilter(viewId), base);
  };

  // Pre-full-text behavior, kept as the fallback when `searchIssues` errors.
  // Linear's IssueFilter has no `identifier` field, so a trailing number ("122"
  // or "VER-122") also matches on the issue number.
  const withLegacyTextFilter = (base: Record<string, unknown>, query: string): Record<string, unknown> => {
    const orClauses: Record<string, unknown>[] = [
      { title: { containsIgnoreCase: query } },
      { description: { containsIgnoreCase: query } },
    ];
    const numberMatch = query.match(/(\d+)\s*$/);
    if (numberMatch) {
      const parsedNumber = Number.parseInt(numberMatch[1]!, 10);
      if (Number.isFinite(parsedNumber)) orClauses.push({ number: { eq: parsedNumber } });
    }
    return "or" in base ? { and: [base, { or: orClauses }] } : { ...base, or: orClauses };
  };

  // "VER-404", "ver-404", "404", "#404" → a number (and team key) filter, so an
  // exact identifier always finds its issue even when full-text ranks it low.
  const identifierFilterForQuery = (query: string): Record<string, unknown> | null => {
    const keyed = query.match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/);
    const bare = query.match(/^#?(\d+)$/);
    const teamKey = keyed ? keyed[1]! : null;
    const numberText = keyed ? keyed[2]! : bare ? bare[1]! : null;
    if (!numberText) return null;
    const parsed = Number.parseInt(numberText, 10);
    if (!Number.isFinite(parsed)) return null;
    return {
      number: { eq: parsed },
      ...(teamKey ? { team: { key: { eqIgnoreCase: teamKey } } } : {}),
    };
  };

  type IssueConnectionData = {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes?: Array<Record<string, unknown>>;
    totalCount?: number;
  };

  const normalizeIssueNodes = (nodes: unknown): NormalizedLinearIssue[] =>
    asArray(nodes)
      .map((entry) => (isRecord(entry) ? toNormalizedIssue(entry) : null))
      .filter((entry): entry is NormalizedLinearIssue => entry != null);

  const fetchIssuesWithFilter = async (params: {
    first: number;
    after: string | null;
    includeArchived: boolean;
    filter: Record<string, unknown>;
  }): Promise<IssueTrackerIssueSearchResult> => {
    const data = await request<{ issues?: IssueConnectionData }>({
      query: `
        query SearchIssues($first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
          issues(
            first: $first,
            after: $after,
            includeArchived: $includeArchived,
            orderBy: updatedAt,
            filter: $filter
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${ISSUE_FIELDS_FRAGMENT}
            }
          }
        }
      `,
      variables: params,
      maxRetries: 2,
    });
    return {
      issues: normalizeIssueNodes(data.issues?.nodes),
      pageInfo: {
        hasNextPage: Boolean(data.issues?.pageInfo?.hasNextPage),
        endCursor: asString(data.issues?.pageInfo?.endCursor),
      },
    };
  };

  const fullTextSearchIssues = async (params: {
    term: string;
    first: number;
    after: string | null;
    includeArchived: boolean;
    filter: Record<string, unknown>;
  }): Promise<IssueTrackerIssueSearchResult> => {
    const identifierFilter = params.after ? null : identifierFilterForQuery(params.term);
    const [search, identifierMatches] = await Promise.all([
      request<{ searchIssues?: IssueConnectionData }>({
        query: `
          query SearchIssuesFullText($term: String!, $first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
            searchIssues(
              term: $term,
              first: $first,
              after: $after,
              includeArchived: $includeArchived,
              filter: $filter
            ) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                ${ISSUE_FIELDS_FRAGMENT}
              }
            }
          }
        `,
        variables: {
          term: params.term,
          first: params.first,
          after: params.after,
          includeArchived: params.includeArchived,
          filter: Object.keys(params.filter).length > 0 ? params.filter : null,
        },
        maxRetries: 1,
      }),
      identifierFilter
        ? fetchIssuesWithFilter({
          first: 10,
          after: null,
          includeArchived: params.includeArchived,
          filter: andFilters(params.filter, identifierFilter),
        }).then((result) => result.issues).catch(() => [] as NormalizedLinearIssue[])
        : Promise.resolve([] as NormalizedLinearIssue[]),
    ]);
    const searchIssuesFound = normalizeIssueNodes(search.searchIssues?.nodes);
    const seen = new Set<string>();
    const issues: NormalizedLinearIssue[] = [];
    for (const issue of [...identifierMatches, ...searchIssuesFound]) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      issues.push(issue);
    }
    const totalCount = typeof search.searchIssues?.totalCount === "number" && Number.isFinite(search.searchIssues.totalCount)
      ? Math.max(search.searchIssues.totalCount, issues.length)
      : null;
    return {
      issues,
      pageInfo: {
        hasNextPage: Boolean(search.searchIssues?.pageInfo?.hasNextPage),
        endCursor: asString(search.searchIssues?.pageInfo?.endCursor),
      },
      totalCount,
    };
  };

  const searchIssues = async (params: IssueTrackerIssueSearchQuery): Promise<IssueTrackerIssueSearchResult> => {
    const first = Math.min(100, Math.max(1, Math.floor(params.first ?? 50)));
    const after = params.after?.trim() || null;
    const includeArchived = params.includeArchived === true;
    const baseFilter = await resolveIssueFilter(params);
    const term = params.query?.trim();
    if (term) {
      try {
        return await fullTextSearchIssues({ term, first, after, includeArchived, filter: baseFilter });
      } catch (error) {
        args.logger?.warn("linear.search_full_text_failed", { error: getErrorMessage(error) });
        // A cursor from `searchIssues` does not page `issues`; restart the fallback.
        return fetchIssuesWithFilter({
          first,
          after: null,
          includeArchived,
          filter: withLegacyTextFilter(baseFilter, term),
        });
      }
    }
    return fetchIssuesWithFilter({ first, after, includeArchived, filter: baseFilter });
  };

  const COUNT_PAGE_SIZE = 250;
  const COUNT_ALIAS_BATCH = 10;
  const DEFAULT_COUNT_CAP = 1000;
  const MAX_COUNT_CAP = 5000;
  const MAX_COUNT_KEYS = 100;

  type CountPage = { count: number; hasNextPage: boolean; endCursor: string | null };
  type PendingCount = { key: string; filter: Record<string, unknown>; after: string | null; count: number };

  const chunk = <T,>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
  };

  // One aliased request pages ids for up to COUNT_ALIAS_BATCH filters. If Linear
  // rejects the batch (one bad filter fails the whole document), retry each
  // filter alone so one bad key cannot blank every count.
  const fetchCountPages = async (
    items: PendingCount[],
    pageSize = COUNT_PAGE_SIZE,
    meter?: LinearRequestMeter,
  ): Promise<Map<string, CountPage | null>> => {
    const out = new Map<string, CountPage | null>();
    const variableDefs: string[] = [];
    const fields: string[] = [];
    const variables: Record<string, unknown> = {};
    items.forEach((item, index) => {
      variableDefs.push(`$f${index}: IssueFilter`, `$a${index}: String`);
      fields.push(`k${index}: issues(first: ${pageSize}, after: $a${index}, includeArchived: false, filter: $f${index}) { nodes { id } pageInfo { hasNextPage endCursor } }`);
      variables[`f${index}`] = Object.keys(item.filter).length > 0 ? item.filter : null;
      variables[`a${index}`] = item.after;
    });
    try {
      const data = await request<Record<string, IssueConnectionData | undefined>>({
        query: `query CountIssues(${variableDefs.join(", ")}) { ${fields.join("\n")} }`,
        variables,
        maxRetries: 2,
        meter,
      });
      items.forEach((item, index) => {
        const connection = data[`k${index}`];
        out.set(item.key, connection
          ? {
            count: asArray(connection.nodes).length,
            hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
            endCursor: asString(connection.pageInfo?.endCursor),
          }
          : null);
      });
    } catch (error) {
      if (items.length === 1) {
        args.logger?.warn("linear.count_issues_failed", { key: items[0]!.key, error: getErrorMessage(error) });
        out.set(items[0]!.key, null);
        return out;
      }
      const singles = await Promise.all(items.map((item) => fetchCountPages([item], pageSize, meter)));
      for (const single of singles) for (const [key, value] of single) out.set(key, value);
    }
    return out;
  };

  const countSearchTerms = async (
    items: Array<{ key: string; term: string; filter: Record<string, unknown> }>,
    meter?: LinearRequestMeter,
  ): Promise<Map<string, number | null>> => {
    const out = new Map<string, number | null>();
    const variableDefs: string[] = [];
    const fields: string[] = [];
    const variables: Record<string, unknown> = {};
    items.forEach((item, index) => {
      variableDefs.push(`$t${index}: String!`, `$f${index}: IssueFilter`);
      fields.push(`k${index}: searchIssues(term: $t${index}, first: 1, includeArchived: false, filter: $f${index}) { totalCount }`);
      variables[`t${index}`] = item.term;
      variables[`f${index}`] = Object.keys(item.filter).length > 0 ? item.filter : null;
    });
    try {
      const data = await request<Record<string, { totalCount?: number } | undefined>>({
        query: `query CountSearchIssues(${variableDefs.join(", ")}) { ${fields.join("\n")} }`,
        variables,
        maxRetries: 1,
        meter,
      });
      items.forEach((item, index) => {
        const total = data[`k${index}`]?.totalCount;
        out.set(item.key, typeof total === "number" && Number.isFinite(total) ? total : null);
      });
    } catch (error) {
      if (items.length === 1) {
        out.set(items[0]!.key, null);
        return out;
      }
      const singles = await Promise.all(items.map((item) => countSearchTerms([item], meter)));
      for (const single of singles) for (const [key, value] of single) out.set(key, value);
    }
    return out;
  };

  // Counts change slowly and every pane open asks for the same ones, so each
  // (filter, cap) answer is reused for a short time, and a count already in
  // flight is shared instead of paged again.
  const COUNT_CACHE_TTL_MS = 60_000;
  const COUNT_CACHE_MAX = 500;
  const countCache = new Map<string, { value: CtoLinearIssueCount | null; at: number }>();
  const countInFlight = new Map<string, Promise<CtoLinearIssueCount | null>>();

  const countIssues = async (params: IssueTrackerIssueCountQuery): Promise<CtoCountLinearIssuesResult> => {
    const cap = Math.min(MAX_COUNT_CAP, Math.max(1, Math.floor(params.cap ?? DEFAULT_COUNT_CAP)));
    const entries = Object.entries(isRecord(params.queries) ? params.queries : {}).slice(0, MAX_COUNT_KEYS);
    const counts: CtoCountLinearIssuesResult["counts"] = {};
    const now = Date.now();
    const misses: Array<[string, IssueTrackerIssueSearchQuery, string]> = [];
    const waits: Array<Promise<void>> = [];
    for (const [key, query] of entries) {
      const cacheKey = JSON.stringify([query, cap]);
      const cached = countCache.get(cacheKey);
      if (cached && now - cached.at < COUNT_CACHE_TTL_MS) {
        counts[key] = cached.value;
        continue;
      }
      const inFlight = countInFlight.get(cacheKey);
      if (inFlight) {
        waits.push(inFlight.then((value) => { counts[key] = value; }, () => { counts[key] = null; }));
        continue;
      }
      misses.push([key, query, cacheKey]);
    }

    if (misses.length > 0 && budgetIsLow(rateBudget)) {
      args.logger?.warn("linear.count_issues_skipped_low_budget", { keys: misses.length, budget: rateBudget });
      for (const [key] of misses) counts[key] = null;
      misses.length = 0;
    }

    if (misses.length > 0) {
      const meter: LinearRequestMeter = { requests: 0, complexity: 0 };
      const startedAt = Date.now();
      const run = countIssuesUncached(Object.fromEntries(misses.map(([key, query]) => [key, query])), cap, meter);
      for (const [key, , cacheKey] of misses) {
        const one = run.then((result) => result[key] ?? null);
        countInFlight.set(cacheKey, one);
        waits.push(one.then(
          (value) => {
            counts[key] = value;
            if (value) countCache.set(cacheKey, { value, at: Date.now() });
          },
          () => { counts[key] = null; },
        ).finally(() => countInFlight.delete(cacheKey)));
      }
      waits.push(run.then(() => {
        args.logger?.info("linear.count_issues", {
          keys: misses.length,
          cap,
          requests: meter.requests,
          complexity: meter.complexity,
          durationMs: Date.now() - startedAt,
          budget: rateBudget,
        });
      }, () => {}));
    }

    await Promise.all(waits);
    while (countCache.size > COUNT_CACHE_MAX) {
      const oldest = countCache.keys().next().value;
      if (oldest === undefined) break;
      countCache.delete(oldest);
    }
    return { counts };
  };

  const countIssuesUncached = async (
    queries: Record<string, IssueTrackerIssueSearchQuery>,
    cap: number,
    meter: LinearRequestMeter,
  ): Promise<CtoCountLinearIssuesResult["counts"]> => {
    const counts: CtoCountLinearIssuesResult["counts"] = {};
    const entries = Object.entries(queries);
    const termItems: Array<{ key: string; term: string; filter: Record<string, unknown> }> = [];
    const pending: PendingCount[] = [];

    await Promise.all(entries.map(async ([key, query]) => {
      try {
        const filter = await resolveIssueFilter(isRecord(query) ? query : {});
        const term = isRecord(query) ? query.query?.trim() : null;
        if (term) termItems.push({ key, term, filter });
        else pending.push({ key, filter, after: null, count: 0 });
      } catch (error) {
        args.logger?.warn("linear.count_issues_filter_failed", { key, error: getErrorMessage(error) });
        counts[key] = null;
      }
    }));

    // A search term is counted by Linear's search index (exact, one request).
    // When search is unavailable, count the fallback title/description filter.
    for (const batch of chunk(termItems, COUNT_ALIAS_BATCH)) {
      const totals = await countSearchTerms(batch, meter);
      for (const item of batch) {
        const total = totals.get(item.key);
        if (typeof total === "number") counts[item.key] = { count: total, capped: false };
        else pending.push({ key: item.key, filter: withLegacyTextFilter(item.filter, item.term), after: null, count: 0 });
      }
    }

    // Linear connections have no total, so page ids (250 per request, batched
    // across keys) until each key runs out or reaches the cap.
    let active = pending;
    while (active.length > 0) {
      const next: PendingCount[] = [];
      const pages = await Promise.all(chunk(active, COUNT_ALIAS_BATCH).map((batch) => fetchCountPages(batch, COUNT_PAGE_SIZE, meter)));
      const merged = new Map<string, CountPage | null>();
      for (const page of pages) for (const [key, value] of page) merged.set(key, value);
      for (const item of active) {
        const page = merged.get(item.key);
        if (!page) {
          counts[item.key] = null;
          continue;
        }
        item.count += page.count;
        if (page.hasNextPage && page.endCursor && item.count < cap) {
          item.after = page.endCursor;
          next.push(item);
        } else {
          counts[item.key] = { count: item.count, capped: page.hasNextPage };
        }
      }
      active = next;
    }
    return counts;
  };

  const listCustomViews = async (): Promise<CtoLinearCustomView[]> => {
    const data = await request<{ customViews?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query CustomViews {
          customViews(first: 50) {
            nodes {
              id
              name
              description
              icon
              color
              shared
              modelName
              filterData
              team { key }
            }
          }
        }
      `,
      maxRetries: 2,
    });
    const candidates = asArray(data.customViews?.nodes)
      .filter(isRecord)
      .filter((node) => asString(node.modelName) === "Issue" && isRecord(node.filterData) && Object.keys(node.filterData).length > 0)
      .map((node) => {
        const id = asString(node.id);
        const name = asString(node.name);
        if (!id || !name) return null;
        const team = isRecord(node.team) ? node.team : null;
        customViewFilterCache.set(id, { filter: node.filterData as Record<string, unknown>, fetchedAt: Date.now() });
        return {
          view: {
            id,
            name,
            description: asString(node.description),
            icon: asString(node.icon),
            color: asString(node.color),
            teamKey: team ? asString(team.key) : null,
            shared: node.shared === true,
          } satisfies CtoLinearCustomView,
          filter: node.filterData as Record<string, unknown>,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
    if (candidates.length === 0) return [];

    // Skip views whose saved filter the public API rejects (some view filters
    // use fields only Linear's own client understands). One probe per view,
    // batched; a rejected batch falls back to per-view probes.
    const probes = await fetchCountPages(candidates.map((entry) => ({
      key: entry.view.id,
      filter: entry.filter,
      after: null,
      count: 0,
    })).slice(0, COUNT_ALIAS_BATCH * 3), 1).catch(() => new Map<string, CountPage | null>());
    return candidates
      .filter((entry) => probes.get(entry.view.id) != null)
      .map((entry) => entry.view)
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  const fetchIssueById = async (issueId: string): Promise<NormalizedLinearIssue | null> => {
    const data = await request<{ issue?: Record<string, unknown> }>({
      query: `
        query IssueById($id: String!) {
          issue(id: $id) {
            ${ISSUE_DETAIL_FIELDS_FRAGMENT}
          }
        }
      `,
      variables: { id: issueId },
      maxRetries: 2,
    });
    return data.issue && isRecord(data.issue) ? toNormalizedIssue(data.issue) : null;
  };

  // One raw query per surface with every field selected inline. The SDK's
  // lazy relations (project.status / lead / teams) cost a request each, which
  // was ~150 requests for 50 projects.
  const fetchQuickViewProjects = async (): Promise<CtoLinearQuickViewProject[]> => {
    const data = await request<{ projects?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query QuickViewProjects {
          projects(first: 50, includeArchived: false) {
            nodes {
              id
              name
              slugId
              url
              color
              icon
              description
              health
              progress
              scope
              priority
              priorityLabel
              startDate
              targetDate
              issueCountHistory
              completedIssueCountHistory
              status { name type }
              lead { id name displayName }
              teams(first: 4) { nodes { key name } }
            }
          }
        }
      `,
      maxRetries: 2,
    });
    return asArray(data.projects?.nodes).filter(isRecord).map((project) => {
      const status = isRecord(project.status) ? project.status : null;
      const lead = isRecord(project.lead) ? project.lead : null;
      const teamNodes = asArray(isRecord(project.teams) ? project.teams.nodes : []).filter(isRecord);
      const teamName = teamNodes
        .map((team) => asString(team.name))
        .find((entry): entry is string => Boolean(entry?.trim())) ?? "Unassigned";
      const teamKey = teamNodes
        .map((team) => asString(team.key))
        .find((entry): entry is string => Boolean(entry?.trim())) ?? null;
      return {
        id: String(project.id ?? ""),
        name: String(project.name ?? "Untitled project"),
        slug: String(project.slugId ?? ""),
        teamName,
        ...(teamKey ? { teamKey } : {}),
        url: asString(project.url),
        color: asString(project.color),
        icon: asString(project.icon),
        description: asString(project.description),
        statusName: status ? asString(status.name) : null,
        statusType: status ? asString(status.type) : null,
        health: asString(project.health),
        progress: typeof project.progress === "number" ? project.progress : null,
        scope: typeof project.scope === "number" ? project.scope : null,
        priority: typeof project.priority === "number" ? project.priority : null,
        priorityLabel: asString(project.priorityLabel),
        // Weekly snapshot, not a live count. Live counts come from countIssues.
        issueCount: Array.isArray(project.issueCountHistory) ? Number(project.issueCountHistory.at(-1) ?? 0) : null,
        completedIssueCount: Array.isArray(project.completedIssueCountHistory)
          ? Number(project.completedIssueCountHistory.at(-1) ?? 0)
          : null,
        startDate: asString(project.startDate),
        targetDate: asString(project.targetDate),
        leadName: lead ? (asString(lead.displayName) ?? asString(lead.name)) : null,
        teamKeys: teamNodes.map((team) => asString(team.key)).filter((entry): entry is string => Boolean(entry)),
      };
    });
  };

  const fetchQuickViewTeams = async (): Promise<CtoLinearQuickViewTeam[]> => {
    const data = await request<{ teams?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query QuickViewTeams {
          teams(first: 8, includeArchived: false) {
            nodes { id key name displayName color issueCount cyclesEnabled private }
          }
        }
      `,
      maxRetries: 2,
    });
    return asArray(data.teams?.nodes).filter(isRecord).map((team) => ({
      id: String(team.id ?? ""),
      key: String(team.key ?? ""),
      name: String(team.name ?? "Team"),
      displayName: String(team.displayName ?? team.name ?? "Team"),
      color: asString(team.color),
      issueCount: typeof team.issueCount === "number" ? team.issueCount : null,
      cyclesEnabled: typeof team.cyclesEnabled === "boolean" ? team.cyclesEnabled : null,
      private: typeof team.private === "boolean" ? team.private : null,
    }));
  };

  const getQuickView = async (connection: CtoLinearQuickView["connection"]): Promise<CtoLinearQuickView> => {
    const [viewerData, organizationData, projects, teams, recentIssuesResult, assignedIssuesResult] = await Promise.all([
      request<{ viewer?: Record<string, unknown> }>({
        query: `query QuickViewViewer { viewer { id name displayName email avatarUrl admin guest url } }`,
        maxRetries: 2,
      }),
      request<{ organization?: Record<string, unknown> }>({
        query: `
          query QuickViewOrganization {
            organization {
              id name urlKey logoUrl gitBranchFormat createdIssueCount
              roadmapEnabled customersEnabled releasesEnabled
            }
          }
        `,
        maxRetries: 1,
      }).catch(() => null),
      fetchQuickViewProjects().catch(() => [] as CtoLinearQuickViewProject[]),
      fetchQuickViewTeams().catch(() => [] as CtoLinearQuickViewTeam[]),
      searchIssues({ first: 12, includeArchived: false }).catch(() => null),
      searchIssues({ first: 12, includeArchived: false, assignedToViewer: true }).catch(() => null),
    ]);
    const viewer = isRecord(viewerData.viewer) ? viewerData.viewer : {};
    const organization = isRecord(organizationData?.organization) ? organizationData.organization : null;

    return {
      connection,
      organization: organization ? {
        id: String(organization.id ?? ""),
        name: String(organization.name ?? "Linear"),
        urlKey: asString(organization.urlKey),
        logoUrl: asString(organization.logoUrl),
        gitBranchFormat: asString(organization.gitBranchFormat),
        createdIssueCount: typeof organization.createdIssueCount === "number" ? organization.createdIssueCount : null,
        roadmapEnabled: typeof organization.roadmapEnabled === "boolean" ? organization.roadmapEnabled : null,
        customersEnabled: typeof organization.customersEnabled === "boolean" ? organization.customersEnabled : null,
        releasesEnabled: typeof organization.releasesEnabled === "boolean" ? organization.releasesEnabled : null,
      } : null,
      viewer: {
        id: String(viewer.id ?? ""),
        name: String(viewer.name ?? viewer.displayName ?? "Linear user"),
        displayName: String(viewer.displayName ?? viewer.name ?? "Linear user"),
        email: asString(viewer.email),
        avatarUrl: asString(viewer.avatarUrl),
        admin: typeof viewer.admin === "boolean" ? viewer.admin : null,
        guest: typeof viewer.guest === "boolean" ? viewer.guest : null,
        url: asString(viewer.url),
      },
      projects: projects.filter((project) => project.id && project.slug),
      teams: teams.filter((team) => team.id && team.key),
      assignedIssues: assignedIssuesResult?.issues ?? [],
      recentIssues: recentIssuesResult?.issues ?? [],
      fetchedAt: new Date().toISOString(),
      sdk: {
        packageName: "@linear/sdk",
        surfaces: [
          "viewer",
          "organization",
          "projects",
          "teams",
          "assignedIssues",
          "issues",
          "project.status",
          "project.lead",
        ],
      },
    };
  };

  const fetchIssuesByIds = async (issueIds: string[]): Promise<Map<string, NormalizedLinearIssue>> => {
    const results = new Map<string, NormalizedLinearIssue>();
    if (!issueIds.length) return results;

    // Batch via filter: id.in — Linear supports up to 50 per page
    const BATCH_SIZE = 50;
    for (let i = 0; i < issueIds.length; i += BATCH_SIZE) {
      const batch = issueIds.slice(i, i + BATCH_SIZE);
      const data = await request<{
        issues?: {
          nodes?: Array<Record<string, unknown>>;
        };
      }>({
        query: `
          query IssuesByIds($ids: [ID!]!) {
            issues(filter: { id: { in: $ids } }, first: ${BATCH_SIZE}) {
              nodes {
                ${ISSUE_FIELDS_FRAGMENT}
              }
            }
          }
        `,
        variables: { ids: batch },
        maxRetries: 2,
      });

      for (const node of asArray(data.issues?.nodes)) {
        if (!isRecord(node)) continue;
        const normalized = toNormalizedIssue(node);
        if (normalized) results.set(normalized.id, normalized);
      }
    }
    return results;
  };

  const fetchWorkflowStates = async (teamKey: string): Promise<Array<{ id: string; name: string; type: string; teamId: string; teamKey: string }>> => {
    const data = await request<{
      teams?: {
        nodes?: Array<{
          id?: string;
          key?: string;
          states?: { nodes?: Array<{ id?: string; name?: string; type?: string }> };
        }>;
      };
    }>({
      query: `
        query TeamStates($teamKey: String!) {
          teams(filter: { key: { eq: $teamKey } }) {
            nodes {
              id
              key
              states {
                nodes {
                  id
                  name
                  type
                }
              }
            }
          }
        }
      `,
      variables: { teamKey },
      maxRetries: 2,
    });

    const team = asArray(data.teams?.nodes)[0];
    if (!isRecord(team)) return [];
    const id = asString(team.id);
    const key = asString(team.key);
    if (!id || !key) return [];
    const states = isRecord(team.states) ? asArray(team.states.nodes) : [];

    return states
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const stateId = asString(entry.id);
        const stateName = asString(entry.name);
        const stateType = asString(entry.type);
        if (!stateId || !stateName || !stateType) return null;
        return { id: stateId, name: stateName, type: stateType, teamId: id, teamKey: key };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  const listWorkflowStates = async (teamKey?: string | null): Promise<LinearCatalogState[]> => {
    if (teamKey?.trim()) {
      return fetchWorkflowStates(teamKey.trim());
    }

    const data = await request<{
      teams?: {
        nodes?: Array<{
          id?: string;
          key?: string;
          states?: { nodes?: Array<{ id?: string; name?: string; type?: string }> };
        }>;
      };
    }>({
      query: `
        query AllTeamStates {
          teams(first: 100) {
            nodes {
              id
              key
              states {
                nodes {
                  id
                  name
                  type
                }
              }
            }
          }
        }
      `,
      maxRetries: 2,
    });

    return asArray(data.teams?.nodes).flatMap((teamNode) => {
      if (!isRecord(teamNode)) return [];
      const id = asString(teamNode.id);
      const key = asString(teamNode.key);
      if (!id || !key) return [];
      const states = isRecord(teamNode.states) ? asArray(teamNode.states.nodes) : [];
      return states
        .map((entry) => {
          if (!isRecord(entry)) return null;
          const stateId = asString(entry.id);
          const stateName = asString(entry.name);
          const stateType = asString(entry.type);
          if (!stateId || !stateName || !stateType) return null;
          return {
            id: stateId,
            name: stateName,
            type: stateType,
            teamId: id,
            teamKey: key,
          };
        })
        .filter((entry): entry is LinearCatalogState => entry != null);
    });
  };

  const updateIssueState = async (issueId: string, stateId: string): Promise<void> => {
    await request({
      query: `
        mutation UpdateIssueState($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
          }
        }
      `,
      variables: { id: issueId, stateId },
      maxRetries: 2,
    });
  };

  const updateIssueAssignee = async (issueId: string, assigneeId: string | null): Promise<void> => {
    await request({
      query: `
        mutation UpdateIssueAssignee($id: String!, $assigneeId: String) {
          issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
            success
          }
        }
      `,
      variables: { id: issueId, assigneeId },
      maxRetries: 2,
    });
  };

  const updateIssue = async (issueId: string, patch: IssueTrackerIssueUpdate): Promise<void> => {
    const input: Record<string, unknown> = {};
    if (typeof patch.stateId === "string" && patch.stateId.trim()) input.stateId = patch.stateId.trim();
    if (patch.assigneeId !== undefined) input.assigneeId = patch.assigneeId?.trim() || null;
    if (priorityIsValid(patch.priority)) input.priority = patch.priority;
    const added = (patch.addedLabelIds ?? []).map((entry) => entry.trim()).filter(Boolean);
    const removed = (patch.removedLabelIds ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (added.length > 0) input.addedLabelIds = added;
    if (removed.length > 0) input.removedLabelIds = removed;
    if (Object.keys(input).length === 0) return;
    const data = await request<{ issueUpdate?: { success?: boolean } }>({
      query: `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      variables: { id: issueId, input },
      maxRetries: 1,
    });
    if (data.issueUpdate?.success === false) throw new Error("Linear did not accept the issue update.");
  };

  const updateIssuePriority = async (issueId: string, priority: number): Promise<void> => {
    if (!priorityIsValid(priority)) throw new Error("Linear priority must be an integer from 0 to 4.");
    await updateIssue(issueId, { priority });
  };

  const createComment = async (issueId: string, body: string): Promise<{ commentId: string }> => {
    const data = await request<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({
      query: `
        mutation CreateIssueComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
            comment { id }
          }
        }
      `,
      variables: { issueId, body },
      maxRetries: 2,
    });
    const commentId = asString(data.commentCreate?.comment?.id);
    if (!commentId) throw new Error("Linear commentCreate did not return a comment id.");
    return { commentId };
  };

  const updateComment = async (commentId: string, body: string): Promise<void> => {
    await request({
      query: `
        mutation UpdateComment($id: String!, $body: String!) {
          commentUpdate(id: $id, input: { body: $body }) {
            success
          }
        }
      `,
      variables: { id: commentId, body },
      maxRetries: 2,
    });
  };

  const resolveTeamId = async (teamKeyOrId: string): Promise<string> => {
    const value = teamKeyOrId.trim();
    if (/^[0-9a-f-]{36}$/i.test(value)) return value;
    const data = await request<{ teams?: { nodes?: Array<{ id?: string; key?: string }> } }>({
      query: `query TeamByKey($key: String!) { teams(first: 1, filter: { key: { eqIgnoreCase: $key } }) { nodes { id key } } }`,
      variables: { key: value },
      maxRetries: 2,
    });
    const teamId = asString(data.teams?.nodes?.[0]?.id);
    if (!teamId) throw new Error(`Linear team "${value}" was not found.`);
    return teamId;
  };

  /** Creates an issue and returns it normalized. `teamKey` accepts a key ("VER") or a team id. */
  const createIssue = async (params: LinearIssueCreateInput): Promise<NormalizedLinearIssue> => {
    const title = params.title.trim();
    if (!title) throw new Error("A Linear issue needs a title.");
    const input: Record<string, unknown> = {
      teamId: await resolveTeamId(params.teamKey),
      title,
    };
    if (params.description?.trim()) input.description = params.description.trim();
    if (params.projectId?.trim()) input.projectId = params.projectId.trim();
    if (params.parentId?.trim()) input.parentId = params.parentId.trim();
    if (params.stateId?.trim()) input.stateId = params.stateId.trim();
    if (params.assigneeId?.trim()) input.assigneeId = params.assigneeId.trim();
    if (priorityIsValid(params.priority)) input.priority = params.priority;
    if (params.labelIds?.length) input.labelIds = params.labelIds;
    const data = await request<{ issueCreate?: { success?: boolean; issue?: Record<string, unknown> } }>({
      query: `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { ${ISSUE_FIELDS_FRAGMENT} }
          }
        }
      `,
      variables: { input },
      maxRetries: 1,
    });
    const issue = isRecord(data.issueCreate?.issue) ? toNormalizedIssue(data.issueCreate.issue) : null;
    if (!data.issueCreate?.success || !issue) throw new Error("Linear issueCreate did not return an issue.");
    return issue;
  };

  /**
   * Links two issues. `blocked_by` is stored by Linear as the inverse `blocks`
   * relation (the other issue blocks this one).
   */
  const createIssueRelation = async (params: {
    issueId: string;
    relatedIssueId: string;
    type: LinearIssueRelationKind;
  }): Promise<{ id: string }> => {
    const [issueId, relatedIssueId, type] = params.type === "blocked_by"
      ? [params.relatedIssueId, params.issueId, "blocks"]
      : [params.issueId, params.relatedIssueId, params.type];
    const data = await request<{ issueRelationCreate?: { success?: boolean; issueRelation?: { id?: string } } }>({
      query: `
        mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) { success issueRelation { id } }
        }
      `,
      variables: { input: { issueId, relatedIssueId, type } },
      maxRetries: 1,
    });
    const id = asString(data.issueRelationCreate?.issueRelation?.id);
    if (!data.issueRelationCreate?.success || !id) throw new Error("Linear issueRelationCreate failed.");
    return { id };
  };

  const listNotifications = async (params?: { first?: number; includeRead?: boolean }): Promise<LinearInboxNotification[]> => {
    const first = Math.min(100, Math.max(1, Math.floor(params?.first ?? 50)));
    const data = await request<{ notifications?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query InboxNotifications($first: Int!) {
          notifications(first: $first, orderBy: createdAt) {
            nodes {
              id
              type
              createdAt
              readAt
              snoozedUntilAt
              archivedAt
              title
              subtitle
              url
              actorAvatarUrl
              actorInitials
              isLinearActor
              actor { id name displayName avatarUrl }
              botActor { name }
              ... on IssueNotification {
                issue { id identifier title url state { name type } }
                comment { id body }
              }
            }
          }
        }
      `,
      variables: { first },
      maxRetries: 2,
    });
    return asArray(data.notifications?.nodes)
      .filter(isRecord)
      .map((node): LinearInboxNotification | null => {
        const id = asString(node.id);
        const type = asString(node.type);
        if (!id || !type) return null;
        const issue = isRecord(node.issue) ? node.issue : null;
        const state = issue && isRecord(issue.state) ? issue.state : null;
        const actor = isRecord(node.actor) ? node.actor : null;
        const botActor = isRecord(node.botActor) ? node.botActor : null;
        const comment = isRecord(node.comment) ? node.comment : null;
        return {
          id,
          type,
          createdAt: asString(node.createdAt) ?? new Date().toISOString(),
          readAt: asString(node.readAt),
          snoozedUntilAt: asString(node.snoozedUntilAt),
          actorName: (actor ? (asString(actor.displayName) ?? asString(actor.name)) : null)
            ?? (botActor ? asString(botActor.name) : null)
            ?? (node.isLinearActor === true ? "Linear" : null),
          actorAvatarUrl: asString(node.actorAvatarUrl) ?? (actor ? asString(actor.avatarUrl) : null),
          actorInitials: asString(node.actorInitials),
          title: asString(node.title),
          subtitle: asString(node.subtitle),
          url: asString(node.url),
          issueId: issue ? asString(issue.id) : null,
          issueIdentifier: issue ? asString(issue.identifier) : null,
          issueTitle: issue ? asString(issue.title) : null,
          issueUrl: issue ? asString(issue.url) : null,
          issueStateName: state ? asString(state.name) : null,
          issueStateType: state ? asString(state.type) : null,
          commentId: comment ? asString(comment.id) : null,
          commentBody: comment ? asString(comment.body) : null,
        };
      })
      .filter((entry): entry is LinearInboxNotification => entry != null)
      .filter((entry) => params?.includeRead === true || !entry.readAt);
  };

  const markNotification = async (notificationId: string, action: "read" | "archive"): Promise<void> => {
    await request({
      query: action === "archive"
        ? `mutation ArchiveNotification($id: String!) { notificationArchive(id: $id) { success } }`
        : `mutation ReadNotification($id: String!, $readAt: DateTime!) { notificationUpdate(id: $id, input: { readAt: $readAt }) { success } }`,
      variables: action === "archive" ? { id: notificationId } : { id: notificationId, readAt: new Date().toISOString() },
      maxRetries: 1,
    });
  };

  const createProjectUpdate = async (params: {
    projectId: string;
    body: string;
    health?: "onTrack" | "atRisk" | "offTrack" | null;
  }): Promise<{ id: string; url: string | null }> => {
    const input: Record<string, unknown> = { projectId: params.projectId, body: params.body };
    if (params.health) input.health = params.health;
    const data = await request<{ projectUpdateCreate?: { success?: boolean; projectUpdate?: { id?: string; url?: string } } }>({
      query: `
        mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
          projectUpdateCreate(input: $input) { success projectUpdate { id url } }
        }
      `,
      variables: { input },
      maxRetries: 1,
    });
    const id = asString(data.projectUpdateCreate?.projectUpdate?.id);
    if (!data.projectUpdateCreate?.success || !id) throw new Error("Linear projectUpdateCreate failed.");
    return { id, url: asString(data.projectUpdateCreate?.projectUpdate?.url) };
  };

  const addLabel = async (issueId: string, labelName: string): Promise<void> => {
    const trimmed = labelName.trim();
    if (!trimmed.length) return;

    try {
      const labelsData = await request<{ issueLabels?: { nodes?: Array<{ id?: string; name?: string }> } }>({
        query: `
          query IssueLabels($name: String!) {
            issueLabels(filter: { name: { eq: $name } }, first: 5) {
              nodes { id name }
            }
          }
        `,
        variables: { name: trimmed },
        maxRetries: 1,
      });
      const labelId = asArray(labelsData.issueLabels?.nodes)
        .map((node) => (isRecord(node) ? { id: asString(node.id), name: asString(node.name) } : null))
        .find((entry) => entry?.id && entry.name?.toLowerCase() === trimmed.toLowerCase())?.id;
      if (!labelId) return;

      await request({
        query: `
          mutation AddIssueLabel($id: String!, $addedLabelIds: [String!]) {
            issueUpdate(id: $id, input: { addedLabelIds: $addedLabelIds }) {
              success
            }
          }
        `,
        variables: { id: issueId, addedLabelIds: [labelId] },
        maxRetries: 1,
      });
    } catch (error) {
      args.logger?.warn("linear_sync.add_label_failed", {
        issueId,
        labelName: trimmed,
        error: getErrorMessage(error),
      });
    }
  };

  // Add/remove a label by its known label id (no name lookup). The CLI daemon
  // bridge resolves a label id from `listLabels` first, then calls these — the
  // name-based `addLabel` above is for callers that only have a label name.
  const addIssueLabel = async (issueId: string, labelId: string): Promise<void> => {
    const trimmed = labelId.trim();
    if (!trimmed.length) return;
    await request({
      query: `
        mutation AddIssueLabel($id: String!, $addedLabelIds: [String!]) {
          issueUpdate(id: $id, input: { addedLabelIds: $addedLabelIds }) {
            success
          }
        }
      `,
      variables: { id: issueId, addedLabelIds: [trimmed] },
      maxRetries: 1,
    });
  };

  const removeIssueLabel = async (issueId: string, labelId: string): Promise<void> => {
    const trimmed = labelId.trim();
    if (!trimmed.length) return;
    await request({
      query: `
        mutation RemoveIssueLabel($id: String!, $removedLabelIds: [String!]) {
          issueUpdate(id: $id, input: { removedLabelIds: $removedLabelIds }) {
            success
          }
        }
      `,
      variables: { id: issueId, removedLabelIds: [trimmed] },
      maxRetries: 1,
    });
  };

  const uploadAttachment = async (params: { issueId: string; filePath: string; title?: string }): Promise<{ url: string; id?: string }> => {
    const absPath = path.resolve(params.filePath);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error(`Attachment file is not a regular file: ${absPath}`);
    const size = stat.size;
    if (size > 50 * 1024 * 1024) {
      throw new Error(`Attachment file exceeds 50MB limit: ${absPath}`);
    }

    const filename = path.basename(absPath);
    const ext = path.extname(filename).toLowerCase();
    const CONTENT_TYPE_MAP: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".mp4": "video/mp4",
    };
    const contentType = CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";

    const uploadInit = await request<{
      fileUpload?: {
        uploadUrl?: string;
        assetUrl?: string;
        headers?: Array<{ key?: string; value?: string }>;
      };
    }>({
      query: `
        mutation RequestFileUpload($filename: String!, $size: Float!, $contentType: String!) {
          fileUpload(input: { filename: $filename, size: $size, contentType: $contentType }) {
            uploadUrl
            assetUrl
            headers { key value }
          }
        }
      `,
      variables: {
        filename,
        size,
        contentType,
      },
      maxRetries: 1,
    });

    const uploadUrl = asString(uploadInit.fileUpload?.uploadUrl);
    const assetUrl = asString(uploadInit.fileUpload?.assetUrl);
    if (!uploadUrl || !assetUrl) {
      throw new Error("Linear fileUpload did not return uploadUrl/assetUrl.");
    }

    const headerMap: Record<string, string> = {};
    for (const header of asArray(uploadInit.fileUpload?.headers)) {
      if (!isRecord(header)) continue;
      const key = asString(header.key);
      const value = asString(header.value);
      if (!key || !value) continue;
      headerMap[key] = value;
    }

    const bytes = fs.readFileSync(absPath);
    const uploadRes = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        ...headerMap,
      },
      body: bytes,
    });
    if (!uploadRes.ok) {
      throw new Error(`Linear file upload failed (HTTP ${uploadRes.status}).`);
    }

    const attachment = await request<{
      attachmentCreate?: {
        success?: boolean;
        attachment?: { id?: string; url?: string };
      };
    }>({
      query: `
        mutation CreateAttachment($issueId: String!, $title: String!, $url: String!) {
          attachmentCreate(input: { issueId: $issueId, title: $title, url: $url }) {
            success
            attachment { id url }
          }
        }
      `,
      variables: {
        issueId: params.issueId,
        title: asString(params.title) ?? filename,
        url: assetUrl,
      },
      maxRetries: 1,
    });

    return {
      url: asString(attachment.attachmentCreate?.attachment?.url) ?? assetUrl,
      id: asString(attachment.attachmentCreate?.attachment?.id) ?? undefined,
    };
  };

  const createIssueAttachment = async (params: IssueTrackerIssueAttachmentInput): Promise<{ url: string; id?: string }> => {
    const subtitle = params.subtitle?.trim() ? params.subtitle.trim() : null;
    const iconUrl = params.iconUrl?.trim() ? params.iconUrl.trim() : null;
    const attachment = await request<{
      attachmentCreate?: {
        success?: boolean;
        attachment?: { id?: string; url?: string };
      };
    }>({
      query: `
        mutation CreateIssueAttachment(
          $issueId: String!,
          $title: String!,
          $url: String!,
          $subtitle: String,
          $iconUrl: String,
          $metadata: JSONObject
        ) {
          attachmentCreate(input: {
            issueId: $issueId,
            title: $title,
            url: $url,
            subtitle: $subtitle,
            iconUrl: $iconUrl,
            metadata: $metadata
          }) {
            success
            attachment { id url }
          }
        }
      `,
      variables: {
        issueId: params.issueId,
        title: params.title,
        url: params.url,
        subtitle,
        iconUrl,
        metadata: params.metadata ?? null,
      },
      maxRetries: 1,
    });

    const created = attachment.attachmentCreate;
    const createdUrl = asString(created?.attachment?.url);
    const createdId = asString(created?.attachment?.id);
    if (created?.success === false || !createdUrl) {
      throw new Error("linear: attachmentCreate did not return a created attachment");
    }

    return {
      url: createdUrl,
      id: createdId ?? undefined,
    };
  };

  const listWebhooks = async (): Promise<LinearWebhookSummary[]> => {
    const data = await request<{
      webhooks?: {
        nodes?: Array<Record<string, unknown>>;
      };
    }>({
      query: `
        query Webhooks {
          webhooks(first: 100) {
            nodes {
              id
              url
              enabled
              label
              resourceTypes
              allPublicTeams
            }
          }
        }
      `,
      maxRetries: 1,
    });

    return asArray(data.webhooks?.nodes)
      .map((node) => {
        if (!isRecord(node)) return null;
        const id = asString(node.id);
        const url = asString(node.url);
        if (!id || !url) return null;
        return {
          id,
          url,
          enabled: node.enabled !== false,
          label: asString(node.label),
          resourceTypes: asArray(node.resourceTypes).map((entry) => String(entry)).filter(Boolean),
          allPublicTeams: node.allPublicTeams === true,
        };
      })
      .filter((entry): entry is LinearWebhookSummary => entry != null);
  };

  const createWebhook = async (params: {
    url: string;
    secret: string;
    label?: string;
    resourceTypes?: string[];
    allPublicTeams?: boolean;
  }): Promise<LinearWebhookSummary> => {
    const data = await request<{
      webhookCreate?: {
        success?: boolean;
        webhook?: Record<string, unknown>;
      };
    }>({
      query: `
        mutation CreateWebhook(
          $url: String!,
          $secret: String!,
          $label: String!,
          $resourceTypes: [String!]!,
          $allPublicTeams: Boolean!
        ) {
          webhookCreate(input: {
            url: $url,
            secret: $secret,
            label: $label,
            resourceTypes: $resourceTypes,
            allPublicTeams: $allPublicTeams
          }) {
            success
            webhook {
              id
              url
              enabled
              label
              resourceTypes
              allPublicTeams
            }
          }
        }
      `,
      variables: {
        url: params.url,
        secret: params.secret,
        label: params.label?.trim() || "ADE workflow ingress",
        resourceTypes: params.resourceTypes?.length ? params.resourceTypes : ["Issue", "IssueLabel"],
        allPublicTeams: params.allPublicTeams !== false,
      },
      maxRetries: 1,
    });

    const webhook = data.webhookCreate?.webhook;
    if (!webhook || !isRecord(webhook)) {
      throw new Error("Linear webhookCreate did not return a webhook.");
    }
    const id = asString(webhook.id);
    const url = asString(webhook.url);
    if (!id || !url) {
      throw new Error("Linear webhookCreate returned an invalid webhook.");
    }
    return {
      id,
      url,
      enabled: webhook.enabled !== false,
      label: asString(webhook.label),
      resourceTypes: asArray(webhook.resourceTypes).map((entry) => String(entry)).filter(Boolean),
      allPublicTeams: webhook.allPublicTeams === true,
    };
  };

  const deleteWebhook = async (webhookId: string): Promise<void> => {
    const id = webhookId.trim();
    if (!id) throw new Error("Linear webhook id is required.");
    const data = await request<{
      webhookDelete?: {
        success?: boolean;
      };
    }>({
      query: `
        mutation DeleteWebhook($id: String!) {
          webhookDelete(id: $id) {
            success
          }
        }
      `,
      variables: { id },
      maxRetries: 1,
    });
    if (data.webhookDelete?.success !== true) {
      throw new Error("Linear webhookDelete did not report success.");
    }
  };

  const fetchIssueComments = async (issueId: string): Promise<Array<{
    id: string;
    body: string;
    createdAt: string;
    userName: string;
    userDisplayName: string;
  }>> => {
    const data = await request<{
      issue?: {
        comments?: {
          nodes?: Array<Record<string, unknown>>;
        };
      };
    }>({
      query: `
        query IssueComments($issueId: String!) {
          issue(id: $issueId) {
            comments(first: 50, orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                user {
                  id
                  name
                  displayName
                }
              }
            }
          }
        }
      `,
      variables: { issueId },
      maxRetries: 2,
    });

    const nodes = isRecord(data.issue) && isRecord(data.issue.comments)
      ? asArray(data.issue.comments.nodes)
      : [];

    return nodes
      .map((node) => {
        if (!isRecord(node)) return null;
        const id = asString(node.id);
        const body = asString(node.body);
        const createdAt = asString(node.createdAt);
        if (!id || !body || !createdAt) return null;
        const user = isRecord(node.user) ? node.user : null;
        return {
          id,
          body,
          createdAt,
          userName: user ? asString(user.name) ?? "" : "",
          userDisplayName: user ? asString(user.displayName) ?? asString(user.name) ?? "" : "",
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  return {
    request,
    runGraphQL,
    getViewer,
    getConnectionIdentity,
    listProjects,
    listUsers,
    listLabels,
    listWebhooks,
    createWebhook,
    deleteWebhook,
    searchIssues,
    countIssues,
    listCustomViews,
    fetchCandidateIssues,
    fetchIssueById,
    fetchIssuesByIds,
    getQuickView,
    fetchWorkflowStates,
    listWorkflowStates,
    updateIssueState,
    updateIssueAssignee,
    updateIssuePriority,
    updateIssue,
    createComment,
    updateComment,
    addLabel,
    addIssueLabel,
    removeIssueLabel,
    uploadAttachment,
    createIssueAttachment,
    fetchIssueComments,
    createIssue,
    createIssueRelation,
    listNotifications,
    markNotification,
    createProjectUpdate,
  };
}

export type LinearClient = ReturnType<typeof createLinearClient>;
