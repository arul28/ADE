/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the plugin and its page are now two
 * programs joined by a named contract. This fake IS that contract, written out:
 * every action id the page may invoke, with the answer the child would give. A
 * page that calls an id this file does not script fails the test rather than
 * finding a helpful stub — which is the only way the test can prove the seam,
 * instead of proving that the page renders.
 */

import type {
  AdePluginBridge,
  PluginWebviewChangeEvent,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewHostEvent,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  AgentChatSessionSummary,
  GitBranchSummary,
  GitCommitSummary,
  GitConflictState,
  HistoryLane,
  OperationRecord,
} from "../src/lib/types";

/** One thing the page asked the host for. */
export type BridgeCall = { method: string; args: Record<string, unknown> };

export type FakeBridge = {
  bridge: AdePluginBridge;
  /** Every call, in order. `invoke` is logged as `invoke:<action>`. */
  calls: BridgeCall[];
  callsTo: (method: string) => BridgeCall[];
  lastCall: (method: string) => BridgeCall | undefined;
  /** Replace one action's answer mid-walk. */
  setAction: (action: string, handler: (args: Record<string, unknown>) => unknown) => void;
  /** Push a `changed`, `theme` or `host` frame at the page. */
  emit: (event: "changed" | "theme" | "host", payload: unknown) => void;
  lanes: HistoryLane[];
  commits: GitCommitSummary[];
  operations: OperationRecord[];
  collections: Map<string, unknown>;
};

export function fakeLane(overrides: Partial<HistoryLane> & Pick<HistoryLane, "id" | "name">): HistoryLane {
  return {
    color: "#A78BFA",
    worktreePath: `/repo/.ade/worktrees/${overrides.name}`,
    laneType: "worktree",
    ...overrides,
  };
}

export const PRIMARY_LANE = fakeLane({
  id: "lane-1",
  name: "fix-login",
  laneType: "worktree",
});

export const SAMPLE_COMMIT: GitCommitSummary = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shortSha: "aaaaaaa",
  parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  authorName: "Ada",
  authoredAt: "2026-09-02T10:00:00.000Z",
  subject: "Fix the rail",
  pushed: true,
};

export const SAMPLE_BRANCH: GitBranchSummary = {
  name: "HEAD",
  isCurrent: true,
  isRemote: false,
  upstream: null,
  lastCommitSha: SAMPLE_COMMIT.sha,
};

export const SAMPLE_OPERATION: OperationRecord = {
  id: "op-1",
  laneId: "lane-1",
  laneName: "fix-login",
  kind: "git_commit",
  startedAt: "2026-09-02T10:00:00.000Z",
  endedAt: "2026-09-02T10:00:01.000Z",
  status: "succeeded",
  preHeadSha: SAMPLE_COMMIT.parents[0] ?? null,
  postHeadSha: SAMPLE_COMMIT.sha,
  metadataJson: JSON.stringify({ eventLabel: "Fix the rail" }),
};

const SAMPLE_CHAT: AgentChatSessionSummary = {
  sessionId: "session-1",
  laneId: "lane-1",
  provider: "claude",
  model: "opus",
  title: "Fix the rail",
  status: "idle",
  startedAt: "2026-09-02T09:00:00.000Z",
  endedAt: "2026-09-02T09:30:00.000Z",
  lastActivityAt: "2026-09-02T09:30:00.000Z",
  lastOutputPreview: null,
  summary: null,
};

const EMPTY_CONFLICT: GitConflictState = {
  laneId: "lane-1",
  kind: null,
  inProgress: false,
  conflictedFiles: [],
  canContinue: false,
  canAbort: false,
};

export type FakeBridgeOptions = {
  lanes?: HistoryLane[];
  commits?: GitCommitSummary[];
  branches?: GitBranchSummary[];
  operations?: OperationRecord[];
  context?: Partial<PluginWebviewContext>;
  /** Drop `host` entirely, as a host that predates this wave does. */
  withoutHost?: boolean;
};

/**
 * Build the fake and install it on `window`.
 *
 * Every id in `page/src/host/actions.ts` has a handler here. An id missing
 * from this table throws by name, which is the assertion: the table and
 * `pageActions.js` are the two halves of one contract.
 */
export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const state = {
    lanes: options.lanes ?? [PRIMARY_LANE],
    commits: options.commits ?? [SAMPLE_COMMIT],
    branches: options.branches ?? [SAMPLE_BRANCH],
    operations: options.operations ?? [SAMPLE_OPERATION],
  };

  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
    host: new Set(),
  };

  const ok = () => ({ ok: true });

  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    pageLanes: () => state.lanes,
    pageCommitGraph: () => ({ commits: state.commits, branches: state.branches }),
    pageCommitLookup: (args) => {
      const commit = state.commits.find((row) => row.sha === args.sha) ?? null;
      return { commit, inLaneHistory: commit != null };
    },
    pageCommitDetail: (args) => {
      const commit = state.commits.find((row) => row.sha === args.sha) ?? state.commits[0] ?? null;
      return { commit, message: commit?.subject ?? null, files: ["src/rail.ts"] };
    },
    pageOperations: () => state.operations,
    pageActivitySupplement: () => ({ chats: [SAMPLE_CHAT], ctoSnapshot: null }),
    pageConflictState: () => EMPTY_CONFLICT,
    pageOriginRemote: () => ({ remoteUrl: "https://github.com/acme/ade.git", branch: "main" }),
    pageOpenPrForBranch: () => ({ prUrl: null, prNumber: null }),
    pageStashList: () => [],
    pageFilePatch: () => "diff --git a/src/rail.ts b/src/rail.ts\n",
    pageExportOperations: () => ({ cancelled: true }),
    pageCherryPick: ok,
    pageRevertCommit: ok,
    pageResetToCommit: ok,
    pageCheckoutBranch: ok,
    pageCreateTag: ok,
    pageCreateLane: () => ({ ok: true, laneId: "lane-new", laneName: "new" }),
    pageGitFetch: ok,
    pageGitPull: ok,
    pageGitPush: ok,
    pageUndoHead: ok,
    pageRedoHead: ok,
    pageGitSync: ok,
    pageStashPush: ok,
    pageStashApply: ok,
    pageStashPop: ok,
    pageStashDrop: ok,
    pageStashClear: ok,
    pageRebaseContinue: ok,
    pageRebaseAbort: ok,
    pageMergeContinue: ok,
    pageMergeAbort: ok,
    pageRenameLane: ok,
    pageArchiveLane: ok,
    pageDeleteLane: ok,
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-history",
    context: {
      subject: null,
      surfaceId: "commits",
      placement: "tab",
      project: { projectId: "project-1", root: "/repo", binding: "local" },
      ...options.context,
    },
    collections: {
      async get(collection, key) {
        record("collections.get", { collection, key });
        return collections.get(`${collection}/${key}`) ?? null;
      },
      async put(collection, key, value) {
        record("collections.put", { collection, key, value });
        collections.set(`${collection}/${key}`, value);
      },
      async list(collection, listOptions) {
        record("collections.list", { collection, options: listOptions ?? {} });
        return [];
      },
    },
    async invoke(action, args) {
      record(`invoke:${action}`, args ?? {});
      const handler = actions[action];
      if (!handler) {
        throw new Error(
          `The page invoked "${action}", which the plugin does not answer.`
          + " Add it to pageActions.js, or stop calling it.",
        );
      }
      return handler(args ?? {});
    },
    config: {
      async get() {
        record("config.get", {});
        return {};
      },
      async set(key, value) {
        record("config.set", typeof key === "string" ? { key, value } : { values: key });
        return {};
      },
    },
    events: {
      on(event: string, listener: (payload: never) => void) {
        const set = listeners[event];
        if (!set) return () => {};
        set.add(listener as (payload: unknown) => void);
        return () => set.delete(listener as (payload: unknown) => void);
      },
    } as AdePluginBridge["events"],
    async openDeeplink(url) {
      record("openDeeplink", { url });
    },
    surface: {
      async close() {
        record("surface.close", {});
      },
    },
    ui: {
      async toast(next: PluginWebviewToast) {
        record("ui.toast", next as unknown as Record<string, unknown>);
        return { id: `toast-${calls.length}` };
      },
      async dismissToast(id: string) {
        record("ui.dismissToast", { id });
      },
      async prompt(request: unknown) {
        record("ui.prompt", { request });
        return null;
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        return true;
      },
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      async openPathInEditor(target) {
        record("ui.openPathInEditor", target as unknown as Record<string, unknown>);
      },
      async pickLane(pickOptions) {
        record("ui.pickLane", (pickOptions ?? {}) as Record<string, unknown>);
        return { laneId: "lane-1" };
      },
    },
    clipboard: {
      async read() {
        record("clipboard.read", {});
        return "";
      },
      async write(value: string) {
        record("clipboard.write", { text: value });
      },
    },
    theme: {
      async get() {
        record("theme.get", {});
        return { scheme: "dark", tokens: {} } as PluginWebviewThemeSnapshot;
      },
    },
    ...(options.withoutHost
      ? {}
      : {
        host: {
          async subscribe(subscribeOptions) {
            record("host.subscribe", subscribeOptions as unknown as Record<string, unknown>);
            return () => {};
          },
        },
      }),
  };

  (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin = bridge;

  return {
    bridge,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    lastCall: (method) => [...calls].reverse().find((call) => call.method === method),
    setAction: (action, handler) => {
      actions[action] = handler;
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(payload as PluginWebviewChangeEvent & PluginWebviewThemeSnapshot & PluginWebviewHostEvent);
      }
    },
    get lanes() {
      return state.lanes;
    },
    get commits() {
      return state.commits;
    },
    get operations() {
      return state.operations;
    },
    collections,
  };
}

export function uninstallFakeBridge(): void {
  delete (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin;
}
