// Small CDP WebSocket client shared by the UI performance probes.
export async function connect(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const pending = new Map();
  const listeners = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onclose = () => reject(new Error("CDP WebSocket closed"));
  });
  const client = {
    send(method, params = {}) {
      const requestId = id++;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try { ws.send(JSON.stringify({ id: requestId, method, params })); }
        catch (error) { pending.delete(requestId); reject(error); }
      });
    },
    on(method, listener) {
      const callbacks = listeners.get(method) ?? new Set();
      callbacks.add(listener);
      listeners.set(method, callbacks);
      return () => callbacks.delete(listener);
    },
    close() { ws.close(); },
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  };
  await opened;
  ws.onerror = (event) => {
    for (const { reject } of pending.values()) reject(new Error(event.message || "CDP WebSocket error"));
    pending.clear();
  };
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error("CDP WebSocket closed"));
    pending.clear();
  };
  return client;
}
