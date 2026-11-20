/**
 * Runs `onInstalled` when this computer's tools cache finishes downloading
 * `tool` (ADE's pinned copy, e.g. "opencode"). The tools cache pushes its
 * state on each change (`IPC.aiToolsCacheEvent`), so this adds no poll.
 *
 * This computer only: the push comes from the local tools cache. A surface
 * for another machine reads that machine's status instead. The web client
 * has no push and gets a no-op.
 *
 * Subscribe while the tool is believed missing: the first "installed" seen
 * counts as the download that just finished.
 */
export function subscribeToolInstalled(tool: string, onInstalled: () => void): () => void {
  const subscribe = window.ade?.ai?.onToolsCacheEvent;
  if (typeof subscribe !== "function") return () => undefined;
  let installed = false;
  return subscribe((snapshot) => {
    const next = snapshot.tools.some((state) => state.tool === tool && state.status === "installed");
    if (next && !installed) onInstalled();
    installed = next;
  });
}
