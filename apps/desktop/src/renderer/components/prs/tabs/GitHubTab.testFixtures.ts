import { vi } from "vitest";
import type {
  CreateLaneFromPrBranchPreflightResult,
  GitHubPrSnapshot,
  LaneSummary,
  PrWithConflicts,
} from "../../../../shared/types";

export function makeGitHubPr(overrides: Partial<GitHubPrSnapshot["repoPullRequests"][number]> = {}): GitHubPrSnapshot["repoPullRequests"][number] {
  return {
    id: "repo-open",
    scope: "repo",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 101,
    githubUrl: "https://github.com/ade-dev/ade/pull/101",
    title: "Open PR",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature/open",
    author: "octocat",
    createdAt: "2026-03-13T11:00:00.000Z",
    updatedAt: "2026-03-13T11:30:00.000Z",
    linkedPrId: "pr-open",
    linkedGroupId: null,
    linkedLaneId: "lane-open",
    linkedLaneName: "lane-open",
    adeKind: "single",
    workflowDisplayState: null,
    cleanupState: null,
    labels: [],
    isBot: false,
    commentCount: 0,
    ...overrides,
  };
}

export function makeLaneSummary(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-open",
    name: "lane-open",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/feature/open",
    worktreePath: "/tmp/lane-open",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-13T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

export const snapshot: GitHubPrSnapshot = {
  repo: { owner: "ade-dev", name: "ade" },
  viewerLogin: "octocat",
  syncedAt: "2026-03-13T12:00:00.000Z",
  repoPullRequests: [
    makeGitHubPr(),
    makeGitHubPr({
      id: "repo-merged",
      githubPrNumber: 102,
      githubUrl: "https://github.com/ade-dev/ade/pull/102",
      title: "Merged PR",
      state: "merged",
      headBranch: "feature/merged",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
      linkedPrId: "pr-merged",
      linkedLaneId: "lane-merged",
      linkedLaneName: "lane-merged",
    }),
  ],
  externalPullRequests: [],
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makePreflightResult(args: {
  githubPrNumber: number;
  title: string;
  headBranch: string;
  remoteBranch: string;
}): CreateLaneFromPrBranchPreflightResult {
  return {
    preflight: {
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: args.githubPrNumber,
      githubUrl: `https://github.com/ade-dev/ade/pull/${args.githubPrNumber}`,
      title: args.title,
      headBranch: args.headBranch,
      headRepoOwner: "ade-dev",
      headRepoName: "ade",
      headSha: "head-sha",
      remoteBranch: args.remoteBranch,
      importBranchRef: args.remoteBranch,
      targetLaneName: args.title,
      baseBranch: "main",
      canCreate: true,
      status: "ready",
      blockingConflict: null,
      blockingConflicts: [],
    },
    lane: null,
    pr: null,
  };
}

export function makePrsContext(prs: Array<Partial<PrWithConflicts> & { id: string }>) {
  return {
    prs,
    mergeContextByPrId: {},
    detailStatus: null,
    detailChecks: [],
    detailReviews: [],
    detailComments: [],
    detailBusy: false,
    loading: false,
    setViewerLogin: vi.fn(),
  };
}

export function installGitHubTabWindowMocks(): void {
  Object.assign(window, {
    ade: {
      prs: {
        getGitHubSnapshot: vi.fn().mockResolvedValue(snapshot),
        onEvent: vi.fn(() => () => {}),
        linkToLane: vi.fn(),
        preflightCreateLaneFromPrBranch: vi.fn().mockResolvedValue({
          preflight: {
            repoOwner: "ade-dev",
            repoName: "ade",
            githubPrNumber: 200,
            githubUrl: "https://github.com/ade-dev/ade/pull/200",
            title: "Unlinked PR",
            headBranch: "feature/open",
            headRepoOwner: "ade-dev",
            headRepoName: "ade",
            remoteBranch: "origin/feature/open",
            importBranchRef: "origin/feature/open",
            targetLaneName: "Unlinked PR",
            baseBranch: "main",
            canCreate: true,
            status: "ready",
            blockingConflict: null,
            blockingConflicts: [],
          },
          lane: null,
          pr: null,
        }),
        createLaneFromPrBranch: vi.fn().mockResolvedValue({
          preflight: {
            repoOwner: "ade-dev",
            repoName: "ade",
            githubPrNumber: 200,
            githubUrl: "https://github.com/ade-dev/ade/pull/200",
            title: "Unlinked PR",
            headBranch: "feature/open",
            headRepoOwner: "ade-dev",
            headRepoName: "ade",
            remoteBranch: "origin/feature/open",
            importBranchRef: "origin/feature/open",
            targetLaneName: "Unlinked PR",
            baseBranch: "main",
            canCreate: true,
            status: "ready",
            blockingConflict: null,
            blockingConflicts: [],
          },
          lane: { id: "lane-created", name: "Unlinked PR" },
          pr: { id: "pr-created", laneId: "lane-created" },
        }),
        addGitHubStackPullRequests: vi.fn().mockResolvedValue(null),
        unstackGitHubStack: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      github: {
        getStatus: vi.fn().mockResolvedValue({
          tokenStored: true,
          patTokenStored: true,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: "pat",
          tokenType: "classic",
          repo: { owner: "ade-dev", name: "ade" },
          hasOrigin: true,
          userLogin: "octocat",
          scopes: [],
          ghCliPath: null,
          ghAuthError: null,
          checkedAt: "2026-03-13T12:00:00.000Z",
          repoAccessOk: null,
          repoAccessError: null,
          connected: true,
        }),
      },
      app: {
        openExternal: vi.fn(),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
      },
    },
  });
}
