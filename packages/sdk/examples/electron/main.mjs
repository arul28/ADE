/**
 * Main process. Owns the SDK client and the IPC bridge.
 *
 * The window is hardened the way a real product hardens one:
 * `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a
 * strict CSP meta tag in the page. That combination is the one most likely to
 * be untested, so it is the one this example uses.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";
import { createAdeChat } from "@ade-dev/sdk";
import { registerAdeIpc } from "@ade-dev/sdk/electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Which preload to load.
 *
 * By default this points straight at the SDK's self-running preload,
 * `@ade-dev/sdk/electron/preload-auto`: one file whose only `require` is
 * `electron`, the only thing a sandboxed preload can load. (Not
 * `@ade-dev/sdk/electron/preload`, which exports `exposeAdeBridge` without
 * calling it, so `window.ade` would stay undefined.) Set `ADE_EXAMPLE_PRELOAD=local` to load
 * `preload.cjs` next to this file instead: that is the shape a host writes when
 * it wants its own channels alongside ADE's.
 */
function resolvePreload() {
  if (process.env.ADE_EXAMPLE_PRELOAD === "local") return path.join(here, "preload.cjs");
  return require.resolve("@ade-dev/sdk/electron/preload-auto");
}

let disposeIpc = null;
let client = null;

async function start() {
  client = await createAdeChat({
    home: path.join(app.getPath("userData"), "ade"),
    logger: (line) => process.stderr.write(`[ade] ${line}\n`),
  });

  disposeIpc = registerAdeIpc(ipcMain, client, {
    // Only this app's own thread. A compromised renderer cannot name a key with
    // different MCP servers or a different permission policy.
    allowThreadKey: (key) => key === "main",
    // With no `openOptions` hook, only `provider`, `model`, `title` and
    // `reasoningEffort` cross from the renderer; everything else is dropped
    // and logged. A host that configures threads (MCP servers, a policy, a
    // cwd) returns those options from `openOptions: (key) => ({ ... })`
    // instead, and can gate model choice with `allowModel`.
    logger: (line) => process.stderr.write(`${line}\n`),
  });

  const window = new BrowserWindow({
    width: 900,
    height: 700,
    title: "ADE SDK Electron example",
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadFile(path.join(here, "renderer", "index.html"));
}

app.whenReady().then(start);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", async (event) => {
  if (!client) return;
  event.preventDefault();
  // Drop the bridge first so no push races a closing runtime, then the client.
  disposeIpc?.();
  disposeIpc = null;
  const closing = client;
  client = null;
  await closing.dispose();
  app.quit();
});
