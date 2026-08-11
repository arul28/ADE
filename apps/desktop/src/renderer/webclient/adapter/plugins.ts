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
import type {
  SyncPluginCollectionRow,
  SyncPluginSnapshotPayload,
} from "../../../shared/types/sync";
import type { AdapterInfra } from "./types";
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
 * The subset of the bridge's contract this transport can serve, expressed with
 * the bridge's own types. Members are optional because the getters below omit
 * the ones the connected host does not serve.
 */
export type WebPluginBridge = {
  readonly list?: () => Promise<InstalledPlugin[]>;
  readonly getPanel?: (input: { pluginId: string; panelId: string }) => Promise<PluginPanelRecord | null>;
  readonly getCollection?: (input: {
    pluginId: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }) => Promise<PluginCollectionRow[]>;
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
          snapshot: (payload) => finish(payload),
          error: () => finish(null),
        });
      } catch {
        finish(null);
      }
    });
  }

  const list = async (): Promise<InstalledPlugin[]> => {
    const result = await commands.call<{ plugins?: RemotePluginRecord[] } | null>(
      "plugins.list",
      {},
      { fallback: () => null, idempotent: true },
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
    // The panel stream carries every collection its schema binds, so the read
    // filters client-side rather than asking the host for a narrower slice —
    // the rows are already bounded by the host's snapshot ceiling.
    const snapshot = await readSnapshot(input.pluginId, input.collection);
    const rows = (snapshot?.rows ?? [])
      .filter((row) => row.collection === input.collection)
      .filter((row) => !input.keyPrefix || row.key.startsWith(input.keyPrefix))
      .map(toCollectionRow);
    return typeof input.limit === "number" ? rows.slice(0, Math.max(0, input.limit)) : rows;
  };

  const presence = async (): Promise<PluginPresenceRow[]> => {
    const result = await commands.call<{ machines?: RemotePresenceRow[] } | null>(
      "plugins.presenceMatrix",
      {},
      { fallback: () => null, idempotent: true },
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

  // Mutations pass `idempotent: false`, which is what makes an unserved action
  // throw `UnsupportedRemoteCommandError` instead of resolving a fallback: no
  // request was sent, so reporting success would report an install that never
  // happened. The getters below already hide these members on a host that
  // cannot serve them; this is the second line of defence for the window
  // between a host handoff and the next descriptor refresh.
  const install = async (input: PluginInstallRequest): Promise<PluginInstallResult> => {
    const record = await commands.call<RemotePluginRecord>(
      "plugins.install",
      // The bridge names a SOURCE STRING; the wire names a source KIND. A
      // filesystem path cannot be installed from a browser — there is no shared
      // filesystem — so a non-URL source is a git source or nothing.
      {
        kind: "git",
        url: input.source,
        ...(input.version ? { ref: input.version } : {}),
        // Forwarded by the host to the machine it names, so the Marketplace's
        // coverage matrix can install onto a computer other than this one.
        ...(input.machineKey ? { machineKey: input.machineKey } : {}),
      },
      { fallback: unavailableOnHost("Installing plugins isn't available on this computer."), idempotent: false },
    );
    return {
      pluginId: record.pluginId,
      version: record.version,
      displayName: record.displayName || record.pluginId,
    };
  };

  const uninstall = async (input: { pluginId: string; machineKey?: string }): Promise<unknown> =>
    await commands.call<unknown>("plugins.uninstall", {
      pluginId: input.pluginId,
      ...(input.machineKey ? { machineKey: input.machineKey } : {}),
    }, {
      fallback: unavailableOnHost("Removing plugins isn't available on this computer."),
      idempotent: false,
    });

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
  };

  const onChanged = (listener: (event: PluginChangeEvent) => void): (() => void) =>
    events.on("pluginsInvalidated", () => {
      // The invalidation hint names tables, not what changed within them.
      // "collections" is the widest of the kinds a subscriber refetches on, so
      // reporting it is the honest coarse answer; claiming "installs" would
      // under-refresh every panel.
      listener({ kind: "collections" });
    });

  return markHonestSurface<WebPluginBridge>({
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
      return commands.hasAction("plugins.presenceMatrix") ? presence : undefined;
    },
    get onChanged() {
      return onChanged;
    },
  });
}
