import {
  PLUGIN_SURFACE_IDS,
  comparePluginContributions,
  isPluginSocketKind,
  type PluginContribution,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  PLUGIN_WEBVIEW_SOCKETS_MAX_ROWS,
  type PluginWebviewSocketItem,
} from "../../../../shared/plugins/webviewBridge";
import { derivedSetFor, rowsStoreFor, sourcesStore } from "./contributionStores";

/**
 * What a plugin PAGE sees of everybody else's socket contributions.
 *
 * ## Why a page can ask this at all
 *
 * A page that replaced an ADE surface also replaced the place other plugins
 * were drawing into. The Graph is the case that forced the verb: `graph-node`
 * rows were drawn by the compiled canvas, and the moment that canvas became a
 * plugin page those contributions had nowhere to land. The choice was to lose
 * third-party nodes on the ported surface or to let the page draw them, and
 * losing them would make every port a quiet regression for everyone else's
 * plugin.
 *
 * ## What it is not
 *
 * It is not a read of another plugin's data. Every row here was PUBLISHED for a
 * surface — the host would have drawn it, and the reader would have seen it —
 * so a page learns nothing it could not have learned by looking at the screen.
 * And a press names a ROW, never a plugin and never an action: {@link
 * invokePluginWebviewSocket} resolves both from the contribution it listed, so
 * a page cannot reach a handler that was not already behind a visible button.
 */

/**
 * A row's handle, as a page receives it and passes it back.
 *
 * The three facts that identify a contribution, percent-encoded and joined, so
 * the handle is one opaque token with no separator a plugin id, a socket kind
 * or a contribution id could smuggle. Opaque to the page on purpose: a page
 * that parsed this would be a page building an id for a row it never listed.
 */
export function pluginWebviewSocketId(contribution: {
  pluginId: string;
  socket: string;
  id: string;
}): string {
  return [contribution.pluginId, contribution.socket, contribution.id]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

/** Reverse {@link pluginWebviewSocketId}, refusing anything malformed. */
export function readPluginWebviewSocketId(
  socketId: string,
): { pluginId: string; socket: string; id: string } | null {
  const parts = socketId.split("|");
  if (parts.length !== 3) return null;
  try {
    const [pluginId, socket, id] = parts.map((part) => decodeURIComponent(part));
    if (!pluginId || !socket || !id) return null;
    return { pluginId, socket, id };
  } catch {
    return null;
  }
}

/**
 * Wait for one store to settle, without a timer.
 *
 * `ensureLoaded` is fire-and-forget — every caller of it so far was a component
 * that re-renders when the snapshot changes — and a page's `sockets.list` is a
 * promise that has to resolve with an answer. So this subscribes, asks, and
 * resolves on the first snapshot that says `ready`. A store that was already
 * ready resolves on the same turn and never subscribes.
 *
 * There is no timeout here on purpose: main already holds the page's promise
 * for a bounded time and rejects it with a sentence, and a second, shorter
 * deadline in the renderer would answer "no sockets" for a host that was merely
 * slow — which a page would draw as "nobody contributed anything".
 */
function whenReady<T extends { status: string }>(store: {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  ensureLoaded: () => void;
}): Promise<T> {
  store.ensureLoaded();
  const first = store.getSnapshot();
  if (first.status === "ready") return Promise.resolve(first);
  return new Promise<T>((resolve) => {
    const stop = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status !== "ready") return;
      stop();
      resolve(snapshot);
    });
    // The store may have settled between the read above and the subscribe.
    const now = store.getSnapshot();
    if (now.status === "ready") {
      stop();
      resolve(now);
    }
  });
}

/**
 * Every contribution of one socket kind, across every surface that holds one.
 *
 * Surfaces are asked rather than derived from the kind, because the mapping
 * from a socket to the surfaces it can appear on is a manifest fact this module
 * would have to restate — and restating it is how a page would stop seeing a
 * kind the day a surface gained it. Asking all of them costs one read per
 * surface, once, and every later call is served from the same stores the app's
 * own rows select from.
 */
export async function listPluginWebviewSockets(
  socket: string,
): Promise<PluginWebviewSocketItem[]> {
  if (!isPluginSocketKind(socket)) return [];
  const kind: PluginSocketKind = socket;
  const sources = (await whenReady(sourcesStore)).sources;
  if (sources.length === 0) return [];
  const surfaces = [...PLUGIN_SURFACE_IDS] as PluginSurfaceId[];
  const rowsBySurface = await Promise.all(
    surfaces.map(async (surface) => ({
      surface,
      rows: (await whenReady(rowsStoreFor(surface))).rows,
    })),
  );

  const seen = new Set<string>();
  const collected: { contribution: PluginContribution; displayName: string }[] = [];
  for (const { surface, rows } of rowsBySurface) {
    const set = derivedSetFor(surface, sources, rows);
    const candidates: PluginContribution[] = [
      ...set.staticContributions,
      // Every entity's rows, not one row's: a page draws the whole overlay, the
      // same way `buildPluginGraphOverlay` does for the compiled canvas.
      ...[...set.dynamicByEntity.values()].flat(),
    ];
    for (const contribution of candidates) {
      if (contribution.socket !== kind) continue;
      const socketId = pluginWebviewSocketId(contribution);
      // A contribution declared on two surfaces is one row to a page. Deduped
      // on the handle rather than on the object, because the two surfaces build
      // separate sets from the same source.
      if (seen.has(socketId)) continue;
      seen.add(socketId);
      collected.push({
        contribution,
        displayName: set.identities.get(contribution.pluginId)?.displayName ?? contribution.pluginId,
      });
    }
  }

  // The host's own order, so two machines holding the same rows hand a page the
  // same list — and so the cap below keeps the same rows on each.
  collected.sort((left, right) => comparePluginContributions(left.contribution, right.contribution));
  return collected.slice(0, PLUGIN_WEBVIEW_SOCKETS_MAX_ROWS).map(({ contribution, displayName }) => {
    const payload = contribution.payload as Record<string, unknown> | undefined;
    const label = typeof payload?.label === "string" && payload.label
      ? payload.label
      : typeof payload?.title === "string" && payload.title
        ? payload.title
        : contribution.id;
    const icon = typeof payload?.icon === "string" ? payload.icon : undefined;
    return {
      socketId: pluginWebviewSocketId(contribution),
      pluginId: contribution.pluginId,
      pluginDisplayName: displayName,
      socket: contribution.socket,
      label,
      ...(icon ? { icon } : {}),
      ...(payload ? { payload } : {}),
    } satisfies PluginWebviewSocketItem;
  });
}

/**
 * Find one listed contribution again, by the handle a page was given.
 *
 * Re-listed rather than cached: a page may press a row minutes after it drew
 * it, and a contribution the publishing plugin has since withdrawn must not
 * still be pressable. Answering null for a handle that no longer resolves is
 * what makes "the row is gone" the outcome rather than "the action ran anyway".
 */
export async function findPluginWebviewSocket(
  socketId: string,
): Promise<PluginWebviewSocketItem | null> {
  const parsed = readPluginWebviewSocketId(socketId);
  if (!parsed) return null;
  const rows = await listPluginWebviewSockets(parsed.socket);
  return rows.find((row) => row.socketId === socketId) ?? null;
}
