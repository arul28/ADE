/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPluginPageDocument, pluginPageGuestCsp } from "../pageDocument";

const workerSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pluginPageServiceWorker.js"),
  "utf8",
);

/**
 * Run the worker script against a fake global.
 *
 * It is loaded as SOURCE rather than imported: the file is deliberately not
 * part of the bundle — a worker script has to be a real file at a stable path —
 * and running the shipped bytes is the only way this test proves anything about
 * what a browser would execute.
 */
function runWorker(input: { scriptUrl: string; cached: Map<string, Response> }): {
  handlers: Record<string, (event: unknown) => void>;
  claimed: boolean;
  skippedWaiting: boolean;
} {
  const handlers: Record<string, (event: unknown) => void> = {};
  const state = { claimed: false, skippedWaiting: false };
  const self = {
    location: { href: input.scriptUrl },
    addEventListener(name: string, handler: (event: unknown) => void) {
      handlers[name] = handler;
    },
    skipWaiting() {
      state.skippedWaiting = true;
    },
    clients: {
      claim: async () => {
        state.claimed = true;
      },
    },
  };
  const caches = {
    match: async (request: { url: string }) => input.cached.get(request.url),
  };
  // eslint-disable-next-line no-new-func -- the point is to run the shipped file.
  new Function("self", "caches", "Response", "URL", workerSource)(self, caches, Response, URL);
  return {
    handlers,
    get claimed() {
      return state.claimed;
    },
    get skippedWaiting() {
      return state.skippedWaiting;
    },
  };
}

const SCRIPT_URL = "https://app.ade-app.dev/assets/pluginPageServiceWorker-abc123.js";
const BASE = "https://app.ade-app.dev/assets/plugin-pages/";

function fetchEvent(url: string): { request: { url: string }; responded: Promise<Response> | null; respondWith: (value: Promise<Response>) => void } {
  const event = {
    request: { url },
    responded: null as Promise<Response> | null,
    respondWith(value: Promise<Response>) {
      event.responded = value;
    },
  };
  return event;
}

describe("the plugin page service worker", () => {
  it("answers a request in its space from the cache, headers and all", async () => {
    const url = `${BASE}ade-linear/1.0.0-1/assets/app.js`;
    const cached = new Map([
      [url, new Response("export{}", { headers: { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" } })],
    ]);
    const worker = runWorker({ scriptUrl: SCRIPT_URL, cached });
    const event = fetchEvent(url);
    worker.handlers.fetch?.(event);

    const response = await event.responded;
    expect(response).toBeTruthy();
    expect(await response!.text()).toBe("export{}");
    // The type and the nosniff came from the cached response, not from the
    // worker: there is one MIME table in this client and the worker is not it.
    expect(response!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("404s a miss rather than letting it reach the origin", async () => {
    const worker = runWorker({ scriptUrl: SCRIPT_URL, cached: new Map() });
    const event = fetchEvent(`${BASE}ade-linear/9.9.9-9/index.html`);
    worker.handlers.fetch?.(event);

    const response = await event.responded;
    // The origin's single-page fallback would answer this with the whole ADE
    // client, inside a plugin's frame. The 404 is what stops that.
    expect(response!.status).toBe(404);
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does not touch a request outside its own space", () => {
    const worker = runWorker({ scriptUrl: SCRIPT_URL, cached: new Map() });
    for (const url of [
      "https://app.ade-app.dev/",
      "https://app.ade-app.dev/assets/index-abc.js",
      "https://app.ade-app.dev/account/machines",
      // A path that merely starts the same way is not inside the space.
      "https://app.ade-app.dev/assets/plugin-pages-elsewhere/x",
    ]) {
      const event = fetchEvent(url);
      worker.handlers.fetch?.(event);
      expect(event.responded).toBeNull();
    }
  });

  it("takes over immediately, so a frame never waits on a reload", async () => {
    const worker = runWorker({ scriptUrl: SCRIPT_URL, cached: new Map() });
    worker.handlers.install?.({});
    expect(worker.skippedWaiting).toBe(true);
    const waits: Array<Promise<unknown>> = [];
    worker.handlers.activate?.({ waitUntil: (value: Promise<unknown>) => waits.push(value) });
    await Promise.all(waits);
    expect(worker.claimed).toBe(true);
  });
});

describe("the guest document", () => {
  it("carries the sandbox that makes the frame's origin opaque", () => {
    const csp = pluginPageGuestCsp("NONCE");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src 'nonce-NONCE' blob:");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Nothing may execute from the app's own origin, which is what `'self'`
    // would have meant if it were carried over from the desktop policy.
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("writes the bootstrap under the nonce, with nothing that can end the block", () => {
    const html = buildPluginPageDocument({
      config: { nonce: "N", parentOrigin: "https://app.ade-app.dev", pluginId: "ade-linear", placement: "popover" },
      scriptNonce: "SCRIPT",
    });
    expect(html).toContain('<script nonce="SCRIPT">');
    expect(html).toContain('\\u003c');
    // One script block, opened once and closed once: the loader's own source
    // cannot have ended it early.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('"popover"');
  });
});
