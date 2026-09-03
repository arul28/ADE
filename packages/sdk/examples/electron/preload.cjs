/**
 * Preload. One file, no imports, because that is all a sandboxed preload can be.
 *
 * `sandbox: true` gives this script no module resolution: `require` reaches
 * Electron's own built-ins and nothing else — not a file path, not
 * `node_modules`. So a preload either IS a bundled file or it is hand-written
 * like this one.
 *
 * This is the hand-written route, shown because a host usually wants its own
 * channels next to ADE's. The other route needs no file at all: point
 * `webPreferences.preload` at `require.resolve("@ade-dev/sdk/electron/preload")`
 * from the main process, which is what `main.mjs` does by default.
 *
 * Either way the surface is the same two functions, and the renderer half turns
 * them back into a client.
 */

const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "ade";

contextBridge.exposeInMainWorld("ade", {
  invoke(method, args) {
    return ipcRenderer.invoke(`${PREFIX}:invoke`, { method, args });
  },
  onEvent(listener) {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(`${PREFIX}:event`, handler);
    return () => ipcRenderer.removeListener(`${PREFIX}:event`, handler);
  },
});
