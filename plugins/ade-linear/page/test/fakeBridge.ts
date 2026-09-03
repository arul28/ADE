/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the page and the plugin's child process
 * are now two programs joined by a named contract. This fake IS that contract,
 * written out: every action id the page may invoke, with the answer the child
 * would give. A page that calls an id this file does not script fails the test
 * rather than finding a helpful stub — which is the only way the test can prove
 * the seam, instead of proving that the page renders.
 */

import type {
  AdePluginBridge,
  PluginWebviewChangeEvent,
  PluginWebviewComposerAttach,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewHostEvent,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  CtoLinearQuickView,
  CtoSearchLinearIssuesResult,
  LinearConnectionStatus,
  NormalizedLinearIssue,
  PageLane,
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
  /**
   * Replace one host picker's answer mid-walk.
   *
   * `null` is the reader DISMISSING the popover, which every caller reads as
   * "leave the current value alone" — a different thing from choosing nothing.
   */
  setPicker: (
    picker: "model" | "provider" | "lane" | "permissionMode" | "reasoningEffort",
    answer: { id: string; label: string; provider?: string | null } | null,
  ) => void;
  /** The connection the scripted child reports. Sign-in flips it. */
  connection: LinearConnectionStatus;
  /** Push a `changed`, `theme` or `host` event at the page. */
  emit: (event: "changed" | "theme" | "host", payload: unknown) => void;
  /** Every collection write, as `collection/key`. */
  collections: Map<string, unknown>;
};

export const FAKE_VIEWER = {
  id: "user-1",
  name: "Ada",
  displayName: "Ada",
  email: "ada@example.com",
  avatarUrl: null,
  admin: false,
  guest: false,
  url: null,
};

export function fakeIssue(overrides: Partial<NormalizedLinearIssue> = {}): NormalizedLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-1",
    title: "Port Linear to the page tier",
    description: "The **browser**, moved.",
    url: "https://linear.app/ade/issue/ADE-1",
    projectId: "project-1",
    projectSlug: "page-tier",
    projectName: "Page tier",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-todo",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    ownerId: null,
    blockerIssueIds: [],
    hasOpenBlockers: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

const DISCONNECTED: LinearConnectionStatus = {
  tokenStored: false,
  connected: false,
  viewerId: null,
  viewerName: null,
  checkedAt: null,
  message: null,
  authMode: null,
  oauthAvailable: true,
};

const CONNECTED: LinearConnectionStatus = {
  tokenStored: true,
  connected: true,
  viewerId: FAKE_VIEWER.id,
  viewerName: FAKE_VIEWER.name,
  organizationName: "ADE",
  organizationUrlKey: "ade",
  projectCount: 1,
  checkedAt: "2026-09-02T10:00:00.000Z",
  message: null,
  authMode: "oauth",
  oauthAvailable: true,
};

/**
 * Build the fake and install it on `window`.
 *
 * `issues` is the workspace the scripted child answers reads from. The bridge
 * starts DISCONNECTED, which is the state a fresh install is in and the first
 * step of the walk.
 */
type PickerAnswer = { id: string; label: string; provider?: string | null };
type PickerLaneAnswer = PickerAnswer & { branchRef?: string | null; path?: string | null };

export function installFakeBridge(options: {
  issues?: NormalizedLinearIssue[];
  lanes?: PageLane[];
  context?: Partial<PluginWebviewContext>;
  /** Start signed in. The walk starts signed OUT, which is a fresh install. */
  connected?: boolean;
  /** Override the plugin settings `config.get` answers. */
  config?: Record<string, string | number | boolean | null>;
} = {}): FakeBridge {
  const issues = options.issues ?? [fakeIssue()];
  const lanes = options.lanes ?? [];
  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
    host: new Set(),
  };

  const state = {
    connection: options.connected ? { ...CONNECTED } : { ...DISCONNECTED },
    comments: [] as CtoLinearIssueComment[],
  };

  /**
   * What each host picker answers, so a test can retarget one.
   *
   * Mutable rather than fixed at install: a walk that presses the model chip
   * twice with two different answers is one test, and reinstalling the bridge
   * between the presses would throw the page's state away with it.
   */
  const pickerAnswers = {
    model: { id: "claude-opus-5", label: "Opus 5", provider: "claude" } as PickerAnswer | null,
    provider: { id: "claude", label: "Claude" } as PickerAnswer | null,
    lane: { id: "lane-1", label: "ADE-1", branchRef: "ade/ade-1" } as PickerLaneAnswer | null,
    permissionMode: { id: "acceptEdits", label: "Accept edits" } as PickerAnswer | null,
    reasoningEffort: { id: "high", label: "High" } as PickerAnswer | null,
  };

  const quickView = (): CtoLinearQuickView => ({
    connection: state.connection,
    organization: state.connection.connected
      ? {
        id: "org-1",
        name: "ADE",
        urlKey: "ade",
        logoUrl: null,
        gitBranchFormat: null,
        createdIssueCount: 1,
      }
      : null,
    viewer: state.connection.connected ? FAKE_VIEWER : null,
    projects: [],
    teams: [],
    assignedIssues: [],
    recentIssues: state.connection.connected ? issues : [],
    fetchedAt: "2026-09-02T10:00:00.000Z",
  });

  const catalog = (): CtoGetLinearIssuePickerDataResult => ({
    projects: [],
    users: [{ id: FAKE_VIEWER.id, name: "Ada", displayName: "Ada", email: null, active: true }],
    states: [
      { id: "state-todo", name: "Todo", type: "unstarted", teamId: "team-1", teamKey: "ADE" },
      { id: "state-doing", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ADE" },
      { id: "state-done", name: "Done", type: "completed", teamId: "team-1", teamKey: "ADE" },
    ],
  });

  const search = (): CtoSearchLinearIssuesResult => ({
    issues: state.connection.connected ? issues : [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });

  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    pageQuickView: () => quickView(),
    pageCatalog: () => catalog(),
    pageSearchIssues: () => search(),
    pageIssueComments: () => state.comments,
    // By ID, which no search can answer: the lane row badge is handed a uuid
    // and Linear's search does not match one.
    pageIssueById: (args) => issues.find((issue) => issue.id === args.issueId) ?? null,
    pageConnection: () => state.connection,
    pageProjects: () => [],
    pageAutolinks: () => ({
      autolinks: [],
      repo: null,
      teams: [],
      webhookUrl: null,
      webhookSecretStored: false,
      webhooksPossible: false,
      lastEvent: null,
      pendingDeliveries: 0,
      drainError: null,
    }),
    pageLanes: () => lanes,
    pageModels: () => [{
      id: "claude",
      label: "Claude",
      // The provider GROUP, from ADE's own capabilities read — never the id's
      // prefix. It is what joins a model to its permission vocabulary.
      provider: "claude",
      fastMode: true,
      reasoningEfforts: [{ effort: "high", label: "High" }],
      defaultReasoningEffort: null,
    }],
    pageCapabilities: () => ({
      providers: [{
        provider: "claude",
        // The launch FIELD the chosen value belongs in. Claude's values are
        // native, so they never ride the unified `permissionMode`.
        permissionField: "claudePermissionMode",
        defaultPermissionMode: "default",
        permissionModes: [
          { value: "default", label: "Manual", detail: "Claude asks before edits." },
          { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved." },
        ],
      }],
    }),
    // The sign-in. A real child answers `{authSession}`, the host opens it, and
    // the child settles it on its own `auth.completed`. The fake settles here,
    // which is what lets the walk carry on into a connected list.
    pageConnectOAuth: () => {
      state.connection = { ...CONNECTED };
      return { ok: true, message: "Connected as Ada.", authSession: { id: "linear" } };
    },
    pageSaveApiKey: () => {
      state.connection = { ...CONNECTED, authMode: "manual" };
      return { ok: true, message: "Connected as Ada.", connection: state.connection };
    },
    pageDisconnect: () => {
      state.connection = { ...DISCONNECTED };
      return { ok: true, message: "Disconnected.", connection: state.connection };
    },
    pageSetIssueState: (args) => {
      const issue = issues.find((row) => row.id === args.issueId);
      if (issue) {
        issue.stateId = String(args.stateId);
        issue.stateName = catalog().states.find((s) => s.id === args.stateId)?.name ?? issue.stateName;
      }
      return { ok: true, message: "State updated." };
    },
    pageSetIssuePriority: () => ({ ok: true, message: "Priority updated." }),
    pageAssignIssue: () => ({ ok: true, message: "Assigned 1 issue to you." }),
    pageAddComment: (args) => {
      state.comments = [
        ...state.comments,
        {
          id: `comment-${state.comments.length + 1}`,
          body: String(args.body ?? ""),
          createdAt: "2026-09-02T11:00:00.000Z",
          userName: "Ada",
          userDisplayName: "Ada",
        },
      ];
      return { ok: true, message: "Comment posted." };
    },
    pageAddLabel: () => ({ ok: true, message: "Label added." }),
    pageCreateAutolink: () => ({ ok: true, message: "GitHub now links ADE-123 to Linear." }),
    pageCreateLane: () => ({ ok: true, message: "Created lane ADE-1.", laneId: "lane-1", laneName: "ADE-1" }),
    pageDeleteLane: () => ({ ok: true, message: "Deleted." }),
    pageLaunchAgent: () => ({
      ok: true,
      message: "Started an agent on ADE-1.",
      laneId: "lane-1",
      laneName: "ADE-1",
      sessionId: "session-1",
    }),
    pageLaunchCli: () => ({ ok: true, message: "Started a CLI on ADE-1.", laneId: "lane-1" }),
    pageOpenChat: () => ({ ok: true, message: "Opened a chat.", sessionId: "session-1" }),
    pageLinkIssue: () => ({ ok: true, message: "Linked." }),
    pageUnlinkIssue: () => ({ ok: true, message: "Unlinked." }),
    // The webhook trio and the chat's two verbs live in `actions.js` rather
    // than in the page table, because the Automations tile and the chat menu
    // press them by the same names. Scripted here all the same: the page's own
    // settings line and issue-context card call them over this bridge.
    webhookStatus: () => ({
      ok: true,
      registered: true,
      canRegister: true,
      status: "Registered",
      url: "https://relay.example/linear",
      secretStored: true,
      connected: true,
      webhooksPossible: true,
      lastEvent: "2026-09-02 11:00 UTC",
      pendingDeliveries: 0,
      error: null,
    }),
    registerWebhook: () => ({ ok: true, message: "Linear now sends issue events to ADE.", registered: true }),
    unregisterWebhook: () => ({ ok: true, message: "ADE no longer receives Linear events.", registered: false }),
    openInLinear: () => ({ ok: true, openUrl: "https://linear.app/acme/issue/ADE-1" }),
    commentProgress: () => ({ ok: true, message: "Commented on ADE-1." }),
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-linear",
    context: {
      subject: null,
      surfaceId: "issues",
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
        return { defaultTeamKey: "", launchPromptClipboard: true, ...options.config };
      },
      async set(key, value) {
        record("config.set", typeof key === "string" ? { key, value } : { values: key });
        return { defaultTeamKey: "", launchPromptClipboard: true, ...options.config };
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
    composer: {
      async attach(issue: PluginWebviewComposerAttach) {
        record("composer.attach", issue as unknown as Record<string, unknown>);
      },
      async insert(text: string) {
        record("composer.insert", { text });
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
        // `PluginActionPromptAnswer`, exactly: the prompt's own id, the text the
        // reader typed, and the context it was asked with. The reader always
        // answers here; a dismissal is its own test.
        const asked = (request ?? {}) as { id?: unknown; context?: Record<string, unknown> };
        return {
          id: typeof asked.id === "string" ? asked.id : "prompt",
          text: "Progress from ADE",
          ...(asked.context ? { context: asked.context } : {}),
        };
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        return true;
      },
      // Synchronous and void, exactly as the bridge declares it: the page
      // reports its height to the element hosting the frame rather than asking
      // the host a question. A test asserting a repeat report was suppressed
      // reads the recorded calls.
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      /*
        The host's five pickers.

        Scripted rather than stubbed away, because the launch form has no
        controls of its own any more: it prints what these answer. Each records
        its request so a test can assert the page asked with the right subject —
        a permission popover opened for the wrong provider offers the wrong
        words — and each answers the first row of the fixture below, which is
        the reader choosing rather than dismissing.

        A test that needs a dismissal overrides the verb; `null` is the
        dismissal, and every caller leaves its value alone for it.
      */
      async pickModel(request?: { provider?: string | null; selected?: string | null }) {
        record("ui.pickModel", (request ?? {}) as Record<string, unknown>);
        return pickerAnswers.model;
      },
      async pickProvider(request?: { selected?: string | null }) {
        record("ui.pickProvider", (request ?? {}) as Record<string, unknown>);
        return pickerAnswers.provider;
      },
      async pickLane(request?: { selected?: string | null }) {
        record("ui.pickLane", (request ?? {}) as Record<string, unknown>);
        return pickerAnswers.lane;
      },
      async pickPermissionMode(request: { provider: string; selected?: string | null }) {
        record("ui.pickPermissionMode", request as unknown as Record<string, unknown>);
        return pickerAnswers.permissionMode;
      },
      async pickReasoningEffort(request: { provider: string; model: string; selected?: string | null }) {
        record("ui.pickReasoningEffort", request as unknown as Record<string, unknown>);
        return pickerAnswers.reasoningEffort;
      },
    },
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
    host: {
      async subscribe(subscribeOptions) {
        record("host.subscribe", subscribeOptions as unknown as Record<string, unknown>);
        return () => {};
      },
    },
    // The `dialog-picker` placement's one verb. Present on the fake in every
    // placement, because a test drives the entry directly and the guard in
    // `host/ui.ts` is what a real non-dialog placement exercises.
    dialog: {
      async submit(answer) {
        record("dialog.submit", answer as unknown as Record<string, unknown>);
      },
    },
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
    setPicker: (picker, answer) => {
      pickerAnswers[picker] = answer;
    },
    get connection() {
      return state.connection;
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(
          payload as PluginWebviewChangeEvent & PluginWebviewThemeSnapshot & PluginWebviewHostEvent,
        );
      }
    },
    collections,
  };
}

export function uninstallFakeBridge(): void {
  delete (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin;
}
