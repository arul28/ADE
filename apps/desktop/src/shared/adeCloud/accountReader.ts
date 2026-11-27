/**
 * The account reader for ADE Cloud: the answers a project tab bound to ADE
 * Cloud, or a lane pin of a cloud computer that is asleep or deleted, reads
 * with no computer awake.
 *
 * - The ADE account server answers what the cloud computers saved at rest
 *   (`GET /cloud/projects/overview`, the Git summaries).
 * - GitHub answers the files and the commits of a lane's branch, with the
 *   account's GitHub App sign-in (`shared/github/directClient.ts`).
 *
 * Reads only. A read never wakes a computer. An action this reader does not
 * answer is not handled, and the caller refuses it or sends it to the lane's
 * own computer. Isomorphic: the desktop main process and the web client run
 * the same code with their own clients.
 *
 * The request uses the desktop runtime vocabulary (`domain` + `action`, with
 * `args` or `arg`), as `preload.ts` sends it.
 */

import type { CloudApiClient } from "../cloudApiClient";
import { markExpected } from "../expectedError";
import { createAdeCloudIntegrationReads } from "./integrationReads";
import type { AdeCloudAccountCallFn } from "./accountCalls";
import type { CloudGitSummary, CloudLaneOverview, CloudProjectOverview } from "../../../../account-directory/src/cloud/contract";
import type {
  DiffChanges,
  FileChange,
  FileContent,
  FilesGitStatusEvent,
  FilesListTreeChildrenResult,
  FilesWorkspace,
  FileTreeChangeStatus,
  FileTreeNode,
  GitCommitSummary,
  GitUpstreamSyncStatus,
  GithubDirectData,
  GithubDirectError,
  GithubDirectOp,
  GithubDirectRepoRef,
  GithubDirectRequest,
  GithubDirectRequestOptions,
  GithubDirectResult,
} from "../types";
import { BRAND } from "../brand";

/** The `window.ade.githubDirect.request` contract. */
export type AdeCloudGithubRequest = <O extends GithubDirectOp>(
  request: Extract<GithubDirectRequest, { op: O }>,
  options?: GithubDirectRequestOptions,
) => Promise<GithubDirectResult<GithubDirectData[O]>>;

export type AdeCloudAccountReaderDeps = {
  /** The account server's client; null while signed out. */
  cloud: () => Pick<CloudApiClient, "projectOverview" | "gitSummary"> | null;
  github: () => AdeCloudGithubRequest | null;
  /** Account calls (Linear and Jira reads). Optional: an older bridge has none. */
  accountCall?: () => AdeCloudAccountCallFn | null;
  now?: () => number;
};

/** What a read is about. */
export type AdeCloudReadScope = {
  /** The project's repository address (`gitOriginUrl`). */
  origin: string | null;
  /** A lane pin of one cloud computer: its machine key. Null for the ADE Cloud tab itself. */
  machineKey: string | null;
};

export type AdeCloudReadRequest = { domain: string; action: string; args?: unknown; arg?: unknown };

export type AdeCloudReadAnswer = { handled: true; result: unknown } | { handled: false };

/** What a tab bound to ADE Cloud says for an action that needs a computer. */
export const ADE_CLOUD_NEEDS_LANE_SENTENCE =
  `${BRAND.CLOUD_NAME} runs this on a lane's own computer. Open a lane, or start one on ${BRAND.CLOUD_NAME}.`;

/** Workspace ids of cloud lanes in the Files tab: never the id of a real worktree. */
const WORKSPACE_PREFIX = "ade-cloud-lane:";
/** The workspace id's tail for the repository's default branch; never a lane id (lane ids hold no `~`). */
const DEFAULT_BRANCH_WORKSPACE = "~default";
const OVERVIEW_TTL_MS = 15_000;
const SUMMARY_TTL_MS = 15_000;
const TREE_PAGE_DEFAULT = 500;
/** Larger files open as "too large" instead of as text (GitHub gives 1 MB at most here). */
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function adeCloudWorkspaceId(laneId: string): string {
  return `${WORKSPACE_PREFIX}${laneId}`;
}

export function laneIdOfAdeCloudWorkspace(workspaceId: unknown): string | null {
  return typeof workspaceId === "string" && workspaceId.startsWith(WORKSPACE_PREFIX)
    ? workspaceId.slice(WORKSPACE_PREFIX.length) || null
    : null;
}

/** `owner` and `name` of a GitHub repository address; null for another host. */
export function githubRepoOfOrigin(origin: string | null | undefined): { owner: string; name: string } | null {
  const value = origin?.trim() ?? "";
  if (!value) return null;
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(value)
    ?? /^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(value);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

/** The sentence a person reads for a GitHub read that failed. */
export function githubReadSentence(error: GithubDirectError): string {
  switch (error.kind) {
    case "not_connected":
      return `Connect GitHub to your ${BRAND.NAME} account to see this repository's files with no computer on.`;
    case "sign_in_expired":
      return `Your GitHub sign-in for ${BRAND.NAME} expired. Sign in to GitHub again in Settings.`;
    case "app_not_installed":
      return `${BRAND.NAME}'s GitHub App isn't installed for this repository's owner, so ${BRAND.NAME} can't read it with no computer on.`;
    case "repo_not_reachable":
      return error.sso
        ? `This organization needs a single sign-on session on GitHub before ${BRAND.NAME} can read it.`
        : `${BRAND.NAME} can't reach this repository on GitHub with your sign-in.`;
    case "rights_not_accepted":
      return `The repository's owner hasn't accepted ${BRAND.NAME}'s GitHub App rights yet.`;
    case "rate_limited":
      return `GitHub asked ${BRAND.NAME} to wait. Try again in a few minutes.`;
    case "not_found":
      return "GitHub has no such branch or file. Push the lane's branch to see it here.";
    default:
      return error.message || "GitHub didn't answer. Try again.";
  }
}

/** A file search of a lane at rest: it needs the lane's checkout. */
const ADE_CLOUD_SEARCH_NEEDS_COMPUTER_SENTENCE = "Searching this lane's files needs its computer. Send a message or run something in the lane to wake it.";
/** History past GitHub's first page of a lane at rest. */
const ADE_CLOUD_OLDER_COMMITS_SENTENCE = "Older commits of this lane show when its computer is on. Send a message or run something in the lane to wake it.";

function readFailure(message: string): Error {
  return markExpected(new Error(message), "network");
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function argsOf(request: AdeCloudReadRequest): Record<string, unknown> {
  return recordOf(request.args ?? request.arg);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function laneIdOf(request: AdeCloudReadRequest): string | null {
  if (typeof request.arg === "string" && request.arg.trim()) return request.arg.trim();
  return stringField(argsOf(request), "laneId");
}

function changeStatusOf(status: string): FileTreeChangeStatus {
  const code = status.trim().toUpperCase();
  if (code.startsWith("A") || code === "??" || code === "U") return code === "??" ? "untracked" : "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  return "modified";
}

function fileChangeKind(status: string): FileChange["kind"] {
  const changed = changeStatusOf(status);
  return changed === "untracked" ? "untracked" : changed === "added" ? "added" : changed === "deleted" ? "deleted" : changed === "renamed" ? "renamed" : "modified";
}

function languageOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", mjs: "javascript", cjs: "javascript",
    json: "json", md: "markdown", mdx: "markdown", css: "css", scss: "scss", html: "html", yml: "yaml", yaml: "yaml",
    py: "python", rb: "ruby", go: "go", rs: "rust", swift: "swift", kt: "kotlin", java: "java", sh: "shell", sql: "sql",
    toml: "toml", xml: "xml", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php",
  };
  return known[extension] ?? "plaintext";
}

/** Base64 to text; null when the bytes are not UTF-8 text. */
function textOfBase64(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type Cached<T> = { at: number; value: Promise<T> };

export function createAdeCloudAccountReader(deps: AdeCloudAccountReaderDeps) {
  const now = deps.now ?? (() => Date.now());
  const overviews = new Map<string, Cached<CloudProjectOverview | null>>();
  const summaries = new Map<string, Cached<CloudGitSummary | null>>();
  // Linear and Jira reads of the account (`integrationReads.ts`); writes stay unhandled.
  const integrations = createAdeCloudIntegrationReads(() => deps.accountCall?.() ?? null);

  /** One read in flight per key, kept a short while: every surface of a tab asks at once. */
  const cachedRead = <T>(cache: Map<string, Cached<T>>, key: string, ttlMs: number, run: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = run();
    cache.set(key, { at: now(), value });
    // A failed read is not kept: the next surface asks again.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    while (cache.size > 50) cache.delete(cache.keys().next().value as string);
    return value;
  };

  const overview = (origin: string): Promise<CloudProjectOverview | null> => {
    const cloud = deps.cloud();
    if (!cloud) return Promise.reject(readFailure(`Sign in to ${BRAND.NAME} to see this project's ${BRAND.CLOUD_NAME} lanes.`));
    return cachedRead(overviews, origin, OVERVIEW_TTL_MS, () => cloud.projectOverview(origin));
  };

  const lanesOf = async (scope: AdeCloudReadScope): Promise<CloudLaneOverview[]> => {
    // No repository address: the account can't say which lanes are this project's.
    if (!scope.origin) throw readFailure(`${BRAND.NAME} doesn't know this project's repository address, so it can't read its ${BRAND.CLOUD_NAME} lanes. Open the project on a computer once.`);
    const answer = await overview(scope.origin);
    const lanes = answer?.lanes ?? [];
    return scope.machineKey ? lanes.filter((lane) => lane.machineKey === scope.machineKey) : lanes;
  };

  const laneFor = async (scope: AdeCloudReadScope, laneId: string): Promise<CloudLaneOverview> => {
    const lane = (await lanesOf(scope)).find((entry) => entry.laneId === laneId);
    if (!lane) throw readFailure(`${BRAND.CLOUD_NAME} has no saved copy of this lane.`);
    return lane;
  };

  const summaryOf = (lane: CloudLaneOverview): Promise<CloudGitSummary | null> => {
    const cloud = deps.cloud();
    if (!cloud || !lane.machineKey) return Promise.resolve(null);
    const machineKey = lane.machineKey;
    return cachedRead(summaries, `${machineKey}\0${lane.laneId}`, SUMMARY_TTL_MS, () => cloud.gitSummary(machineKey, lane.laneId));
  };

  const github = async <O extends GithubDirectOp>(request: Extract<GithubDirectRequest, { op: O }>): Promise<GithubDirectData[O]> => {
    const send = deps.github();
    if (!send) throw readFailure(`This version of ${BRAND.NAME} can't read GitHub directly.`);
    const answer = await send<O>(request);
    if (!answer.ok) throw readFailure(githubReadSentence(answer.error));
    return answer.data;
  };

  /** The repository and the branch a lane's files are read at; a lane with no pushed branch has none. */
  const repoAt = async (scope: AdeCloudReadScope, laneId: string) => {
    const repo = githubRepoOfOrigin(scope.origin);
    if (!repo) throw readFailure(`${BRAND.NAME} reads files with no computer on only for repositories on GitHub.`);
    const lane = await laneFor(scope, laneId);
    const summary = await summaryOf(lane).catch(() => null);
    const branch = lane.branch ?? summary?.branch ?? null;
    if (!branch) throw readFailure("This lane has no branch on GitHub yet. Its files show when its computer is on.");
    // A branch the computer never pushed is not on GitHub: say so, and read nothing.
    if (summary && !summary.upstream) {
      throw readFailure(`The branch ${branch} isn't on GitHub yet. Its files show when the lane's computer is on.`);
    }
    return { repo, lane, summary, branch };
  };

  /** A lane's repository and branch, or the default branch's (no ref: GitHub reads its default). */
  const refAt = async (scope: AdeCloudReadScope, laneId: string): Promise<{ repo: GithubDirectRepoRef; summary: CloudGitSummary | null; branch: string | undefined }> => {
    if (laneId !== DEFAULT_BRANCH_WORKSPACE) return await repoAt(scope, laneId);
    const repo = githubRepoOfOrigin(scope.origin);
    if (!repo) throw readFailure(`${BRAND.NAME} reads files with no computer on only for repositories on GitHub.`);
    return { repo, summary: null, branch: undefined };
  };

  const workspaces = async (scope: AdeCloudReadScope): Promise<FilesWorkspace[]> => {
    const lanes: FilesWorkspace[] = (await lanesOf(scope))
      .filter((lane) => lane.branch)
      .map((lane) => ({
        id: adeCloudWorkspaceId(lane.laneId),
        kind: "worktree" as const,
        laneId: lane.laneId,
        name: lane.laneName?.trim() || lane.branch || lane.laneId,
        branchRef: `refs/heads/${lane.branch}`,
        rootPath: "",
        isReadOnlyByDefault: true,
        mobileReadOnly: true,
      }));
    // The repository's default branch, read-only: a new repository with no lane yet still shows its files.
    if (!githubRepoOfOrigin(scope.origin)) return lanes;
    return [...lanes, {
      id: adeCloudWorkspaceId(DEFAULT_BRANCH_WORKSPACE),
      kind: "primary",
      laneId: null,
      name: "Default branch",
      rootPath: "",
      isReadOnlyByDefault: true,
      mobileReadOnly: true,
    }];
  };

  const changedByPath = (summary: CloudGitSummary | null): Map<string, FileTreeChangeStatus> =>
    new Map((summary?.changed ?? []).map((entry) => [entry.path, changeStatusOf(entry.status)]));

  const treeChildren = async (scope: AdeCloudReadScope, args: Record<string, unknown>): Promise<FilesListTreeChildrenResult> => {
    const laneId = laneIdOfAdeCloudWorkspace(args.workspaceId);
    const parentPath = (stringField(args, "parentPath") ?? "").replace(/^\/+|\/+$/g, "");
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.trunc(args.offset) : 0;
    const limit = typeof args.limit === "number" ? Math.min(2000, Math.max(1, Math.trunc(args.limit))) : TREE_PAGE_DEFAULT;
    if (!laneId) return { parentPath, children: [], offset, limit, total: 0, nextOffset: null };
    const { repo, summary, branch } = await refAt(scope, laneId);
    const entries = await github({ op: "listContents", params: { ...repo, path: parentPath, ref: branch } });
    const changed = changedByPath(summary);
    const changedDirs = new Set<string>();
    for (const path of changed.keys()) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) changedDirs.add(parts.slice(0, index).join("/"));
    }
    const nodes: FileTreeNode[] = entries.map((entry) => {
      const directory = entry.kind === "dir";
      const status = changed.get(entry.path) ?? (directory && changedDirs.has(entry.path) ? "modified" : undefined);
      return {
        name: entry.name,
        path: entry.path,
        type: directory ? "directory" : "file",
        ...(directory ? { hasChildren: true } : { size: entry.size }),
        ...(status ? { changeStatus: status } : {}),
      };
    });
    const page = nodes.slice(offset, offset + limit);
    const next = offset + limit < nodes.length ? offset + limit : null;
    return { parentPath, children: page, offset, limit, total: nodes.length, nextOffset: next };
  };

  const readFile = async (scope: AdeCloudReadScope, args: Record<string, unknown>): Promise<FileContent> => {
    const laneId = laneIdOfAdeCloudWorkspace(args.workspaceId);
    const path = stringField(args, "path");
    if (!laneId || !path) throw readFailure(`${BRAND.CLOUD_NAME} can't find this file.`);
    const { repo, branch } = await refAt(scope, laneId);
    const file = await github({ op: "getFileContent", params: { ...repo, path, ref: branch } });
    const languageId = languageOf(path);
    if (file.tooLarge || file.size > TEXT_PREVIEW_MAX_BYTES) {
      return { content: "", encoding: "utf-8", size: file.size, totalSize: file.size, languageId, isBinary: false, contentOmitted: true, omittedReason: "too_large" };
    }
    const text = textOfBase64(file.content);
    if (text == null) {
      return { content: "", encoding: "base64", size: file.size, totalSize: file.size, languageId, isBinary: true, previewKind: "binary", contentOmitted: true, omittedReason: "unsupported_binary" };
    }
    return { content: text, encoding: "utf-8", size: file.size, totalSize: file.size, languageId, isBinary: false, previewKind: "text" };
  };

  const gitDecorations = async (scope: AdeCloudReadScope, args: Record<string, unknown>): Promise<FilesGitStatusEvent> => {
    const workspaceId = stringField(args, "workspaceId") ?? "";
    const laneId = laneIdOfAdeCloudWorkspace(workspaceId);
    if (!laneId || laneId === DEFAULT_BRANCH_WORKSPACE) return { workspaceId, files: [], directories: [] };
    const summary = await summaryOf(await laneFor(scope, laneId)).catch(() => null);
    const files = [...changedByPath(summary)].map(([path, changeStatus]) => ({ path, changeStatus }));
    return { workspaceId, files, directories: [], ...(summary?.truncated ? { truncated: true } : {}) };
  };

  const recentCommits = async (scope: AdeCloudReadScope, args: Record<string, unknown>): Promise<GitCommitSummary[]> => {
    const laneId = stringField(args, "laneId");
    if (!laneId) return [];
    // Older pages need the lane's computer: GitHub's first page is what a resting lane shows.
    if (typeof args.skip === "number" && args.skip > 0) throw readFailure(ADE_CLOUD_OLDER_COMMITS_SENTENCE);
    const { repo, branch } = await repoAt(scope, laneId);
    const asked = typeof args.limit === "number" && args.limit > 0 ? Math.trunc(args.limit) : null;
    // GitHub sends 50 a page. Enough pages to fill the request (at most 2), so
    // a long history reads as "more" and its next page says why it stops.
    const maxPages = asked ? Math.min(2, Math.ceil(asked / 50)) : 1;
    const commits = await github({ op: "listCommits", params: { ...repo, ref: branch, maxPages } });
    const limit = asked ?? commits.length;
    return commits.slice(0, limit).map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      parents: [],
      authorName: commit.authorName ?? commit.authorLogin ?? "",
      authoredAt: commit.authoredAt ?? "",
      subject: commit.message.split("\n")[0] ?? "",
      // GitHub has it, so it was pushed.
      pushed: true,
    }));
  };

  const syncStatus = async (scope: AdeCloudReadScope, laneId: string): Promise<GitUpstreamSyncStatus> => {
    const summary = await summaryOf(await laneFor(scope, laneId));
    if (!summary) throw readFailure(`${BRAND.CLOUD_NAME} has no saved Git state for this lane yet.`);
    const diverged = summary.ahead > 0 && summary.behind > 0;
    return {
      hasUpstream: Boolean(summary.upstream),
      upstreamState: summary.upstream ? "tracking" : "none",
      upstreamRef: summary.upstream,
      ahead: summary.ahead,
      behind: summary.behind,
      diverged,
      // The lane's computer decides a pull or a push; at rest there is nothing to do.
      recommendedAction: "none",
    };
  };

  const workingChanges = async (scope: AdeCloudReadScope, laneId: string): Promise<DiffChanges> => {
    const summary = await summaryOf(await laneFor(scope, laneId));
    if (!summary) throw readFailure(`${BRAND.CLOUD_NAME} has no saved Git state for this lane yet.`);
    return {
      unstaged: summary.changed.map((entry) => ({
        path: entry.path,
        kind: fileChangeKind(entry.status),
        additions: entry.added,
        deletions: entry.removed,
      })),
      staged: [],
    };
  };

  /**
   * The answer to one read, or `handled: false` when this reader does not
   * answer that action. Throws an expected error with a sentence for a read
   * it answers but cannot complete ("couldn't load", never a false empty).
   */
  const answer = async (scope: AdeCloudReadScope, request: AdeCloudReadRequest): Promise<AdeCloudReadAnswer> => {
    const key = `${request.domain}.${request.action}`;
    const args = argsOf(request);
    switch (key) {
      // The ADE Cloud tab has no lanes or sessions of its own: each cloud
      // lane comes from its own computer's saved copy (`cloudSavedChatsSync`).
      case "lane.list":
      case "session.list":
      case "chat.listSessions":
        return { handled: true, result: [] };
      case "file.listWorkspaces":
        return { handled: true, result: await workspaces(scope) };
      case "file.listTreeChildren":
        return { handled: true, result: await treeChildren(scope, args) };
      case "file.listTree": {
        const page = await treeChildren(scope, { ...args, parentPath: stringField(args, "parentPath") ?? "", limit: 2000 });
        return { handled: true, result: page.children };
      }
      case "file.readFile":
        return { handled: true, result: await readFile(scope, args) };
      case "file.refreshGitDecorations":
        return { handled: true, result: await gitDecorations(scope, args) };
      case "file.quickOpen":
      case "file.searchText":
        // A search needs the lane's checkout: say so, never "no matches".
        throw readFailure(ADE_CLOUD_SEARCH_NEEDS_COMPUTER_SENTENCE);
      case "git.listRecentCommits":
        return { handled: true, result: await recentCommits(scope, args) };
      case "git.getSyncStatus": {
        const laneId = laneIdOf(request);
        return laneId ? { handled: true, result: await syncStatus(scope, laneId) } : { handled: false };
      }
      case "diff.getChanges": {
        const laneId = laneIdOf(request);
        return laneId ? { handled: true, result: await workingChanges(scope, laneId) } : { handled: false };
      }
      default:
        return integrations.answer(scope, request);
    }
  };

  /** The project's ADE Cloud view, for a surface that shows it whole ("as of" times, lanes). */
  const readOverview = (origin: string) => overview(origin);

  /** Drops every kept read: a sign-out, an account switch, or a computer that saved again. */
  const clear = (): void => {
    overviews.clear();
    summaries.clear();
  };

  return { answer, readOverview, laneSummary: (scope: AdeCloudReadScope, laneId: string) => laneFor(scope, laneId).then(summaryOf), clear };
}

export type AdeCloudAccountReader = ReturnType<typeof createAdeCloudAccountReader>;
