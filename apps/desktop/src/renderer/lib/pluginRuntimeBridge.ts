/**
 * The renderer's view of `window.ade.plugins.*`.
 *
 * Wave A owns the preload namespace itself. This module owns the *shape* the UI
 * codes against, declared locally so the renderer compiles and degrades before
 * that namespace exists, and so the plugin surfaces have one place to look when
 * the contract moves.
 *
 * Two rules from the desktop recon are enforced here rather than at each call
 * site:
 *
 * - **Every call is optional-chained.** A missing namespace is the normal state
 *   on an older host and in the hosted web client, and it must read as "no
 *   plugins" rather than a thrown renderer error. `window.ade.plugins` may also
 *   be a null service while a project transition is in flight.
 * - **Read and write are separated.** `plugin.invoke` is MUTATING (design
 *   decision D19) and therefore throws during a project transition; the read
 *   calls do not. Callers that must not fail on a transition use the readers.
 */

import type { PluginThemeTokens } from "./pluginTheme";

/** Child-process health, as reported by the plugin host. */
export type PluginRuntimeStatus = "running" | "starting" | "stopped" | "crashed" | "none";

/** One `{"kind":"tab"}` surface from a plugin's manifest. */
export type PluginTabDescriptor = {
  id: string;
  title: string;
  panelId: string;
  /** Phosphor icon name; resolved through `pluginIcons.ts`, never rendered raw. */
  icon?: string | null;
};

export type InstalledPlugin = {
  pluginId: string;
  displayName: string;
  version: string;
  enabled: boolean;
  icon: string | null;
  /** Hex accent from the manifest. Applied as a CSS variable, never inlined as a class. */
  accent: string | null;
  status: PluginRuntimeStatus;
  tabs: PluginTabDescriptor[];
  /** Present only for theme plugins. */
  theme: { displayName: string; tokens: PluginThemeTokens } | null;
  /** Drives the nav dot. Off unless the plugin asks for attention. */
  attention?: boolean;
};

export type PluginPanelRecord = {
  pluginId: string;
  panelId: string;
  title: string | null;
  /** Opaque versioned JSON — parsed by `shared/plugins/vocabulary.ts`, never here. */
  schema: unknown;
  vocabVersion: number;
  updatedAt: string | null;
};

export type PluginCollectionRow = {
  key: string;
  value: unknown;
};

/** What changed, so a subscriber can decide whether it needs to refetch. */
export type PluginChangeEvent = {
  kind: "installs" | "panels" | "collections" | "status";
  pluginId?: string;
  panelId?: string;
  collection?: string;
};

type PluginBridge = {
  list?: () => Promise<InstalledPlugin[]>;
  getPanel?: (input: { pluginId: string; panelId: string }) => Promise<PluginPanelRecord | null>;
  getCollection?: (input: {
    pluginId: string;
    collection: string;
    keyPrefix?: string;
    limit?: number;
  }) => Promise<PluginCollectionRow[]>;
  invoke?: (input: {
    pluginId: string;
    action: string;
    args?: Record<string, unknown>;
  }) => Promise<unknown>;
  restart?: (input: { pluginId: string }) => Promise<void>;
  openLogs?: (input: { pluginId: string }) => Promise<void>;
  onChanged?: (listener: (event: PluginChangeEvent) => void) => (() => void) | void;
};

function bridge(): PluginBridge | null {
  if (typeof window === "undefined") return null;
  const ade = (window as Window & { ade?: { plugins?: PluginBridge | null } }).ade;
  return ade?.plugins ?? null;
}

/** True when this host exposes a plugin surface at all. */
export function pluginsAvailable(): boolean {
  return bridge() !== null;
}

/** Installed plugins on this machine. Empty on a host with no plugin support. */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  const plugins = bridge()?.list;
  if (!plugins) return [];
  try {
    const result = await plugins();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function readPluginPanel(
  pluginId: string,
  panelId: string,
): Promise<PluginPanelRecord | null> {
  const getPanel = bridge()?.getPanel;
  if (!getPanel) return null;
  return (await getPanel({ pluginId, panelId })) ?? null;
}

export async function readPluginCollection(
  pluginId: string,
  collection: string,
  options: { keyPrefix?: string; limit?: number } = {},
): Promise<PluginCollectionRow[]> {
  const getCollection = bridge()?.getCollection;
  if (!getCollection) return [];
  const result = await getCollection({ pluginId, collection, ...options });
  return Array.isArray(result) ? result : [];
}

/**
 * Dispatch a plugin action. MUTATING — this is the one call in the module that
 * is expected to reject, and callers surface the rejection rather than swallow
 * it: a button that silently does nothing is the failure mode this contract
 * exists to avoid.
 */
export async function invokePluginAction(
  pluginId: string,
  action: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const invoke = bridge()?.invoke;
  if (!invoke) throw new Error("This build has no plugin support.");
  return invoke({ pluginId, action, ...(args ? { args } : {}) });
}

export async function restartPlugin(pluginId: string): Promise<void> {
  const restart = bridge()?.restart;
  if (!restart) throw new Error("This build has no plugin support.");
  await restart({ pluginId });
}

export async function openPluginLogs(pluginId: string): Promise<void> {
  const openLogs = bridge()?.openLogs;
  if (!openLogs) throw new Error("This build has no plugin support.");
  await openLogs({ pluginId });
}

/**
 * Subscribe to host-side plugin changes. Returns an unsubscribe function that is
 * always safe to call, including when the host published no subscription at all.
 */
export function subscribeToPluginChanges(
  listener: (event: PluginChangeEvent) => void,
): () => void {
  const onChanged = bridge()?.onChanged;
  if (!onChanged) return () => {};
  try {
    const dispose = onChanged(listener);
    return typeof dispose === "function" ? dispose : () => {};
  } catch {
    return () => {};
  }
}
