import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type { CtoLinearProject, LinearPriorityLabel, NormalizedLinearIssue } from "../../../shared/types";
import type { LinearCredentialService } from "./linearCredentialService";
import { isRecord, toOptionalString as asString, asArray, sleep, getErrorMessage } from "../shared/utils";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

function mapPriorityLabel(priority: number): LinearPriorityLabel {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "normal";
  if (priority === 4) return "low";
  return "none";
}

function toBearerToken(token: string): string {
  const trimmed = token.trim();
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function toNormalizedIssue(node: Record<string, unknown>): NormalizedLinearIssue | null {
  const id = asString(node.id);
  const identifier = asString(node.identifier);
  const title = asString(node.title);
  if (!id || !identifier || !title) return null;

  const project = isRecord(node.project) ? node.project : null;
  const team = isRecord(node.team) ? node.team : null;
  const state = isRecord(node.state) ? node.state : null;
  if (!project || !team || !state) return null;

  const projectId = asString(project.id);
  const projectSlug = asString(project.slug);
  const teamId = asString(team.id);
  const teamKey = asString(team.key);
  const stateId = asString(state.id);
  const stateName = asString(state.name);
  const stateType = asString(state.type);
  if (!projectId || !projectSlug || !teamId || !teamKey || !stateId || !stateName || !stateType) return null;

  const labelsNodes = isRecord(node.labels) ? asArray(node.labels.nodes) : [];
  const labels = labelsNodes
    .map((entry) => (isRecord(entry) ? asString(entry.name) : null))
    .filter((entry): entry is string => entry != null)
    .map((entry) => entry.toLowerCase());

  const blockersNodes = isRecord(node.children) ? asArray(node.children.nodes) : [];
  const blockerIssueIds = blockersNodes
    .map((entry) => (isRecord(entry) ? asString(entry.id) : null))
    .filter((entry): entry is string => entry != null);

  const hasOpenBlockers = blockersNodes.some((entry) => {
    if (!isRecord(entry)) return false;
    const childState = isRecord(entry.state) ? asString(entry.state.type) : null;
    return childState != null && childState !== "completed" && childState !== "canceled";
  });

  const assignee = isRecord(node.assignee) ? node.assignee : null;
  const owner = isRecord(node.creator) ? node.creator : null;
  const metadata = isRecord(node.metadata) ? node.metadata : null;
  const priority = Number(node.priority ?? 0);

  return {
    id,
    identifier,
    title,
    description: asString(node.description) ?? "",
    url: asString(node.url),
    projectId,
    projectSlug,
    teamId,
    teamKey,
    stateId,
    stateName,
    stateType,
    priority: Number.isFinite(priority) ? priority : 0,
    priorityLabel: mapPriorityLabel(Number.isFinite(priority) ? priority : 0),
    labels,
    metadataTags: asArray(metadata?.tags)
      .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
      .filter((entry) => entry.length > 0),
    assigneeId: assignee ? asString(assignee.id) : null,
    assigneeName: assignee ? (asString(assignee.displayName) ?? asString(assignee.name)) : null,
    ownerId: owner ? asString(owner.id) : null,
    creatorId: owner ? asString(owner.id) : null,
    creatorName: owner ? (asString(owner.displayName) ?? asString(owner.name)) : null,
    blockerIssueIds,
    hasOpenBlockers,
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

export function createLinearClient(args: LinearClientArgs) {
  const fetchImpl = args.fetchImpl ?? fetch;

  const request = async <TData = Record<string, unknown>>(params: {
    query: string;
    variables?: Record<string, unknown>;
    maxRetries?: number;
  }): Promise<TData> => {
    const token = toBearerToken(args.credentials.getTokenOrThrow());
    const maxRetries = Math.max(0, Math.floor(params.maxRetries ?? 3));
    let attempt = 0;
    let backoffMs = 500;

    while (true) {
      attempt += 1;
      try {
        const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: token,
          },
          body: JSON.stringify({ query: params.query, variables: params.variables ?? {} }),
        });

        const payload = await res.json().catch(() => ({})) as {
          data?: TData;
          errors?: Array<{ message?: string; extensions?: { code?: string } }>;
        };

        const message = payload.errors?.[0]?.message ?? null;
        const errorCode = payload.errors?.[0]?.extensions?.code ?? null;
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
      } catch (error) {
        if (attempt > maxRetries) throw error;
        await sleep(backoffMs);
        backoffMs = Math.min(15_000, Math.floor(backoffMs * 2));
      }
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

  const listProjects = async (): Promise<CtoLinearProject[]> => {
    const data = await request<{
      projects?: {
        nodes?: Array<Record<string, unknown>>;
      };
    }>({
      query: `
        query Projects {
          projects(first: 100) {
            nodes {
              id
              name
              slug
              teams {
                nodes {
                  name
                }
              }
            }
          }
        }
      `,
      maxRetries: 2,
    });

    return asArray(data.projects?.nodes)
      .map((node) => {
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
        return { id, name, slug, teamName };
      })
      .filter((entry): entry is CtoLinearProject => entry != null)
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  const ISSUE_FIELDS_FRAGMENT = `
    id
    identifier
    title
    description
    url
    priority
    createdAt
    updatedAt
    project { id slug }
    team { id key }
    state { id name type }
    assignee { id name displayName }
    creator { id name displayName }
    metadata
    labels { nodes { id name } }
    children {
      nodes {
        id
        state { type }
      }
    }
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
              project: { slug: { eq: $projectSlug } },
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
            ${ISSUE_FIELDS_FRAGMENT}
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
          mutation AddIssueLabel($id: String!, $labelIds: [String!]) {
            issueUpdate(id: $id, input: { labelIds: $labelIds }) {
              success
            }
          }
        `,
        variables: { id: issueId, labelIds: [labelId] },
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

  return {
    request,
    getViewer,
    listProjects,
    fetchCandidateIssues,
    fetchIssueById,
    fetchIssuesByIds,
    fetchWorkflowStates,
    updateIssueState,
    updateIssueAssignee,
    createComment,
    updateComment,
    addLabel,
    uploadAttachment,
  };
}

export type LinearClient = ReturnType<typeof createLinearClient>;
