/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the page and the plugin's child process
 * are now two programs joined by a named contract. This fake IS that contract,
 * written out: every action id the page may invoke, with the answer the child
 * would give. A page that calls an id this file does not script fails the test
 * rather than finding a helpful stub — which is the only way the test can prove
 * the seam, instead of proving that the page renders.
 *
 * The same rule holds for the five NEW bridge verbs this wave adds
 * (`ui.openPathInEditor`, `ui.pickModel`, `ui.pickLane`,
 * `ui.pickReasoningEffort`, and `host.subscribe`'s `review` kind): they are
 * scripted here so a page that calls them is checked, and `installFakeBridge`
 * takes options to REMOVE each one, so the guard that lets an older host draw
 * the same page is checked too.
 */

import type {
  AdePluginBridge,
  PluginWebviewChangeEvent,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewHostEvent,
  PluginWebviewHostKind,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  PageReviewLaunchContext,
  ReviewFinding,
  ReviewQualityReport,
  ReviewRun,
  ReviewRunDetail,
  ReviewSuppression,
} from "../src/types";

/** One thing the page asked the host for. */
export type BridgeCall = { method: string; args: Record<string, unknown> };

export type FakeBridge = {
  bridge: AdePluginBridge;
  /** Every call, in order. `invoke` is logged as `invoke:<action>`. */
  calls: BridgeCall[];
  /** The calls for one method, in order. */
  callsTo: (method: string) => BridgeCall[];
  /** The last call to one method, or undefined. */
  lastCall: (method: string) => BridgeCall | undefined;
  /** Replace one action's answer mid-walk. */
  setAction: (action: string, handler: (args: Record<string, unknown>) => unknown) => void;
  /** The runs the scripted child holds. Starting a run appends to it. */
  runs: ReviewRun[];
  /** The suppressions the scripted child holds. */
  suppressions: ReviewSuppression[];
  /** Every feedback the page recorded, in order, exactly as it arrived. */
  feedback: Record<string, unknown>[];
  /** Move a run to a new status, as the engine would. */
  advanceRun: (runId: string, patch: Partial<ReviewRunDetail>) => void;
  /** Push a `changed`, `theme` or `host` event at the page. */
  emit: (event: "changed" | "theme" | "host", payload: unknown) => void;
  /** Every collection write, as `collection/key`. */
  collections: Map<string, unknown>;
};

export function fakeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "finding-1",
    runId: "run-1",
    title: "Missing null check on the session lookup",
    severity: "high",
    findingClass: "incomplete_rollout",
    body: "auth.ts does not guard a missing user before reading its id.",
    confidence: 0.82,
    evidence: [
      {
        kind: "diff_hunk",
        summary: "The new branch reads user.id with no guard.",
        filePath: "src/auth.ts",
        line: 42,
        quote: "const id = user.id;",
        artifactId: null,
      },
    ],
    filePath: "src/auth.ts",
    line: 42,
    anchorState: "anchored",
    sourcePass: "adjudicated",
    publicationState: "local_only",
    originatingPasses: ["diff-risk"],
    adjudication: {
      score: 0.9,
      candidateCount: 2,
      mergedFindingIds: [],
      rationale: "Two reviewers flagged the same unguarded read.",
      publicationEligible: true,
    },
    feedback: null,
    suppressionMatch: null,
    diffContext: null,
    ...overrides,
  };
}

export function fakeRun(overrides: Partial<ReviewRunDetail> = {}): ReviewRunDetail {
  return {
    id: "run-1",
    projectId: "project-1",
    laneId: "lane-1",
    target: { mode: "lane_diff", laneId: "lane-1" },
    config: {
      compareAgainst: { kind: "default_branch" },
      selectionMode: "full_diff",
      dirtyOnly: false,
      modelId: "openai/gpt-5.6-sol",
      reasoningEffort: "low",
      fastMode: false,
      publishBehavior: "local_only",
    },
    targetLabel: "fix-login vs main",
    compareTarget: {
      kind: "default_branch",
      label: "main",
      ref: "refs/heads/main",
      laneId: null,
      branchRef: "refs/heads/main",
    },
    status: "completed",
    summary: "One finding on the login path.",
    errorMessage: null,
    findingCount: 1,
    severitySummary: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    chatSessionId: "session-1",
    createdAt: "2026-09-03T10:00:00.000Z",
    startedAt: "2026-09-03T10:00:01.000Z",
    endedAt: "2026-09-03T10:05:00.000Z",
    updatedAt: "2026-09-03T10:05:00.000Z",
    findings: [fakeFinding()],
    artifacts: [],
    reviewerRuns: [],
    candidateFindings: [],
    publications: [],
    chatSession: { sessionId: "session-1", laneId: "lane-1" },
    ...overrides,
  };
}

const LAUNCH_CONTEXT: PageReviewLaunchContext = {
  defaultLaneId: "lane-1",
  defaultBranchName: "main",
  lanes: [
    {
      id: "lane-1",
      name: "fix-login",
      laneType: "work",
      branchRef: "refs/heads/fix-login",
      baseRef: "refs/heads/main",
      color: null,
      path: "/repo/.ade/worktrees/fix-login",
    },
    {
      id: "lane-2",
      name: "main",
      laneType: "primary",
      branchRef: "refs/heads/main",
      baseRef: "refs/heads/main",
      color: null,
      path: "/repo",
    },
  ],
  recentCommitsByLane: {
    "lane-1": [
      { sha: "cccc333", shortSha: "cccc333", subject: "Third", authoredAt: "2026-09-03T09:00:00.000Z", pushed: false },
      { sha: "bbbb222", shortSha: "bbbb222", subject: "Second", authoredAt: "2026-09-02T09:00:00.000Z", pushed: true },
      { sha: "aaaa111", shortSha: "aaaa111", subject: "First", authoredAt: "2026-09-01T09:00:00.000Z", pushed: true },
    ],
  },
  recommendedModelId: "openai/gpt-5.6-sol",
  message: null,
};

const QUALITY_REPORT: ReviewQualityReport = {
  projectId: "project-1",
  totalRuns: 3,
  totalFindings: 7,
  addressedCount: 4,
  dismissedCount: 2,
  snoozedCount: 0,
  suppressedCount: 1,
  publishedCount: 0,
  noiseRate: 0.43,
  recentFeedback: [],
  byClass: [{ findingClass: "incomplete_rollout", total: 3, addressed: 2 }],
};

export function fakeSuppression(overrides: Partial<ReviewSuppression> = {}): ReviewSuppression {
  return {
    id: "suppression-1",
    scope: "repo",
    repoKey: "ade",
    pathPattern: null,
    title: "Missing null check on the session lookup",
    findingClass: "incomplete_rollout",
    severity: "high",
    reason: "low_value_noise",
    note: null,
    sourceFindingId: "finding-1",
    hitCount: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    lastMatchedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

export type FakeBridgeOptions = {
  runs?: ReviewRunDetail[];
  suppressions?: ReviewSuppression[];
  context?: Partial<PluginWebviewContext>;
  /** Drop `ui.openPathInEditor`, as a host that predates this wave does. */
  withoutEditor?: boolean;
  /** Drop the three host pickers. */
  withoutPickers?: boolean;
  /** Answer no chat capabilities, as a host that cannot read the registry does. */
  withoutChatModels?: boolean;
  /** Refuse `host.subscribe({kinds: ["review"]})`, as an older host does. */
  refuseReviewKind?: boolean;
  /** Drop `host` entirely. */
  withoutHost?: boolean;
};

/**
 * Build the fake and install it on `window`.
 *
 * `runs` is the workspace the scripted child answers reads from, and it starts
 * EMPTY — which is the state a fresh install is in and the first step of the
 * walk.
 */
export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const runs: ReviewRunDetail[] = [...(options.runs ?? [])];
  const suppressions: ReviewSuppression[] = [...(options.suppressions ?? [])];
  const feedback: Record<string, unknown>[] = [];
  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
    host: new Set(),
    refresh: new Set(),
  };

  let nextRunId = 100;

  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    pageRuns: () => runs.map((run) => ({ ...run })),
    pageRunDetail: (args) => runs.find((run) => run.id === args.runId) ?? null,
    pageLaunchContext: () => LAUNCH_CONTEXT,
    // `chat.capabilities().models`, as the child narrows it. Two rows and
    // deliberately not the same answer: the model the form opens on has NO fast
    // tier and the one the picker returns HAS one, so the walk can see the
    // toggle appear rather than proving it is always drawn. `withoutChatModels`
    // answers the empty list a host with no capabilities gives.
    pageChatModels: () =>
      options.withoutChatModels
        ? []
        : [
          { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", fastMode: false },
          { id: "anthropic/claude-opus-5", label: "Claude Opus 5", fastMode: true },
        ],
    pageSuppressions: () => suppressions.map((row) => ({ ...row })),
    pageQualityReport: () => QUALITY_REPORT,
    // The scripted child's launch: a run in `queued`, exactly as the engine
    // answers, so the walk can then watch it move.
    pageStartRun: (args) => {
      nextRunId += 1;
      const runId = `run-${nextRunId}`;
      const target = args.target as ReviewRunDetail["target"];
      const config = args.config as ReviewRunDetail["config"];
      runs.unshift(
        fakeRun({
          id: runId,
          status: "queued",
          summary: null,
          findingCount: 0,
          severitySummary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          findings: [],
          chatSession: null,
          chatSessionId: null,
          target,
          config,
        }),
      );
      return { ok: true, message: "Review started.", runId };
    },
    pageRerun: () => {
      nextRunId += 1;
      const runId = `run-${nextRunId}`;
      runs.unshift(fakeRun({ id: runId, status: "queued", findings: [], findingCount: 0 }));
      return { ok: true, message: "Rerun started.", runId };
    },
    pageCancelRun: (args) => {
      const run = runs.find((row) => row.id === args.runId);
      if (run) run.status = "cancelled";
      return { ok: true, message: "Cancelled." };
    },
    pageRecordFeedback: (args) => {
      feedback.push({ ...args });
      const run = runs.find((row) => row.findings.some((f) => f.id === args.findingId));
      const finding = run?.findings.find((f) => f.id === args.findingId);
      if (finding) {
        finding.feedback = {
          id: `feedback-${feedback.length}`,
          findingId: finding.id,
          runId: finding.runId,
          kind: args.kind as ReviewFinding["feedback"] extends null ? never : "acknowledge",
          reason: (args.reason ?? null) as null,
          note: (args.note ?? null) as null,
          snoozeUntil: null,
          createdAt: "2026-09-03T11:00:00.000Z",
        } as ReviewFinding["feedback"];
      }
      if (args.kind === "suppress") {
        suppressions.push(fakeSuppression({ id: `suppression-${suppressions.length + 1}` }));
      }
      return { ok: true, message: "Saved." };
    },
    pageDeleteSuppression: (args) => {
      const index = suppressions.findIndex((row) => row.id === args.suppressionId);
      if (index >= 0) suppressions.splice(index, 1);
      return { ok: true, message: "Removed." };
    },
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const ui: NonNullable<AdePluginBridge["ui"]> = {
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
    // Synchronous and void, exactly as the bridge declares it.
    resize(size: { height: number }) {
      record("ui.resize", size as unknown as Record<string, unknown>);
    },
  };

  if (!options.withoutEditor) {
    ui.openPathInEditor = async (target) => {
      record("ui.openPathInEditor", target as unknown as Record<string, unknown>);
    };
  }
  if (!options.withoutPickers) {
    ui.pickModel = async (request) => {
      record("ui.pickModel", (request ?? {}) as unknown as Record<string, unknown>);
      return { modelId: "anthropic/claude-opus-5", fastMode: true };
    };
    ui.pickLane = async (request) => {
      record("ui.pickLane", (request ?? {}) as unknown as Record<string, unknown>);
      return { laneId: "lane-1", name: "fix-login" };
    };
    ui.pickReasoningEffort = async (request) => {
      record("ui.pickReasoningEffort", request as unknown as Record<string, unknown>);
      return { modelId: request.model, effort: "high" };
    };
  }

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-review",
    context: {
      subject: null,
      surfaceId: "runs",
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
    async openSettings(target) {
      record("openSettings", target as unknown as Record<string, unknown>);
    },
    surface: {
      async close() {
        record("surface.close", {});
      },
    },
    ui,
    clipboard: {
      async read() {
        record("clipboard.read", {});
        return "";
      },
      async write(text: string) {
        record("clipboard.write", { text });
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
          async subscribe(subscribeOptions: { kinds: PluginWebviewHostKind[] }) {
            record("host.subscribe", subscribeOptions as unknown as Record<string, unknown>);
            // An older host knows `lane`, `session`, `pr` and `chat` and refuses
            // anything else — which is exactly what makes the page's poll a
            // fallback rather than dead code.
            if (options.refuseReviewKind && subscribeOptions.kinds.includes("review")) {
              throw new Error('Unknown host kind "review".');
            }
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
    runs,
    suppressions,
    feedback,
    advanceRun: (runId, patch) => {
      const index = runs.findIndex((run) => run.id === runId);
      if (index >= 0) runs[index] = { ...runs[index]!, ...patch };
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(payload as PluginWebviewChangeEvent & PluginWebviewThemeSnapshot & PluginWebviewHostEvent);
      }
    },
    collections,
  };
}

export function uninstallFakeBridge(): void {
  delete (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin;
}
