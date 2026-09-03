/**
 * Third-party graph nodes, from inside the guest.
 *
 * The compiled page read the contribution model directly out of the renderer's
 * plugin state (`components/plugins/sockets`). A guest cannot: it holds no
 * registry and must not, because a page that could enumerate every plugin's
 * contributions would be a page that could read a neighbour's manifest.
 *
 * So the host answers instead. `sockets.list("graph-node")` returns what the
 * host has already resolved and permission-checked, and `sockets.invoke` presses
 * one — the same dispatch a host-drawn socket button uses, with the same
 * control-flow answers (`{navigate}`, `{openUrl}`, `{openWebview}`) applied by
 * the host before the promise resolves.
 *
 * MISSING contract: `bridge.sockets` is added by the platform batch of this
 * wave. Both verbs are guarded — an older host lists nothing, so the canvas
 * draws ADE's own nodes and no contributed ones, which is exactly the graph
 * that host could draw anyway.
 */

import { bridge, type PluginWebviewSocketEntry } from "../bridge";

export const GRAPH_NODE_SOCKET = "graph-node";

/** Every contributed node for one socket. Empty on a host without the verb. */
export async function listSocketEntries(socket: string): Promise<PluginWebviewSocketEntry[]> {
  const api = bridge();
  if (!api?.sockets) return [];
  try {
    const entries = await api.sockets.list(socket);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * Press one contributed node.
 *
 * Answers `false` when there was nothing to press — an older host, or a socket
 * whose owning plugin has since been disabled — so the caller can say so rather
 * than leaving a node that looks pressed and did nothing.
 */
export async function invokeSocketEntry(
  socketId: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  const api = bridge();
  if (!api?.sockets) return false;
  try {
    await api.sockets.invoke(socketId, args ?? {});
    return true;
  } catch {
    return false;
  }
}
