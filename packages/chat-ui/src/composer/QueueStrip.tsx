import { useCallback, useEffect, useState } from "react";

import type { ThreadQueue, QueuedMessage } from "../sdkTypes";

export type QueueStripProps = {
  queue?: ThreadQueue;
  /** Refresh after a thread action or status transition. */
  refreshKey?: unknown;
};

export function QueueStrip({ queue, refreshKey }: QueueStripProps) {
  const [items, setItems] = useState<readonly QueuedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const refresh = useCallback(async () => {
    if (typeof queue?.list !== "function") return;
    setLoading(true);
    try {
      setItems([...(await queue.list())]);
      setError(null);
      setLoaded(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const act = async (id: string, action: (() => Promise<void>) | undefined) => {
    if (!action) return;
    setBusyId(id);
    setError(null);
    try {
      await action();
      if (editingId === id) setEditingId(null);
      await refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  if (typeof queue?.list !== "function") return null;

  return (
    <section className="adechat-queue" aria-label="Queued messages">
      {loading && !loaded ? <p className="adechat-queue-state">Loading queued messages…</p> : null}
      {error ? (
        <div className="adechat-queue-error" role="alert">
          <span>Couldn’t load or update the queue: {error}</span>
          <button type="button" className="adechat-button" onClick={() => void refresh()} disabled={loading}>Retry</button>
        </div>
      ) : null}
      {loaded && items.length > 0 ? (
        <ol className="adechat-queue-list">
          {items.map((item, index) => {
            const busy = busyId === item.id;
            const editing = editingId === item.id;
            const canMove = typeof queue.move === "function" && !item.dispatched;
            return (
              <li className="adechat-queue-item" key={item.id}>
                {editing ? (
                  <form
                    className="adechat-queue-edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act(item.id, queue.edit ? () => queue.edit!(item.id, editText) : undefined);
                    }}
                  >
                    <input aria-label="Edit queued message" value={editText} onChange={(event) => setEditText(event.target.value)} disabled={busy} />
                    <button type="submit" className="adechat-button" disabled={busy || !queue.edit}>Save</button>
                    <button type="button" className="adechat-button" onClick={() => setEditingId(null)} disabled={busy}>Cancel edit</button>
                  </form>
                ) : (
                  <span className="adechat-queue-text">{item.text || "Attachment message"}</span>
                )}
                {!editing ? (
                  <div className="adechat-queue-actions">
                    {canMove ? (
                      <>
                        <button type="button" className="adechat-button" aria-label={`Move message ${index + 1} up`} disabled={busy || index === 0} onClick={() => void act(item.id, () => queue.move!(item.id, index - 1))}>↑</button>
                        <button type="button" className="adechat-button" aria-label={`Move message ${index + 1} down`} disabled={busy || index === items.length - 1} onClick={() => void act(item.id, () => queue.move!(item.id, index + 1))}>↓</button>
                      </>
                    ) : null}
                    {!item.dispatched && queue.edit ? (
                      <button type="button" className="adechat-button" disabled={busy} onClick={() => { setEditingId(item.id); setEditText(item.text); }}>Edit</button>
                    ) : null}
                    {!item.dispatched && queue.dispatch ? (
                      <button type="button" className="adechat-button" disabled={busy} onClick={() => void act(item.id, () => queue.dispatch!(item.id))}>Send now</button>
                    ) : null}
                    {item.dispatched && queue.cancelDispatched ? (
                      <button type="button" className="adechat-button" disabled={busy} onClick={() => void act(item.id, () => queue.cancelDispatched!(item.id))}>Cancel send</button>
                    ) : null}
                    {queue.cancel ? (
                      <button type="button" className="adechat-button" disabled={busy} onClick={() => void act(item.id, () => queue.cancel!(item.id))}>Cancel</button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
