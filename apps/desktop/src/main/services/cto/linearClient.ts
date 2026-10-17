import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type {
  LinearIssueCreateInput,
  LinearIssueCreateOptions,
  LinearProjectMilestone,
  LinearUploadResult,
  LinearIssueRelationKind,
  CtoLinearProject,
  LinearCatalogLabel,
  LinearCatalogState,
  LinearCatalogUser,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { LinearCredentialService } from "./linearCredentialService";
import type {
  IssueTrackerIssueAttachmentInput,
  IssueTrackerIssueUpdate,
} from "./issueTracker";
import { isRecord, toOptionalString as asString, asArray, sleep, getErrorMessage } from "../shared/utils";
import {
  ISSUE_DETAIL_FIELDS_FRAGMENT,
  ISSUE_FIELDS_FRAGMENT,
  type LinearRateBudget,
  type LinearRequestMeter,
  priorityIsValid,
  toNormalizedIssue,
} from "./linearClientShared";
import { createLinearIssueSearch } from "./linearIssueSearch";
import { createLinearQuickView } from "./linearQuickView";
import { createLinearInbox } from "./linearInbox";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const MAX_LINEAR_ID_LENGTH = 128;
// Linear's own limits are generous; these bound what an IPC caller can send.
const MAX_LINEAR_TITLE_LENGTH = 512;
const MAX_LINEAR_DESCRIPTION_LENGTH = 200_000;
const MAX_LABEL_IDS_PER_UPDATE = 50;

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

  const issueSearch = createLinearIssueSearch({ request, logger: args.logger, getRateBudget: () => rateBudget });
  const quickView = createLinearQuickView({ request, searchIssues: issueSearch.searchIssues });
  const inbox = createLinearInbox({ request });

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
    // The patch can come straight from IPC; keep only well-formed ids.
    if (patch.assigneeId === null) input.assigneeId = null;
    else if (typeof patch.assigneeId === "string") input.assigneeId = patch.assigneeId.trim().slice(0, MAX_LINEAR_ID_LENGTH) || null;
    if (priorityIsValid(patch.priority)) input.priority = patch.priority;
    const readIds = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0 && entry.length <= MAX_LINEAR_ID_LENGTH)
          .slice(0, MAX_LABEL_IDS_PER_UPDATE)
        : [];
    const added = readIds(patch.addedLabelIds);
    const removed = readIds(patch.removedLabelIds);
    if (added.length > 0) input.addedLabelIds = added;
    if (removed.length > 0) input.removedLabelIds = removed;
    if (typeof patch.title === "string" && patch.title.trim()) input.title = patch.title.trim().slice(0, MAX_LINEAR_TITLE_LENGTH);
    if (typeof patch.description === "string") input.description = patch.description.slice(0, MAX_LINEAR_DESCRIPTION_LENGTH);
    // Clearable ids: `null` clears, a well-formed id sets, anything else is ignored.
    for (const key of ["projectId", "projectMilestoneId", "cycleId", "parentId"] as const) {
      const value = patch[key];
      if (value === null) input[key] = null;
      else if (typeof value === "string" && value.trim() && value.trim().length <= MAX_LINEAR_ID_LENGTH) input[key] = value.trim();
    }
    if (patch.estimate === null) input.estimate = null;
    else if (typeof patch.estimate === "number" && Number.isFinite(patch.estimate) && patch.estimate >= 0) input.estimate = patch.estimate;
    if (patch.dueDate === null) input.dueDate = null;
    else if (typeof patch.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate.trim())) input.dueDate = patch.dueDate.trim();
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

  /**
   * What the create form needs from one team: whether it uses cycles and
   * estimates (and on which scale), its current and upcoming cycles, and its
   * issue templates. One query, read when the form picks a team.
   */
  const getIssueCreateOptions = async (teamKeyOrId: string): Promise<LinearIssueCreateOptions> => {
    const teamId = await resolveTeamId(teamKeyOrId);
    const data = await request<{ team?: Record<string, unknown> }>({
      query: `
        query IssueCreateOptions($id: String!, $now: DateTimeOrDuration!) {
          team(id: $id) {
            id key cyclesEnabled issueEstimationType issueEstimationAllowZero issueEstimationExtended
            activeCycle { id }
            cycles(first: 8, filter: { endsAt: { gt: $now } }, orderBy: createdAt) {
              nodes { id number name startsAt endsAt }
            }
            templates(first: 50) { nodes { id name description type templateData } }
          }
        }
      `,
      variables: { id: teamId, now: new Date().toISOString() },
      maxRetries: 2,
    });
    const team = isRecord(data.team) ? data.team : null;
    if (!team) throw new Error(`Linear team "${teamKeyOrId}" was not found.`);
    const activeCycleId = isRecord(team.activeCycle) ? asString(team.activeCycle.id) : null;
    const cycles = (isRecord(team.cycles) ? asArray(team.cycles.nodes) : [])
      .filter(isRecord)
      .map((cycle) => ({
        id: asString(cycle.id) ?? "",
        number: typeof cycle.number === "number" ? cycle.number : 0,
        name: asString(cycle.name) ?? null,
        startsAt: asString(cycle.startsAt) ?? "",
        endsAt: asString(cycle.endsAt) ?? "",
        active: asString(cycle.id) === activeCycleId,
      }))
      .filter((cycle) => cycle.id)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const templates = (isRecord(team.templates) ? asArray(team.templates.nodes) : [])
      .filter(isRecord)
      .filter((template) => asString(template.type) === "issue")
      .map((template) => {
        const templateData = isRecord(template.templateData) ? template.templateData : {};
        return {
          id: asString(template.id) ?? "",
          name: asString(template.name) ?? "Template",
          description: asString(template.description) ?? null,
          title: asString(templateData.title) ?? null,
          priority: typeof templateData.priority === "number" ? templateData.priority : null,
          labelIds: asArray(templateData.labelIds).filter((id): id is string => typeof id === "string"),
        };
      })
      .filter((template) => template.id);
    return {
      teamId,
      teamKey: asString(team.key) ?? teamKeyOrId,
      cyclesEnabled: team.cyclesEnabled === true,
      estimationType: asString(team.issueEstimationType) ?? "notUsed",
      estimationAllowZero: team.issueEstimationAllowZero === true,
      estimationExtended: team.issueEstimationExtended === true,
      cycles,
      templates,
    };
  };

  const listProjectMilestones = async (projectId: string): Promise<LinearProjectMilestone[]> => {
    const data = await request<{ project?: { projectMilestones?: { nodes?: unknown[] } } }>({
      query: `
        query ProjectMilestones($id: String!) {
          project(id: $id) { projectMilestones(first: 50) { nodes { id name targetDate } } }
        }
      `,
      variables: { id: projectId.trim() },
      maxRetries: 2,
    });
    return asArray(data.project?.projectMilestones?.nodes)
      .filter(isRecord)
      .map((milestone) => ({
        id: asString(milestone.id) ?? "",
        name: asString(milestone.name) ?? "Milestone",
        targetDate: asString(milestone.targetDate) ?? null,
      }))
      .filter((milestone) => milestone.id);
  };

  /**
   * Put one file on Linear's storage and return the asset URL to use in
   * markdown. `fileUpload` takes its arguments directly (no input object) with
   * an integer size; the signed URL then takes a PUT with the returned headers.
   */
  const uploadFileBytes = async (params: { filename: string; contentType: string; bytes: Uint8Array }): Promise<LinearUploadResult> => {
    const size = params.bytes.byteLength;
    if (size > 50 * 1024 * 1024) throw new Error(`${params.filename} is over Linear's 50 MB upload limit.`);
    const data = await request<{
      fileUpload?: {
        success?: boolean;
        uploadFile?: { uploadUrl?: string; assetUrl?: string; headers?: Array<{ key?: string; value?: string }> };
      };
    }>({
      query: `
        mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
          fileUpload(contentType: $contentType, filename: $filename, size: $size) {
            success
            uploadFile { uploadUrl assetUrl headers { key value } }
          }
        }
      `,
      variables: { contentType: params.contentType, filename: params.filename, size },
      maxRetries: 1,
    });
    const uploadFile = data.fileUpload?.uploadFile;
    const uploadUrl = asString(uploadFile?.uploadUrl);
    const assetUrl = asString(uploadFile?.assetUrl);
    if (!uploadUrl || !assetUrl) throw new Error("Linear did not return an upload URL.");
    const headers: Record<string, string> = {
      "content-type": params.contentType,
      "cache-control": "public, max-age=31536000",
    };
    for (const header of asArray(uploadFile?.headers)) {
      if (!isRecord(header)) continue;
      const key = asString(header.key);
      const value = asString(header.value);
      if (key && value) headers[key] = value;
    }
    const response = await fetchImpl(uploadUrl, { method: "PUT", headers, body: Buffer.from(params.bytes) });
    if (!response.ok) throw new Error(`Linear file upload failed (HTTP ${response.status}).`);
    return { assetUrl, filename: params.filename, contentType: params.contentType };
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
    if (params.projectMilestoneId?.trim()) input.projectMilestoneId = params.projectMilestoneId.trim();
    if (params.cycleId?.trim()) input.cycleId = params.cycleId.trim();
    if (typeof params.estimate === "number" && Number.isFinite(params.estimate) && params.estimate >= 0) {
      input.estimate = params.estimate;
    }
    if (params.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate.trim())) input.dueDate = params.dueDate.trim();
    if (params.templateId?.trim()) input.templateId = params.templateId.trim();
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

    const { assetUrl } = await uploadFileBytes({
      filename,
      contentType,
      bytes: new Uint8Array(fs.readFileSync(absPath)),
    });

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
    userAvatarUrl: string | null;
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
                  avatarUrl
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
          userAvatarUrl: user ? asString(user.avatarUrl) ?? null : null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  return {
    ...issueSearch,
    ...quickView,
    ...inbox,
    request,
    runGraphQL,
    getViewer,
    getConnectionIdentity,
    getIssueCreateOptions,
    listProjectMilestones,
    uploadFileBytes,
    listProjects,
    listUsers,
    listLabels,
    listWebhooks,
    createWebhook,
    deleteWebhook,
    fetchCandidateIssues,
    fetchIssueById,
    fetchIssuesByIds,
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
  };
}

export type LinearClient = ReturnType<typeof createLinearClient>;
