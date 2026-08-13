import type {
  InstalledPlugin,
  PluginChangeEvent,
  PluginCollectionRow,
  PluginInstallRequest,
  PluginInstallResult,
  PluginPanelRecord,
  PluginPresenceRow,
  PluginRuntimeStatus,
  PluginTabDescriptor,
} from "../../lib/pluginRuntimeBridge";
import {
  PLUGIN_PRESENCE_MATRIX_ACTION,
  type SyncPluginCollectionRow,
  type SyncPluginSnapshotPayload,
} from "../../../shared/types/sync";
import type { AdapterInfra } from "./types";
import { codedError } from "../../../shared/codedError";
import { markHonestSurface } from "./infra/proxy";
import { unavailableOnHost } from "./misc";

/**
 * Web adapter surface for plugins.
 *
 * This object IS `window.ade.plugin` in the hosted web client, and
 * `renderer/lib/pluginRuntimeBridge.ts` is its only consumer. That module
 * decides what the Marketplace may offer by probing
 * `typeof namespace.member === "function"`, which makes two things load-bearing
 * here in a way they are not for any other adapter namespace:
 *
 * 1. **Member names and argument shapes must match the bridge exactly.** Every
 *    bridge member takes ONE object. A positional signature does not fail — it
 *    binds `{pluginId, enabled}` to the first parameter and quietly does the
 *    wrong thing, which for `setEnabled` means every toggle routes to the same
 *    branch. The types below are imported FROM the bridge so a future change on
 *    either side is a compile error rather than a silent misroute.
 *
 * 2. **A member that cannot work must be ABSENT, not present-and-failing.** The
 *    capability probe reads absence as "this host can't do that" and the UI
 *    hides the affordance. A member that exists and rejects makes the UI offer
 *    a button that always fails. So the members below are getters that return
 *    `undefined` unless the connected host actually serves the backing action —
 *    re-evaluated per access, because which host is connected changes while the
 *    page is open.
 *
 * The namespace is registered under both `plugin` (the bridge's first choice,
 * matching the preload's single `plugin` action domain) and `plugins`.
 *
 * It is also marked honest, so `withFallbackProxy` leaves it alone. Without
 * that mark every unimplemented member would come back as a truthy callable and
 * the probe would report ALL capabilities available on web — see
 * `markHonestSurface`.
 */

/** How long a one-shot panel read waits for its snapshot before giving up. */
const PANEL_READ_TIMEOUT_MS = 8_000;

/**
 * How long a panel snapshot's rows stay readable by a collection read, and how
 * many panels' rows are kept. Sized for the one flow that exists: a panel read
 * immediately followed by one collection read per binding in that panel's
 * schema (`PluginPanelHost`). Long enough that a slow render still finds them,
 * short enough that a collection read never answers from a stale panel.
 */
const PANEL_ROWS_TTL_MS = 15_000;
const PANEL_ROWS_MAX_PANELS = 32;

/**
 * The typed refusal the desktop path raises when a host has no plugin service —
 * `PLUGIN_SERVICE_UNAVAILABLE_CODE` in
 * `ade-cli/src/services/plugins/pluginInstallServiceRef.ts`. Copied rather than
 * imported: the renderer does not import from the CLI. It is spelled the same
 * on purpose, so a reader can tell "this computer has no plugin support" from
 * "no plugins are installed" no matter which transport answered.
 */
const PLUGINS_UNAVAILABLE_CODE = "plugins_unavailable";

/**
 * A source that is a bare plugin id rather than a place to fetch from.
 *
 * Kept byte-identical to `isValidPluginId` in `shared/plugins/manifest.ts`. An
 * id here is not a guess about what the reader meant: the Marketplace sends one
 * for a plugin ADE bundles, whose honest source is the copy on the target
 * machine's disk, not a repository URL that has to resolve over the network.
 */
const PLUGIN_ID_SOURCE = /^[a-z][a-z0-9-]{0,63}$/;

/** A read this transport cannot serve. Never an empty result — see above. */
function pluginsUnavailable(): () => never {
  return () => {
    throw codedError("Plugins are not available on this computer.", PLUGINS_UNAVAILABLE_CODE);
  };
}

/**
 * The subset of the bridge's contract this transport can serve, expressed with
 * the bridge's own types. Members are optional because the getters below omit
 * the ones the connected host does not serve.
 */
export type WebPluginBridge = {
  /**
   * Marks a hosted client that can actually render a plugin's own tab —
   * `pluginTabsAvailable()` in `renderer/lib/webClientMode.ts` reads it and
   * offers the tab only when it is strictly `true`. It exists because on web
   * every member "exists" (the fallback proxy answers unimplemented members
   * with a stub callable), so a `typeof member === "function"` probe proves
   * nothing there and a marker the adapter sets deliberately is the only
   * honest signal.
   */
  readonly servesPluginPanels?: boolean;
  /**
   * Whether this transport can act on a machine OTHER than the connected one.
   *
   * A declared value, not something the bridge infers from `install` and
   * `presence` being callable — see the marker's note in
   * `renderer/lib/pluginRuntimeBridge.ts`. It is true here for a reason
   * specific to this transport: the calls below FORWARD `machineKey` to the
   * host, which routes it and refuses loudly when it cannot. The desktop
   * preload publishes false because it rejects `machineKey` outright.
   */
  readonly remoteInstall?: boolean;
  readonly list?: () => Promise<InstalledPlugin[]>;
  readonly getPanel?: (input: { pluginId: string; panelId: string }) => Promise<PluginPanelRecord | null>;
  readonly getCollection?: (input: {
    pluginId: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }) => Promise<PluginCollectionRow[]>;
  /**
   * Run a plugin's own handler — every button, form submit and list action a
   * panel draws lands here.
   *
   * MUTATING, so it never degrades to a fallback: a panel button that resolves
   * quietly on a host that cannot run it is exactly the failure the socket and
   * vocabulary contracts exist to prevent. Without this member the shared
   * `invokePluginAction` throws "This build has no plugin support", which is
   * what every panel button did on web before it existed.
   */
  readonly invoke?: (input: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Promise<unknown>;
  /**
   * A plugin's manifest as far as this transport can see it: its socket
   * declarations, and nothing else.
   *
   * Deliberately PARTIAL, and the partiality is the contract. The socket layer
   * is the only reader that can use this — `contributionsFromSource` reads
   * `manifest.sockets` and no other field — and the Marketplace's reader runs
   * what it gets through `parsePluginManifest`, which REJECTS an object missing
   * `name`/`description`/`vocabVersion`. That rejection is the desired outcome,
   * not a near miss: settings, readme and runtime actions genuinely are not
   * readable over sync, so the detail page must keep showing nothing rather
   * than a half-filled manifest that looks complete. A future edit that
   * "completes" this object would silently turn those surfaces on with
   * fabricated content; the test pinning the rejection is there to say so.
   */
  readonly getManifest?: (input: { pluginId: string }) => Promise<unknown | null>;
  /** Host-joined `plugin_contributions` rows for one surface. */
  readonly listContributions?: (input: {
    surface: string;
    entityKind?: string;
    entityIds?: string[];
  }) => Promise<unknown>;
  readonly install?: (input: PluginInstallRequest) => Promise<PluginInstallResult>;
  readonly uninstall?: (input: { pluginId: string; machineKey?: string }) => Promise<unknown>;
  readonly setEnabled?: (input: {
    pluginId: string;
    enabled: boolean;
    machineKey?: string;
  }) => Promise<void>;
  readonly presence?: () => Promise<PluginPresenceRow[]>;
  readonly onChanged?: (listener: (event: PluginChangeEvent) => void) => () => void;
};

/** What `plugins.list` returns over the wire. Wave A's record, not the UI's. */
type RemotePluginRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  displayName: string;
  icon: string;
  accent: string;
  source: string;
  installedAt: string;
  /** Optional by contract — absent means the host could not see it. */
  status?: PluginRuntimeStatus;
  tabs?: PluginTabDescriptor[];
  theme?: { displayName: string; tokens: Record<string, unknown> } | null;
  /**
   * Manifest socket declarations, as `SyncPluginRecordSocket` sends them.
   * Absent from a host that could not read the manifest — see `getManifest`.
   */
  sockets?: unknown[];
  /** Manifest socket ids the user switched off; absent means none are. */
  disabledContributions?: string[];
};

/** One row of the account-wide coverage matrix, as `plugins.presenceMatrix` sends it. */
type RemotePresenceRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  online: boolean;
  isThisMachine: boolean;
};

function toInstalledPlugin(record: RemotePluginRecord): InstalledPlugin {
  return {
    pluginId: record.pluginId,
    displayName: record.displayName || record.pluginId,
    version: record.version,
    enabled: record.enabled,
    icon: record.icon || null,
    accent: record.accent || null,
// Populated when the host sends them, and "unknown" when it does not.
    // A host that omits `status` has not told us whether a child process is up,
    // and "none" is the honest reading of that — inferring "running" from
    // `enabled` would put a green dot next to a crashed plugin.
    status: record.status ?? "none",
    // Tabs and themes come from the manifest on disk, which a browser peer never
    // sees for itself; absent means "none known here" rather than "none exist".
    tabs: record.tabs ?? [],
    theme: record.theme
      ? { displayName: record.theme.displayName, tokens: record.theme.tokens as never }
      : null,
    // Forwarded, because the STATIC half of the socket layer filters on it
    // client-side (`contributionsFromSource`) rather than trusting the host to
    // have done it. Dropping it here would draw manifest sockets the user has
    // already switched off — and only on web, since desktop reads the same
    // field straight off its own registry.
    ...(record.disabledContributions ? { disabledContributions: record.disabledContributions } : {}),
    // The keybinding matrix's tie-break: first installed keeps a contested
    // chord. Forwarded even though this transport carries no `keybindings` yet,
    // because the ordering is what stops the answer from changing per boot, and
    // the sync record already knows it.
    installedAt: record.installedAt,
  };
}

function toCollectionRow(row: SyncPluginCollectionRow): PluginCollectionRow {
  let value: unknown = null;
  try {
    value = JSON.parse(row.valueJson) as unknown;
  } catch {
    // Plugin-authored content. A malformed value is one unreadable row, never a
    // thrown read that loses the whole collection.
    value = null;
  }
  return { key: row.key, value };
}

export function createPluginsNamespace(infra: AdapterInfra): WebPluginBridge {
  const { client, commands, events } = infra;

  /**
   * Rows from the panels this client has read recently, keyed by plugin+panel.
   *
   * The bridge asks for a collection by NAME — `{pluginId, collection}` — with
   * no panel in the input, and the sync protocol has no such read: the only way
   * a browser peer ever sees collection rows is `plugin_subscribe`, which is
   * keyed by PANEL. Subscribing with the collection name in the panel slot is
   * what the first cut did, and it matched no panel, waited out the timeout and
   * answered empty on a plugin whose data was right there.
   *
   * So the contract is: a collection read is served from the last panel read
   * for that plugin. That is honest because a panel snapshot already carries
   * every collection its schema binds (`buildPluginPanelView` on the host), and
   * complete because `PluginPanelHost` reads the panel and only then reads the
   * bindings that panel declared. A collection read with no panel read behind
   * it has nothing to answer from and says so by answering empty.
   */
  const panelRows = new Map<string, { rows: SyncPluginCollectionRow[]; at: number }>();

  // The separator is written as an ESCAPE, never as the byte itself: a literal
  // NUL in a source file makes git treat the whole file as binary, so it stops
  // diffing and every review of it becomes an opaque blob. Same convention, and
  // the same reason, as the cache keys in `infra/commandCaller.ts`.
  const stashKey = (pluginId: string, panelId: string): string => `${pluginId}\u0000${panelId}`;

  const stashRows = (pluginId: string, panelId: string, rows: SyncPluginCollectionRow[]): void => {
    const now = Date.now();
    for (const [key, value] of panelRows) {
      if (now - value.at > PANEL_ROWS_TTL_MS) panelRows.delete(key);
    }
    panelRows.delete(stashKey(pluginId, panelId));
    panelRows.set(stashKey(pluginId, panelId), { rows, at: now });
    while (panelRows.size > PANEL_ROWS_MAX_PANELS) {
      const oldest = panelRows.keys().next().value as string | undefined;
      if (!oldest) break;
      panelRows.delete(oldest);
    }
  };

  /** Rows for one collection, newest panel read first. */
  const stashedRows = (pluginId: string, collection: string): SyncPluginCollectionRow[] => {
    const now = Date.now();
    const prefix = `${pluginId}\u0000`;
    const fresh = [...panelRows.entries()]
      .filter(([key, value]) => key.startsWith(prefix) && now - value.at <= PANEL_ROWS_TTL_MS)
      .reverse();
    for (const [, value] of fresh) {
      // An empty collection contributes no rows to a snapshot, so "this panel
      // had none" and "this panel does not bind it" are the same bytes here.
      // Falling through to the next panel costs nothing in the first case and
      // is the whole point in the second.
      const rows = value.rows.filter((row) => row.collection === collection);
      if (rows.length > 0) return rows;
    }
    return [];
  };

  /**
   * One snapshot from the view-scoped panel stream, then unsubscribe.
   *
   * The bridge asks for panels and collections as one-shot reads, and a browser
   * peer has no local replica to read them from — the subscription IS the only
   * source. Taking the first snapshot and dropping the subscription gives the
   * bridge exactly what it asked for without leaving a stream open behind a
   * call that never promised one.
   */
  async function readSnapshot(
    pluginId: string,
    panelId: string,
  ): Promise<SyncPluginSnapshotPayload | null> {
    return await new Promise<SyncPluginSnapshotPayload | null>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (value: SyncPluginSnapshotPayload | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The unsubscribe may not be assigned yet if the host answered
        // synchronously; defer so the stream is always torn down.
        queueMicrotask(() => unsubscribe?.());
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), PANEL_READ_TIMEOUT_MS);
      try {
        unsubscribe = client.subscribePluginPanel(pluginId, panelId, {
          snapshot: (payload) => {
            // Every snapshot carries the rows for every collection the panel
            // binds; keeping them is what lets the collection reads that follow
            // be answered at all.
            stashRows(pluginId, panelId, payload.rows ?? []);
            finish(payload);
          },
          error: () => finish(null),
        });
      } catch {
        finish(null);
      }
    });
  }

  // Reads refuse with the typed `plugins_unavailable` rather than resolving an
  // empty list. The two are not the same fact: "this computer has no plugin
  // support" is a state the Marketplace can explain, and flattening it to `[]`
  // renders it as "you have no plugins installed" — an invitation to install
  // one on a host that cannot.
  const list = async (): Promise<InstalledPlugin[]> => {
    const result = await commands.call<{ plugins?: RemotePluginRecord[] }>(
      "plugins.list",
      {},
      { fallback: pluginsUnavailable(), idempotent: true },
    );
    return (result?.plugins ?? []).map(toInstalledPlugin);
  };

  const getPanel = async (input: { pluginId: string; panelId: string }): Promise<PluginPanelRecord | null> => {
    const snapshot = await readSnapshot(input.pluginId, input.panelId);
    const panel = snapshot?.panel ?? null;
    if (!panel) return null;
    let schema: unknown = null;
    try {
      schema = JSON.parse(panel.schemaJson) as unknown;
    } catch {
      // The renderer's vocabulary validator turns a null schema into its
      // designed fallback card; throwing here would blank the panel instead.
      schema = null;
    }
    return {
      pluginId: panel.pluginId,
      panelId: panel.panelId,
      title: panel.title || null,
      schema,
      vocabVersion: panel.vocabVersion,
      updatedAt: panel.updatedAt || null,
    };
  };

  const getCollection = async (input: {
    pluginId: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }): Promise<PluginCollectionRow[]> => {
    // Served from the panel snapshot this client already read — see `panelRows`
    // above for why there is no host read to make here. `keyPrefix` and `limit`
    // are applied client-side; the rows are already bounded by the host's
    // per-snapshot ceiling, so this narrows an answer rather than trusting one.
    const rows = stashedRows(input.pluginId, input.collection)
      .filter((row) => !input.keyPrefix || row.key.startsWith(input.keyPrefix))
      .map(toCollectionRow);
    return typeof input.limit === "number" ? rows.slice(0, Math.max(0, input.limit)) : rows;
  };

  /**
   * The install list again, but shared across a burst of reads.
   *
   * `getManifest` is called once per installed plugin the moment any socket
   * surface first reveals (`readPluginSocketSources` fans out over the whole
   * list), and each of those would otherwise be its own `plugins.list` round
   * trip for the same answer. A short TTL is what makes the burst one request:
   * `commands.call` only consults its coalescing cache when `cacheTtlMs` is
   * set, so the plain `list` above — which callers expect to be live — keeps
   * its exact semantics and this is a separate, deliberately cached read.
   */
  const listCached = async (): Promise<RemotePluginRecord[]> => {
    const result = await commands.call<{ plugins?: RemotePluginRecord[] }>(
      "plugins.list",
      {},
      { fallback: () => ({ plugins: [] }), idempotent: true, cacheTtlMs: 5_000 },
    );
    return result?.plugins ?? [];
  };

  const getManifest = async (input: { pluginId: string }): Promise<unknown | null> => {
    const record = (await listCached()).find((entry) => entry.pluginId === input.pluginId);
    if (!record) return null;
    // Absent `sockets` means the host could not read the manifest, which is a
    // different fact from "declares none" and has to stay different here: null
    // leaves the socket layer with no source, where `{sockets: []}` would be
    // this transport asserting the plugin contributes nothing.
    if (!record.sockets) return null;
    return { sockets: record.sockets };
  };

  const listContributions = async (input: {
    surface: string;
    entityKind?: string;
    entityIds?: string[];
  }): Promise<unknown> => {
    const result = await commands.call<{ contributions?: unknown[] }>(
      "plugins.contributions",
      {
        surface: input.surface,
        ...(input.entityKind ? { entityKind: input.entityKind } : {}),
        ...(input.entityIds && input.entityIds.length > 0 ? { entityIds: input.entityIds } : {}),
      },
      // A read, so an older host degrades to "no dynamic contributions" — a
      // quieter surface, which is what `readPluginContributionRows` already
      // expects and renders. The static half still arrives via `getManifest`.
      { fallback: () => ({ contributions: [] }), idempotent: true, cacheTtlMs: 2_000 },
    );
    return result?.contributions ?? [];
  };

  const presence = async (): Promise<PluginPresenceRow[]> => {
    const result = await commands.call<{ machines?: RemotePresenceRow[] }>(
      PLUGIN_PRESENCE_MATRIX_ACTION,
      {},
      { fallback: pluginsUnavailable(), idempotent: true },
    );
    return (result?.machines ?? []).map((row) => ({
      machineKey: row.machineKey,
      machineName: row.machineName || row.machineKey,
      pluginId: row.pluginId,
      version: row.version,
      enabled: row.enabled,
      online: row.online,
      isThisMachine: row.isThisMachine,
    }));
  };

  /**
   * A change this client caused, reported to its own subscribers.
   *
   * The host's `pluginsInvalidated` broadcast is what normally drives a
   * refetch, and it arrives when the plugin tables replicate — which is after
   * the install call resolves, and not at all when the install landed on ANOTHER
   * machine (its rows reach this client through the directory, on its own
   * schedule). The coverage rail's read is cached for a few seconds either way,
   * so without this the reader watches a successful install for several seconds
   * with nothing to show for it.
   */
  const changeListeners = new Set<(event: PluginChangeEvent) => void>();
  const announceLocalChange = (event: PluginChangeEvent): void => {
    commands.invalidateCache(["plugins."]);
    for (const listener of [...changeListeners]) {
      try {
        listener(event);
      } catch {
        // One subscriber's render failure must not stop the others hearing it.
      }
    }
  };

  /**
   * Undo the `plugins.invoke` envelope so a panel sees what the handler
   * returned.
   *
   * The remote command wraps every handler return as
   * `{ok: true, message?, result}` — a shape the phone decodes — while the
   * desktop preload hands `plugin.invoke`'s return back untouched. The renderer
   * that reads it is the same renderer in both places, and it reads the
   * handler's own keys: `readPluginActionNavigation` looks for `navigate`,
   * `readPluginActionComposerEdit` for `composer`. Left wrapped, every
   * `{navigate:{…}}` a plugin returned would be one key too deep and silently
   * do nothing.
   *
   * The unwrap is keyed on the envelope's own construction — `ok === true` AND
   * a `result` key present, which is exactly what the host writes and never
   * omits. A handler that itself returns that pair is indistinguishable, and
   * this prefers the transport reading: the envelope is always there, a
   * handler that mimics it is a coincidence.
   */
  const unwrapInvokeResult = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.ok !== true || !("result" in record)) return value;
    // A handler that answered nothing sends `result: null`, and the host may
    // have put its own `message` beside it. Keeping the envelope in that case
    // is what lets a caller show the message rather than a bare null.
    return record.result ?? (typeof record.message === "string" ? value : null);
  };

  const invoke = async (input: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> => {
    // `actionId` is the name the remote command reads first; the payload rides
    // under `payload`, which is where `plugins.invoke` looks for a handler's
    // arguments. Sending them as `args` — the desktop preload's spelling — is
    // not a transport error, it is an invoke that reaches the handler with an
    // empty argument object, so every form submits blank.
    const envelope = await commands.call<unknown>(
      "plugins.invoke",
      {
        pluginId: input.pluginId,
        actionId: input.action,
        ...(input.args ? { payload: input.args } : {}),
      },
      {
        fallback: unavailableOnHost("Running plugin actions isn't available on this computer."),
        idempotent: false,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      },
    );
    return unwrapInvokeResult(envelope);
  };

  // Mutations pass `idempotent: false`, which is what makes an unserved action
  // throw `UnsupportedRemoteCommandError` instead of resolving a fallback: no
  // request was sent, so reporting success would report an install that never
  // happened. The getters below already hide these members on a host that
  // cannot serve them; this is the second line of defence for the window
  // between a host handoff and the next descriptor refresh.
  const install = async (input: PluginInstallRequest): Promise<PluginInstallResult> => {
    // The bridge names a SOURCE STRING; the wire names a source KIND, and this
    // is where one becomes the other.
    //
    // A bare plugin id is `kind: "registry"` — the id names a plugin, not a
    // place, and the machine performing the install is the only one that can
    // resolve it (from the directory, or from the copy it bundles). Sending it
    // as a git URL would work only by accident of the host being forgiving, and
    // would fail with "unsupported git URL" where it should say "this computer
    // does not have that plugin".
    //
    // Anything else is `kind: "git"`. A filesystem path is deliberately not
    // reachable from a browser: there is no shared filesystem, so a path here
    // would name a file on the wrong computer.
    //
    // VERSION is carried in both branches and dropped in neither, because a
    // path that drops it silently installs whatever the default branch holds
    // today. What it MEANS differs by kind, which is the whole reason the two
    // fields have different names: for git it is the `ref` — a release is cut
    // from a tag, so checking that tag out is the only thing an installer can
    // do with a version — and for a registry id it is the `version`, which the
    // host resolves against the directory before it has a ref at all.
    const source = input.source.trim();
    const byId = PLUGIN_ID_SOURCE.test(source);
    const record = await commands.call<RemotePluginRecord>(
      "plugins.install",
      {
        ...(byId
          ? { kind: "registry", pluginId: source, ...(input.version ? { version: input.version } : {}) }
          : { kind: "git", url: source, ...(input.version ? { ref: input.version } : {}) }),
        // Forwarded by the host to the machine it names, so the Marketplace's
        // coverage matrix can install onto a computer other than this one.
        ...(input.machineKey ? { machineKey: input.machineKey } : {}),
      },
      { fallback: unavailableOnHost("Installing plugins isn't available on this computer."), idempotent: false },
    );
    announceLocalChange({ kind: "installs", pluginId: record.pluginId });
    return {
      pluginId: record.pluginId,
      version: record.version,
      displayName: record.displayName || record.pluginId,
    };
  };

  const uninstall = async (input: { pluginId: string; machineKey?: string }): Promise<unknown> => {
    const result = await commands.call<unknown>("plugins.uninstall", {
      pluginId: input.pluginId,
      ...(input.machineKey ? { machineKey: input.machineKey } : {}),
    }, {
      fallback: unavailableOnHost("Removing plugins isn't available on this computer."),
      idempotent: false,
    });
    announceLocalChange({ kind: "installs", pluginId: input.pluginId });
    return result;
  };

  const setEnabled = async (input: {
    pluginId: string;
    enabled: boolean;
    machineKey?: string;
  }): Promise<void> => {
    // `machineKey` is forwarded, not dropped. The host routes it to that
    // machine and refuses loudly if it cannot reach it — the one outcome to
    // avoid is toggling the plugin HERE when the reader pressed the button on
    // another machine's row.
    await commands.call<unknown>(
      input.enabled ? "plugins.enable" : "plugins.disable",
      {
        pluginId: input.pluginId,
        ...(input.machineKey ? { machineKey: input.machineKey } : {}),
      },
      {
        fallback: unavailableOnHost("Turning plugins on or off isn't available on this computer."),
        idempotent: false,
      },
    );
    announceLocalChange({ kind: "installs", pluginId: input.pluginId });
  };

  const onChanged = (listener: (event: PluginChangeEvent) => void): (() => void) => {
    changeListeners.add(listener);
    const stopHostEvents = events.on("pluginsInvalidated", () => {
      // The invalidation hint names tables, not what changed within them, so
      // BOTH kinds are reported rather than the widest one. Subscribers filter
      // by kind: the panel hosts refetch on "collections" and ignore the rest,
      // and the registry — which decides whether a gated surface exists at all
      // — refetches on "installs" and ignores the rest. Reporting only
      // "collections" left an open web tab showing a tab whose plugin had just
      // been uninstalled on the machine.
      listener({ kind: "collections" });
      listener({ kind: "installs" });
    });
    return () => {
      changeListeners.delete(listener);
      stopHostEvents();
    };
  };

  return markHonestSurface<WebPluginBridge>({
    /**
     * Gated on `plugins.list` rather than declared unconditionally.
     *
     * There is no descriptor for the panel subscription itself — panels ride
     * `plugin_subscribe`, not a remote command — so the honest proxy is the
     * command that ships in the same release: a host advertising `plugins.list`
     * is a host from the plugin release train, and it is also the read that
     * says WHICH plugins have tabs. A host without it can serve neither, and a
     * tab offered there would be an empty shell behind a nav item. Re-evaluated
     * per access, because a project handoff can change the connected host while
     * the page stays open.
     */
    get servesPluginPanels() {
      return commands.hasAction("plugins.list");
    },
    /**
     * Both halves: the action that performs the work, and the matrix that names
     * the machine to perform it on. Without the matrix there is no other
     * machine to point at, so offering the arm would be offering a dead control.
     */
    get remoteInstall() {
      return commands.hasAction("plugins.install") && commands.hasAction(PLUGIN_PRESENCE_MATRIX_ACTION);
    },
    get list() {
      return commands.hasAction("plugins.list") ? list : undefined;
    },
    // Panels ride the subscribe protocol rather than a remote command, so there
    // is no descriptor to probe. It ships in the same release as the plugin
    // tables; an older host simply never answers and the read resolves null.
    get getPanel() {
      return getPanel;
    },
    get getCollection() {
      return getCollection;
    },
    get invoke() {
      return commands.hasAction("plugins.invoke") ? invoke : undefined;
    },
    // Both halves of the socket taxonomy, gated separately because a host can
    // serve one without the other: `sockets` rides the `plugins.list` record,
    // while dynamic rows need their own command. A surface with only the static
    // half draws a plugin's declared badges and menu items and simply has
    // nothing per-entity to add, which is the correct degradation rather than a
    // reason to withhold both.
    get getManifest() {
      return commands.hasAction("plugins.list") ? getManifest : undefined;
    },
    get listContributions() {
      return commands.hasAction("plugins.contributions") ? listContributions : undefined;
    },
    get install() {
      return commands.hasAction("plugins.install") ? install : undefined;
    },
    get uninstall() {
      return commands.hasAction("plugins.uninstall") ? uninstall : undefined;
    },
    get setEnabled() {
      // Both halves or nothing: the bridge treats `setEnabled` as able to do
      // either direction, and a host serving only `plugins.enable` would give a
      // working "turn on" and a failing "turn off".
      return commands.hasAction("plugins.enable") && commands.hasAction("plugins.disable")
        ? setEnabled
        : undefined;
    },
    get presence() {
      return commands.hasAction(PLUGIN_PRESENCE_MATRIX_ACTION) ? presence : undefined;
    },
    get onChanged() {
      return onChanged;
    },
  });
}
