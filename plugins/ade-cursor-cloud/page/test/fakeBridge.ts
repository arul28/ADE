/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the plugin is now two programs joined by
 * a named contract. This fake IS that contract, written out: every action id
 * the page may invoke, with the answer the child would give. A page that calls
 * an id this file does not script fails the test rather than finding a helpful
 * stub — which is the only way the test can prove the seam instead of proving
 * that the page renders.
 *
 * It is owned by neither half. `page/src/host/actions.ts` and the child's
 * `pageActions.js` both have to keep it passing.
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
  CloudAgent,
  CloudAgentPage,
  CloudFleetEntry,
  CloudFleetPage,
  CloudLaunchContext,
} from "../src/types";

/**
 * What a caller may override on a scripted row.
 *
 * `agent` is `Partial<CloudAgent>` rather than the whole thing, because every
 * caller wants one field of it — a status, an archived flag — and none wants to
 * retype the id and the repo the rest of the walk matches on.
 */
export type FakeEntryOverrides =
  Partial<Omit<CloudFleetEntry, "agent">> & { agent?: Partial<CloudAgent> };

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
  /** The agents the scripted child holds. Mutated by archive/delete/stop. */
  entries: CloudFleetEntry[];
  /** Push a `changed`, `theme`, `host` or `refresh` event at the page. */
  emit: (event: "changed" | "theme" | "host" | "refresh", payload?: unknown) => void;
  /** Every collection write, as `collection/key`. */
  collections: Map<string, unknown>;
};

/**
 * One scripted row.
 *
 * `agent` is merged rather than replaced, so a caller who only wants a
 * different status writes `{ agent: { status: "finished" } }` and keeps the id
 * and the repo the rest of the walk matches on. It is spread LAST over the row
 * for the same reason the other fields are not: a partial `agent` from
 * `overrides` must not reach the row as the whole agent.
 */
export function fakeEntry(overrides: FakeEntryOverrides = {}): CloudFleetEntry {
  const { agent: agentOverrides, ...rest } = overrides;
  const agent: CloudAgent = {
    agentId: "bc_abc123",
    name: "Fix the flaky sync test",
    summary: "Fix the flaky sync test and open a PR.",
    archived: false,
    status: "running",
    createdAt: Date.parse("2026-09-02T10:00:00.000Z"),
    lastModified: Date.parse("2026-09-02T10:30:00.000Z"),
    repos: ["https://github.com/arul28/ade"],
    webUrl: "https://cursor.com/agents?id=bc_abc123",
    latestRunId: "run_1",
    ...(agentOverrides ?? {}),
  };
  return {
    runStatus: "running",
    latestRunId: "run_1",
    branch: "cursor/fix-sync",
    prUrl: null,
    modelId: "composer-2",
    matchedBy: "repo",
    ownership: {
      sessionId: null,
      sessionTitle: null,
      laneId: "lane-1",
      laneName: "sync-fix",
      linearIssueId: null,
    },
    age: "30m",
    status: "running",
    active: true,
    ...rest,
    agent,
  };
}

function emptyGroups(): CloudFleetPage["groups"] {
  return { active: [], lanes: [], unlinked: [] };
}

/**
 * Group the scripted entries the way `fleet.js:groupFleet` does, so the fake
 * answers the same shape the child would rather than a hand-written one that
 * could drift from it.
 */
function group(entries: CloudFleetEntry[]): CloudFleetPage["groups"] {
  const groups = emptyGroups();
  const laneGroups = new Map<string, { laneId: string; laneName: string; entries: CloudFleetEntry[] }>();
  const unlinkedGroups = new Map<string, { key: string; label: string; entries: CloudFleetEntry[] }>();
  for (const entry of entries) {
    if (entry.active) {
      groups.active.push(entry);
      continue;
    }
    const laneId = entry.ownership.laneId;
    if (laneId) {
      const found = laneGroups.get(laneId)
        ?? { laneId, laneName: entry.ownership.laneName ?? "Lane", entries: [] };
      found.entries.push(entry);
      laneGroups.set(laneId, found);
      continue;
    }
    const key = `${entry.agent.repos[0] ?? ""}|${entry.branch ?? ""}`;
    const found = unlinkedGroups.get(key) ?? { key, label: "Unknown repo", entries: [] };
    found.entries.push(entry);
    unlinkedGroups.set(key, found);
  }
  groups.lanes = [...laneGroups.values()];
  groups.unlinked = [...unlinkedGroups.values()];
  return groups;
}

const CONNECTED_LAUNCH: CloudLaunchContext = {
  unavailable: null,
  repoUrl: "https://github.com/arul28/ade",
  repoLabel: "arul28/ade",
  repoCaption: "Cursor clones arul28/ade and pushes back to it.",
  laneRemote: "git@github.com:arul28/ade.git",
  lanes: [{ id: "lane-1", name: "sync-fix" }, { id: "lane-2", name: "docs" }],
  laneId: "lane-1",
  branch: "ade/sync-fix",
  models: [
    {
      id: "composer-2",
      label: "Composer 2",
      reasoningEfforts: [{ value: "high", label: "High" }],
      speed: true,
    },
    { id: "sonnet-4.5", label: "Sonnet 4.5", reasoningEfforts: [], speed: false },
  ],
  showSpeed: true,
  reasoningOptions: [{ value: "high", label: "High" }],
  secretNames: ["DATABASE_URL", "STRIPE_KEY"],
  selectedSecrets: [],
  rememberSecretNames: false,
  autoOpenPr: false,
  existingPr: null,
  draft: "",
};

/**
 * Build the fake and install it on `window`.
 *
 * The bridge starts WITH a key and one running agent, because that is the state
 * every surface except the empty ones is drawn in. `connected: false` scripts a
 * child with no Cursor key, which is the fleet's `no-key` body.
 */
export function installFakeBridge(options: {
  entries?: CloudFleetEntry[];
  context?: Partial<PluginWebviewContext>;
  /** Start with no Cursor API key. */
  connected?: boolean;
  launch?: Partial<CloudLaunchContext>;
} = {}): FakeBridge {
  const entries = options.entries ?? [fakeEntry()];
  const connected = options.connected !== false;
  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
    host: new Set(),
    refresh: new Set(),
  };

  const fleetPage = (): CloudFleetPage => {
    if (!connected) {
      return {
        state: "no-key",
        error: null,
        entries: [],
        groups: emptyGroups(),
        laneOptions: [],
        archivedCount: 0,
        counts: { active: 0, lanes: 0, unlinked: 0, total: 0, archived: 0 },
        webhook: null,
        footer: "",
        fetchedAt: "2026-09-03T10:00:00.000Z",
      };
    }
    const visible = entries.filter((entry) => !entry.agent.archived);
    const groups = group(visible);
    return {
      state: visible.length === 0 ? "empty" : "list",
      error: null,
      entries: visible,
      groups,
      laneOptions: [{ id: "lane-1", name: "sync-fix" }],
      archivedCount: entries.filter((entry) => entry.agent.archived).length,
      counts: {
        active: groups.active.length,
        lanes: groups.lanes.length,
        unlinked: groups.unlinked.length,
        total: visible.length,
        archived: entries.filter((entry) => entry.agent.archived).length,
      },
      webhook: {
        status: "Endpoint ready",
        tone: "neutral",
        state: "ready",
        lastEvent: "2026-09-03 09:58 UTC",
        pendingDeliveries: 0,
        drainError: null,
        url: "https://relay.ade.dev/plugin/ade-cursor-cloud/webhook/cursor",
      },
      footer: `${visible.length} agent${visible.length === 1 ? "" : "s"} · updated just now`,
      fetchedAt: "2026-09-03T10:00:00.000Z",
    };
  };

  const agentPage = (agentId: string): CloudAgentPage => {
    const entry = entries.find((row) => row.agent.agentId === agentId) ?? null;
    return {
      entry,
      usage: entry
        ? { totalTokens: 128_000, inputTokens: 96_000, outputTokens: 32_000, costCents: 120, cost: "$1.20" }
        : null,
      runs: entry
        ? [{
          runId: entry.latestRunId ?? "run_1",
          status: entry.runStatus ?? null,
          modelId: entry.modelId,
          branch: entry.branch,
          prUrl: entry.prUrl,
          createdAt: "2026-09-02T10:00:00.000Z",
          age: "30m",
        }]
        : [],
      artifacts: entry
        ? [{ path: "reports/coverage.json", bytes: 4096, url: "https://files.cursor.com/a.json" }]
        : [],
      sessionId: entry?.ownership.sessionId ?? null,
      error: entry ? null : "It is not in this project's fleet.",
    };
  };

  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    /* Reads */
    pageFleet: () => fleetPage(),
    pageAgent: (args) => agentPage(String(args.agentId ?? "")),
    pageLaunchContext: () => (connected
      ? { ...CONNECTED_LAUNCH, ...(options.launch ?? {}) }
      : {
        ...CONNECTED_LAUNCH,
        ...(options.launch ?? {}),
        unavailable: "Add a Cursor API key in Settings → AI connections, then try again.",
      }),
    pageConnection: () => (connected
      ? { hasKey: true, apiKeyName: "ade", userEmail: "ada@example.com", message: null }
      : { hasKey: false, apiKeyName: null, userEmail: null, message: "No Cursor API key." }),

    /* Mutations */
    pageLaunch: () => ({
      ok: true,
      message: "Launched on Cursor Cloud.",
      agentId: "bc_new1",
      sessionId: "session-1",
      laneId: "lane-1",
    }),
    pageOpenInAde: () => ({
      ok: true,
      message: "Opened this cloud agent as a chat in ADE.",
      sessionId: "session-1",
    }),
    pageStopRun: (args) => {
      const entry = entries.find((row) => row.agent.agentId === args.agentId);
      if (entry) {
        entry.active = false;
        entry.status = "cancelled";
        entry.runStatus = "cancelled";
      }
      return { ok: true, message: "Stopped." };
    },
    pageFollowUp: () => ({ ok: true, message: "Sent to Cursor Cloud.", runId: "run_2" }),
    pagePullIntoLane: () => ({ ok: true, message: "Pulled cursor/fix-sync into the lane." }),
    pageArchiveAgent: (args) => {
      const entry = entries.find((row) => row.agent.agentId === args.agentId);
      if (entry) {
        entry.agent.archived = true;
        entry.status = "archived";
        entry.active = false;
      }
      return { ok: true, message: "Archived." };
    },
    pageUnarchiveAgent: (args) => {
      const entry = entries.find((row) => row.agent.agentId === args.agentId);
      if (entry) entry.agent.archived = false;
      return { ok: true, message: "Unarchived." };
    },
    pageDeleteAgent: (args) => {
      const index = entries.findIndex((row) => row.agent.agentId === args.agentId);
      if (index >= 0) entries.splice(index, 1);
      return { ok: true, message: "Deleted on Cursor." };
    },
    pageAckBadge: () => null,
    pageCopyWebhookUrl: () => ({ ok: true, message: "Webhook URL copied." }),
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-cursor-cloud",
    context: {
      subject: null,
      surfaceId: "fleet",
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
        return { autoOpenPr: false };
      },
      async set(key, value) {
        record("config.set", typeof key === "string" ? { key, value } : { values: key });
        return { autoOpenPr: false };
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
        return null;
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        return true;
      },
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      // The five host pickers. Each answers the FIRST row it was offered, so a
      // walk that opens one gets a deterministic choice and the page's own
      // inline fallback stays untested here — its own case installs a bridge
      // with `ui` cut down instead.
      async pickModel(request) {
        record("ui.pickModel", (request ?? {}) as Record<string, unknown>);
        return { id: request?.modelIds?.[0] ?? "composer-2", label: "Composer 2" };
      },
      async pickLane(request) {
        record("ui.pickLane", (request ?? {}) as Record<string, unknown>);
        return { id: request?.laneIds?.[0] ?? "lane-1", label: "sync-fix" };
      },
      async pickPermissionMode(request) {
        record("ui.pickPermissionMode", request as unknown as Record<string, unknown>);
        return { id: "default", label: "Manual" };
      },
      async pickReasoningEffort(request) {
        record("ui.pickReasoningEffort", request as unknown as Record<string, unknown>);
        return { id: "high", label: "High" };
      },
      async pickProvider() {
        record("ui.pickProvider", {});
        return { id: "cursor", label: "Cursor" };
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
    entries,
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
