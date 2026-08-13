/**
 * The `window.ade.plugins` namespace.
 *
 * Lifted out of `preload.ts` for the same reason `orchestrationBridge.ts` was:
 * twenty near-identical four-line members are noise in a file that is mostly
 * routing, and gathering them here gives the namespace one place to be CHECKED.
 * `contextBridge.exposeInMainWorld` takes `any`, so nothing in the build was
 * verifying that what the preload publishes matches what the UI calls — the
 * `satisfies` at the bottom of this file is that check, and it is the point of
 * the extraction rather than a side effect of it.
 *
 * Two rules hold across every member:
 *
 * - **Plugins route STRICTLY.** The Electron main process keeps a dormant
 *   `AppContext` whose services are null, so the silently-falling-back call
 *   family would answer a routing failure with a crash or a wrong empty result.
 *   Every member goes through the strict router and lets the typed
 *   `plugins_unavailable` reach the UI, which degrades on it honestly.
 * - **A member with no action behind it is ABSENT, not stubbed.** The bridge
 *   reads a missing member as "this host cannot do it"; a stub reads as
 *   "supported" and produces a button that always fails.
 */

import { IPC } from "../shared/ipc";
import type {
  PluginClientChangeEvent,
  PluginClientInstalled,
  PluginClientInstallRequest,
  PluginClientInstallResult,
  PluginClientRuntimeStatus,
  PluginClientUsageRow,
  PluginCollectionRow as PluginHostCollectionRow,
  PluginContributionRecord,
  PluginDetail,
  PluginLogEntry,
  PluginMarketplaceIndex,
  PluginPanelRecord,
  PluginPresenceMachineRow,
  PluginRuntimeStatus as PluginHostRuntimeStatus,
  PluginSourceInspection,
  PluginSummary,
  PluginUsageSummary,
} from "../shared/plugins/sdk";

/**
 * The host reports lifecycle detail the plugin surfaces do not draw: a plugin
 * that never started and one that was stopped are the same dot, and a restart
 * reads as a start.
 *
 * The two arms that look alike and are not:
 *
 * - `idle` is a plugin that HAS a child to run and is not running it — never
 *   started, or stopped and not restarted. It maps to `stopped`, which is what
 *   puts a Restart button in front of the reader. Folding it into `none`
 *   instead says "this plugin runs no code", and the surfaces answer that by
 *   offering nothing to press.
 * - `no-entry` is `none`: that plugin genuinely has no child. A theme has
 *   nothing to restart and must not be offered a restart.
 *
 * `toRecordStatus` in `main/services/plugins/pluginInstallServiceAdapter.ts`
 * makes exactly this mapping for the sync record every remote peer reads. The
 * two must agree: without the `idle` arm here, one plugin showed a Restart
 * button on a phone and no control at all in the window it was installed from.
 */
export function toBridgeRuntimeStatus(
  status: PluginHostRuntimeStatus,
): PluginClientRuntimeStatus {
  switch (status) {
    case "running":
      return "running";
    case "starting":
    case "restarting":
      return "starting";
    case "crashed":
      return "crashed";
    case "stopped":
    case "idle":
      return "stopped";
    case "no-entry":
      return "none";
    default:
      // A status this build has not learned about yet. `none` is the honest
      // answer: it draws no dot and offers no control, rather than guessing at
      // a lifecycle the host has not explained.
      return "none";
  }
}

export function toInstalledPlugin(summary: PluginSummary): PluginClientInstalled {
  return {
    pluginId: summary.pluginId,
    displayName: summary.displayName,
    version: summary.version,
    enabled: summary.enabled,
    icon: summary.icon,
    accent: summary.accent,
    status: toBridgeRuntimeStatus(summary.status),
    // `webview` joins `tab` in the rail rather than getting a list of its own:
    // both are full-page surfaces at `/plugin/<id>`, and only the page itself
    // cares which one it draws. A client that filtered on `kind === "tab"`
    // would silently drop every custom-UI plugin from the rail.
    tabs: summary.surfaces
      .filter((surface) => surface.kind === "tab" || surface.kind === "webview")
      .map((surface) => ({
        id: surface.id,
        title: surface.title,
        kind: surface.kind === "webview" ? "webview" as const : "tab" as const,
        panelId: surface.panelId,
        icon: surface.icon ?? null,
        ...(surface.entryHtml ? { entryHtml: surface.entryHtml } : {}),
        // Which core tab this plugin replaces, when it replaces one. Carried
        // explicitly rather than inferred: the extraction pilot gates a builtin
        // tab on it, and inferring the owner from a name would be a guess about
        // which of two tabs the user sees.
        ...(surface.builtin ? { builtin: surface.builtin } : {}),
      })),
    theme: summary.theme,
    // The per-contribution kill switch is stored per plugin in the machine
    // install registry, and the UI is the only thing that reads it. Dropping it
    // here left every switched-off contribution rendering: the socket layer got
    // an absent list, which correctly means "nothing is off".
    disabledContributions: summary.disabledContributions ?? [],
    // Search providers ride the list because the palette queries every one of
    // them on a debounced keystroke: it needs the whole set in hand before the
    // first character, and asking each plugin for its manifest at that moment
    // would be an N-call fan-out inside a 300ms budget. Omitted when the plugin
    // declares none, so the renderer's `?? []` and "absent means none" agree.
    ...(summary.searchProviders && summary.searchProviders.length > 0
      ? { searchProviders: summary.searchProviders }
      : {}),
    // Same reasoning for the automations rule builder: it draws ONE trigger
    // picker and ONE step picker over every installed plugin's declarations, so
    // it needs them all before it can render either — and it must be able to
    // name a plugin whose child is not running, which is most of them.
    ...(summary.automationTriggers && summary.automationTriggers.length > 0
      ? { automationTriggers: summary.automationTriggers }
      : {}),
    ...(summary.automationSteps && summary.automationSteps.length > 0
      ? { automationSteps: summary.automationSteps }
      : {}),
    // Keyboard shortcuts ride the list for a reason the two above only imply:
    // the collision matrix is a decision ACROSS plugins, so a per-plugin read
    // would let the same manifest win or lose depending on which reads had
    // landed. `installedAt` travels with them because it is the tie-break —
    // first installed keeps the chord — and it is the one field on the summary
    // the renderer has no other way to learn.
    ...(summary.keybindings && summary.keybindings.length > 0
      ? { keybindings: summary.keybindings }
      : {}),
    installedAt: summary.installedAt,
  };
}

export function toPluginUsageRows(summary: PluginUsageSummary): PluginClientUsageRow[] {
  return summary.entries.map((entry) => ({
    pluginId: entry.pluginId,
    collectionBytes: entry.collectionBytes,
    collectionBudgetBytes: summary.budgets.collectionBytesPerPlugin,
    rows: entry.collectionRows,
    rowBudget: summary.budgets.collectionRowsPerPlugin,
    // Cumulative, and named so. The host publishes no windowed number, and a
    // field called `24h` carrying a lifetime total is a lie the UI then repeats.
    syncBytesTotal: entry.syncBytesOut,
  }));
}

/** Wire shape of the daemon's event. Kept local: this is a decode, not a model. */
export function toPluginChangeEvent(payload: unknown): PluginClientChangeEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  if (raw.type !== "plugin_changed") return null;
  const kind = raw.kind;
  if (typeof kind !== "string") return null;
  return {
    kind: kind as PluginClientChangeEvent["kind"],
    ...(typeof raw.pluginId === "string" ? { pluginId: raw.pluginId } : {}),
    ...(typeof raw.panelId === "string" ? { panelId: raw.panelId } : {}),
    ...(typeof raw.collection === "string" ? { collection: raw.collection } : {}),
  };
}

/**
 * Installing or changing a plugin on another machine has no action behind it on
 * this host. Dropping the field would act on THIS machine instead — the one
 * failure mode a machine picker must never have.
 *
 * The refusal is paired with {@link PLUGIN_BRIDGE_SUPPORTS_REMOTE_INSTALL}: the
 * UI asks that marker before it offers the control, so nobody reaches this
 * throw by pressing a button that looked available.
 */
function rejectRemoteMachine(machineKey: string | undefined): void {
  if (machineKey) {
    throw new Error("Managing plugins on another machine isn’t supported yet.");
  }
}

/**
 * Whether this preload can install or enable on a machine other than this one.
 *
 * False, and stated rather than inferred. The Marketplace used to work it out
 * from `install` and `presence` both being callable, which is true here and
 * says nothing — this preload refuses every `machineKey` outright. Flip this to
 * `true` in the same change that gives {@link rejectRemoteMachine} something to
 * call, never before.
 */
export const PLUGIN_BRIDGE_SUPPORTS_REMOTE_INSTALL = false;

export type PluginBridgeDeps = {
  /**
   * Route a `plugin` domain action through the daemon (remote → local),
   * falling back to the desktop-main IPC handler when no runtime is bound.
   * STRICT: a routing failure surfaces, it does not become an empty result.
   */
  callStrictOr: <T>(
    action: string,
    args: Record<string, unknown>,
    local: () => Promise<T>,
  ) => Promise<T>;
  invoke: <T>(channel: string, args?: unknown) => Promise<T>;
  /**
   * Register a plugin-change callback against both delivery paths — the
   * main-process channel and the daemon's runtime event stream. Returns an
   * unregister function.
   */
  subscribeChanges: (cb: (event: PluginClientChangeEvent) => void) => () => void;
};

export function createPluginBridge(deps: PluginBridgeDeps) {
  const { callStrictOr, invoke, subscribeChanges } = deps;
  return {
    list: async (): Promise<PluginClientInstalled[]> => {
      // Disabled plugins are part of the list the UI draws — it renders the
      // on/off state, so asking only for enabled ones would hide the switch.
      const args = { includeDisabled: true };
      const summaries = await callStrictOr<PluginSummary[]>("list", args, () =>
        invoke(IPC.pluginList, args),
      );
      return summaries.map(toInstalledPlugin);
    },
    getPanel: async (args: {
      pluginId: string;
      panelId: string;
    }): Promise<PluginPanelRecord | null> =>
      callStrictOr("getPanel", args, () => invoke(IPC.pluginGetPanel, args)),
    // `panelId` rides through untouched. This host reads collections by name —
    // it holds the whole database — so it makes no use of the field; the web
    // transport serves the same call out of a panel snapshot and cannot answer
    // without it. Forwarding rather than stripping keeps ONE bridge signature
    // across both, which is what lets the renderer call one function.
    getCollection: async (args: {
      pluginId: string;
      panelId?: string;
      collection: string;
      keyPrefix?: string;
      limit?: number;
    }): Promise<{ key: string; value: unknown }[]> => {
      const rows = await callStrictOr<PluginHostCollectionRow[]>("getCollection", args, () =>
        invoke(IPC.pluginGetCollection, args),
      );
      return rows.map((row) => ({ key: row.key, value: row.value }));
    },
    invoke: async (args: {
      pluginId: string;
      action: string;
      args?: Record<string, unknown>;
      /** Per-call round-trip budget; the host clamps it. See `sockets.ts`. */
      timeoutMs?: number;
    }): Promise<unknown> =>
      callStrictOr("invoke", args, () => invoke(IPC.pluginInvoke, args)),
    restart: async (args: { pluginId: string }): Promise<void> => {
      await callStrictOr("reload", args, () => invoke(IPC.pluginReload, args));
    },
    install: async (request: PluginClientInstallRequest): Promise<PluginClientInstallResult> => {
      rejectRemoteMachine(request.machineKey);
      // `version` rides all the way to the host. Only the host knows how a
      // directory version maps to a git ref, and dropping it here installed
      // whatever the default branch happened to be while the UI reported the
      // version the user picked.
      const args = {
        source: request.source,
        ...(request.version ? { version: request.version } : {}),
      };
      const summary = await callStrictOr<PluginSummary>("install", args, () =>
        invoke(IPC.pluginInstall, args),
      );
      return {
        pluginId: summary.pluginId,
        version: summary.version,
        displayName: summary.displayName,
      };
    },
    uninstall: async (input: { pluginId: string; machineKey?: string }): Promise<void> => {
      rejectRemoteMachine(input.machineKey);
      const args = { pluginId: input.pluginId };
      await callStrictOr("uninstall", args, () => invoke(IPC.pluginUninstall, args));
    },
    setEnabled: async (input: {
      pluginId: string;
      enabled: boolean;
      machineKey?: string;
    }): Promise<void> => {
      rejectRemoteMachine(input.machineKey);
      const args = { pluginId: input.pluginId };
      const action = input.enabled ? "enable" : "disable";
      const channel = input.enabled ? IPC.pluginEnable : IPC.pluginDisable;
      await callStrictOr(action, args, () => invoke(channel, args));
    },
    remoteInstall: PLUGIN_BRIDGE_SUPPORTS_REMOTE_INSTALL,
    // Config rides the detail read and the domain's own writer rather than the
    // bridge's `invoke("config.get"/"config.set")` fallback, which only answers
    // for a plugin that happens to declare those two handlers itself.
    getConfig: async (input: {
      pluginId: string;
    }): Promise<Record<string, string | number | boolean | null>> => {
      const args = { pluginId: input.pluginId };
      const detail = await callStrictOr<PluginDetail | null>("get", args, () =>
        invoke(IPC.pluginGet, args),
      );
      return detail?.config ?? {};
    },
    // ONE shape, the host's: `{pluginId, values}` where values is a patch. The
    // renderer's bridge sends exactly this. An adapter here that read `key`
    // and `value` instead would not fail — it would post `{undefined: undefined}`
    // and report success for a setting that was never written.
    setConfig: async (input: {
      pluginId: string;
      values: Record<string, string | number | boolean | null>;
    }): Promise<void> => {
      const args = { pluginId: input.pluginId, values: input.values ?? {} };
      await callStrictOr("setConfig", args, () => invoke(IPC.pluginSetConfig, args));
    },
    setContributionEnabled: async (input: {
      pluginId: string;
      socketId: string;
      enabled: boolean;
    }): Promise<void> => {
      await callStrictOr("setContributionEnabled", input, () =>
        invoke(IPC.pluginSetContributionEnabled, input),
      );
    },
    marketplaceIndex: async (
      input: { refresh?: boolean } = {},
    ): Promise<PluginMarketplaceIndex | null> => {
      const args = input.refresh ? { refresh: true } : {};
      return callStrictOr("marketplaceIndex", args, () =>
        invoke(IPC.pluginMarketplaceIndex, args),
      );
    },
    repoStars: async (input: { repo: string }): Promise<number | null> =>
      callStrictOr("repoStars", input, () => invoke(IPC.pluginRepoStars, input)),
    presence: async (): Promise<PluginPresenceMachineRow[]> =>
      callStrictOr("presence", {}, () => invoke(IPC.pluginPresence, {})),
    getReadme: async (input: { pluginId: string }): Promise<string | null> =>
      callStrictOr("getReadme", input, () => invoke(IPC.pluginGetReadme, input)),
    getManifest: async (input: { pluginId: string }): Promise<unknown | null> =>
      callStrictOr("getManifest", input, () => invoke(IPC.pluginGetManifest, input)),
    openLogs: async (input: { pluginId: string }): Promise<PluginLogEntry[]> =>
      callStrictOr("openLogs", input, () => invoke(IPC.pluginOpenLogs, input)),
    // The dynamic half of the socket taxonomy. Static manifest sockets say a
    // plugin CAN badge a lane; these rows say what it says about lane 7 now.
    listContributions: async (input: {
      surface: string;
      entityKind?: string;
      entityIds?: string[];
    }): Promise<PluginContributionRecord[]> =>
      callStrictOr("listContributions", input, () =>
        invoke(IPC.pluginListContributions, input),
      ),
    inspectSource: async (input: { source: string }): Promise<PluginSourceInspection | null> =>
      callStrictOr("inspectSource", input, () => invoke(IPC.pluginInspectSource, input)),
    usageSummary: async (input: { pluginId?: string } = {}): Promise<PluginClientUsageRow[]> => {
      const args = input.pluginId ? { pluginId: input.pluginId } : {};
      const summary = await callStrictOr<PluginUsageSummary>("usageSummary", args, () =>
        invoke(IPC.pluginUsageSummary, args),
      );
      return toPluginUsageRows(summary);
    },
    onChanged: (cb: (event: PluginClientChangeEvent) => void): (() => void) =>
      subscribeChanges(cb),
  } satisfies Window["ade"]["plugins"];
}
