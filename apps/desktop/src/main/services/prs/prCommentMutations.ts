import { randomUUID } from "node:crypto";

import type {
  GitHubRepoRef,
  PrComment,
  PrReactionContent,
  PrReviewThreadReaction,
} from "../../../shared/types";
import { asString, isRecord } from "../shared/utils";

type GithubCommentPayload = Record<string, unknown>;
export type GithubCommentSource = PrComment["source"];
type GithubCommentEndpoint = {
  apiPath: (repo: GitHubRepoRef, commentId: number) => string;
  expectedPrUrlSuffix: (prNumber: number) => string;
  parentPrUrl: (payload: GithubCommentPayload) => string;
  filePath: (payload: GithubCommentPayload) => string | null;
  line: (payload: GithubCommentPayload) => number | null;
};

type GithubCommentApi = {
  apiRequest: <T>(args: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    repo?: GitHubRepoRef;
  }) => Promise<{ data: T }>;
};

export function reactionToGraphqlEnum(content: PrReactionContent): string {
  switch (content) {
    case "+1": return "THUMBS_UP";
    case "-1": return "THUMBS_DOWN";
    case "laugh": return "LAUGH";
    case "confused": return "CONFUSED";
    case "heart": return "HEART";
    case "hooray": return "HOORAY";
    case "rocket": return "ROCKET";
    case "eyes": return "EYES";
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

const REACTION_CONTENT_ALIASES: Record<string, PrReactionContent> = {
  "+1": "+1",
  thumbs_up: "+1",
  "-1": "-1",
  thumbs_down: "-1",
  laugh: "laugh",
  confused: "confused",
  heart: "heart",
  hooray: "hooray",
  rocket: "rocket",
  eyes: "eyes",
};
const REST_REACTION_CONTENTS: readonly PrReactionContent[] = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
];

function normalizeReactionContent(raw: unknown): PrReactionContent | null {
  const value = asString(raw).trim().toLowerCase();
  return REACTION_CONTENT_ALIASES[value] ?? null;
}

export function toPrReactions(raw: unknown): PrReviewThreadReaction[] {
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.nodes)
      ? raw.nodes
      : null;
  if (entries) {
    return entries.flatMap((entry): PrReviewThreadReaction[] => {
      if (!isRecord(entry)) return [];
      const content = normalizeReactionContent(entry.content);
      if (!content) return [];
      const user = isRecord(entry.user)
        ? entry.user
        : isRecord(entry.actor)
          ? entry.actor
          : null;
      return [{
        id: asString(entry.id) || randomUUID(),
        content,
        user: asString(user?.login) || "unknown",
      }];
    });
  }

  if (!isRecord(raw)) return [];
  return REST_REACTION_CONTENTS.flatMap((content): PrReviewThreadReaction[] => {
    const count = Number(raw[content]);
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    return [{ id: `rest:${content}`, content, user: "unknown", count }];
  });
}

const GITHUB_COMMENT_ENDPOINTS: Record<GithubCommentSource, GithubCommentEndpoint> = {
  issue: {
    apiPath: (repo, commentId) => `/repos/${repo.owner}/${repo.name}/issues/comments/${commentId}`,
    expectedPrUrlSuffix: (prNumber) => `/issues/${prNumber}`,
    parentPrUrl: (payload) => asString(payload.issue_url),
    filePath: () => null,
    line: () => null,
  },
  review: {
    apiPath: (repo, commentId) => `/repos/${repo.owner}/${repo.name}/pulls/comments/${commentId}`,
    expectedPrUrlSuffix: (prNumber) => `/pulls/${prNumber}`,
    parentPrUrl: (payload) => asString(payload.pull_request_url) || asString(payload.issue_url),
    filePath: (payload) => asString(payload.path) || null,
    line: (payload) => {
      if (payload.line == null || !Number.isFinite(Number(payload.line))) return null;
      return Number(payload.line);
    },
  },
};

function positiveGithubId(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function toPrComment(
  source: GithubCommentSource,
  payload: unknown,
  idOverride?: string | null,
): PrComment {
  const record: GithubCommentPayload = isRecord(payload) ? payload : {};
  const user = isRecord(record.user) ? record.user : null;
  const nodeId = asString(record.node_id) || null;
  const githubId = positiveGithubId(record.id);
  const id = idOverride?.trim()
    || nodeId
    || (githubId == null ? null : String(githubId))
    || randomUUID();
  const endpoint = GITHUB_COMMENT_ENDPOINTS[source];
  return {
    id,
    author: asString(user?.login) || "unknown",
    authorAvatarUrl: asString(user?.avatar_url) || null,
    body: asString(record.body) || null,
    source,
    url: asString(record.html_url) || null,
    path: endpoint.filePath(record),
    line: endpoint.line(record),
    createdAt: asString(record.created_at) || null,
    updatedAt: asString(record.updated_at) || null,
    githubId,
    nodeId,
    reactions: toPrReactions(record.reactions),
  };
}

export function createPrCommentMutations(args: {
  githubService: GithubCommentApi;
  resolveWriteViewerLogin: () => Promise<string | null>;
  forgetActivityInputs: (repo: GitHubRepoRef, prNumber: number) => void;
}) {
  const assertViewerOwnsComment = async (comment: unknown): Promise<void> => {
    const record = isRecord(comment) ? comment : {};
    const user = isRecord(record.user) ? record.user : null;
    const author = asString(user?.login).trim();
    const viewer = asString(await args.resolveWriteViewerLogin()).trim();
    if (!viewer) throw new Error("GitHub viewer identity is unavailable; reconnect GitHub before editing a comment.");
    if (!author || author.toLowerCase() !== viewer.toLowerCase()) {
      throw new Error("You can only edit comments authored by the connected GitHub account.");
    }
  };

  const updateGithubCommentByCoords = async (updateArgs: {
    repoOwner: string;
    repoName: string;
    prNumber?: number | null;
    commentId: string;
    body: string;
    source: GithubCommentSource;
  }): Promise<PrComment> => {
    const commentId = positiveGithubId(updateArgs.commentId);
    if (commentId == null) throw new Error("Invalid comment id.");
    const repo: GitHubRepoRef = { owner: updateArgs.repoOwner, name: updateArgs.repoName };
    const endpoint = GITHUB_COMMENT_ENDPOINTS[updateArgs.source];
    const commentPath = endpoint.apiPath(repo, commentId);
    const { data: existing } = await args.githubService.apiRequest<GithubCommentPayload>({
      method: "GET",
      path: commentPath,
      repo,
    });
    if (updateArgs.prNumber != null) {
      const targetUrl = endpoint.parentPrUrl(existing);
      if (!targetUrl.endsWith(endpoint.expectedPrUrlSuffix(updateArgs.prNumber))) {
        throw new Error("Comment does not belong to the target PR.");
      }
    }
    await assertViewerOwnsComment(existing);
    const { data } = await args.githubService.apiRequest<GithubCommentPayload>({
      method: "PATCH",
      path: commentPath,
      body: { body: updateArgs.body },
      repo,
    });
    if (updateArgs.prNumber != null) args.forgetActivityInputs(repo, updateArgs.prNumber);
    return toPrComment(updateArgs.source, data, String(positiveGithubId(data.id) ?? commentId));
  };

  return { updateGithubCommentByCoords };
}
