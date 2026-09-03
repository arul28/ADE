/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pluginPageGuestMain, pluginPageGuestSource } from "../pageBridgeGuest";
import { PLUGIN_PAGE_CHANNEL, PLUGIN_PAGE_PROTOCOL_VERSION } from "../pageProtocol";

/**
 * In jsdom the top window IS its own parent, which is what makes the guest
 * testable at all: the bootstrap posts to `window.parent`, so its messages
 * arrive on this same window and a reply posted here reaches the guest with
 * `source === window.parent`, exactly as it would across a real frame boundary.
 */
const NONCE = "test-nonce";

let blobs: Map<string, Blob>;
let sent: Array<Record<string, unknown>>;
let listener: ((event: MessageEvent) => void) | null = null;

beforeEach(() => {
  blobs = new Map();
  sent = [];
  let counter = 0;
  URL.createObjectURL = (blob: Blob) => {
    counter += 1;
    const url = `blob:https://app.ade-app.dev/${counter}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = () => undefined;
  listener = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.channel === PLUGIN_PAGE_CHANNEL) sent.push(data);
  };
  window.addEventListener("message", listener);
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  if (listener) window.removeEventListener("message", listener);
  listener = null;
  delete (window as unknown as Record<string, unknown>).adePlugin;
});

function start(): void {
  pluginPageGuestMain({
    nonce: NONCE,
    parentOrigin: window.location.origin,
    pluginId: "ade-linear",
    placement: "tab",
  });
}

/**
 * Deliver a host message to the guest.
 *
 * `source` is set explicitly: jsdom's own `window.postMessage` leaves it null,
 * and `source` is half of what the guest checks — so a reply sent the lazy way
 * would be dropped for the right reason and make every test here pass for the
 * wrong one.
 */
function fromHost(body: Record<string, unknown>, nonce = NONCE): void {
  const event = new MessageEvent("message", {
    data: { ...body, channel: PLUGIN_PAGE_CHANNEL, v: PLUGIN_PAGE_PROTOCOL_VERSION, nonce },
  });
  Object.defineProperty(event, "source", { value: window.parent, configurable: true });
  window.dispatchEvent(event);
}

function reply(id: number, value: unknown, nonce = NONCE): void {
  fromHost({ kind: "response", id, ok: true, value }, nonce);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** `Blob.text()` is not implemented in this jsdom, so read it the long way. */
function textOf(blob: Blob | undefined): Promise<string> {
  if (!blob) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("the guest bootstrap", () => {
  it("publishes the v2 bridge and asks for its bytes as its first act", async () => {
    start();
    await settle();

    const bridge = (window as unknown as { adePlugin: Record<string, unknown> }).adePlugin;
    expect(typeof bridge.invoke).toBe("function");
    expect(typeof (bridge.collections as Record<string, unknown>).list).toBe("function");
    for (const namespace of ["ui", "clipboard", "theme", "host", "composer", "surface", "config", "events"]) {
      expect(bridge[namespace]).toBeTruthy();
    }
    expect(bridge.pluginId).toBe("ade-linear");

    expect(sent[0]).toMatchObject({ kind: "ready", nonce: NONCE });
    expect(sent[1]).toMatchObject({ kind: "request", method: "page.boot", nonce: NONCE });
  });

  it("carries the nonce on every call and resolves on the matching answer", async () => {
    start();
    await settle();
    const bridge = (window as unknown as { adePlugin: Record<string, unknown> }).adePlugin;

    const pending = (bridge.invoke as (action: string) => Promise<unknown>)("refresh");
    await settle();
    const request = sent.find((message) => message.method === "invoke") as Record<string, unknown>;
    expect(request).toMatchObject({ nonce: NONCE, params: { action: "refresh", args: {} } });

    reply(request.id as number, { rows: 3 });
    await settle();
    await expect(pending).resolves.toEqual({ rows: 3 });
  });

  it("ignores an answer that carries the wrong nonce", async () => {
    start();
    await settle();
    const bridge = (window as unknown as { adePlugin: Record<string, unknown> }).adePlugin;

    let settled = false;
    void (bridge.invoke as (action: string) => Promise<unknown>)("refresh").then(() => {
      settled = true;
    });
    await settle();
    const request = sent.find((message) => message.method === "invoke") as Record<string, unknown>;

    reply(request.id as number, { rows: 3 }, "guessed");
    await settle();
    expect(settled).toBe(false);
  });

  it("draws the plugin's document, pointing every reference at a blob it minted", async () => {
    start();
    await settle();
    const boot = sent.find((message) => message.method === "page.boot") as Record<string, unknown>;

    reply(boot.id as number, {
      bridgeVersion: 2,
      pluginId: "ade-linear",
      context: { subject: null },
      theme: { scheme: "light", tokens: { "--color-bg": "#fff" } },
      entry: "index.html",
      files: [
        {
          path: "index.html",
          mime: "text/html",
          bytes: bytesOf('<html><head><link rel="stylesheet" href="./style.css"></head><body><div id="root"></div><script type="module" crossorigin src="./assets/app.js"></script></body></html>'),
        },
        { path: "assets/app.js", mime: "text/javascript", bytes: bytesOf('import {render} from "./render.js";\nrender();') },
        { path: "assets/render.js", mime: "text/javascript", bytes: bytesOf("export function render(){}") },
        { path: "style.css", mime: "text/css", bytes: bytesOf("body{background:url(./bg.png)}") },
        { path: "bg.png", mime: "image/png", bytes: bytesOf("PNG") },
      ],
    });
    await settle();

    const script = document.querySelector("script[type=module]") as HTMLScriptElement;
    expect(script.src.startsWith("blob:")).toBe(true);
    // `crossorigin` would make a blob load a CORS request against an opaque
    // origin, so the rewrite drops it.
    expect(script.hasAttribute("crossorigin")).toBe(false);
    expect(document.getElementById("root")).not.toBeNull();

    // The entry module's relative import was rewritten to the blob of the file
    // it names — which is what makes module identity survive, and the only way
    // a relative specifier can resolve from a blob URL at all.
    const entrySource = await textOf(blobs.get(script.src));
    expect(entrySource).toMatch(/import \{render\} from "blob:/);
    expect(entrySource).not.toContain('"./render.js"');

    const styleHref = (document.querySelector("link[rel=stylesheet]") as HTMLLinkElement).href;
    const styleSource = await textOf(blobs.get(styleHref));
    expect(styleSource).toMatch(/url\(blob:/);

    // The theme snapshot the host sent is painted onto the guest's own root.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#fff");
  });

  it("leaves a specifier that names no file in this page exactly as written", async () => {
    start();
    await settle();
    const boot = sent.find((message) => message.method === "page.boot") as Record<string, unknown>;
    reply(boot.id as number, {
      bridgeVersion: 2,
      pluginId: "ade-linear",
      context: null,
      theme: null,
      entry: "index.html",
      files: [
        { path: "index.html", mime: "text/html", bytes: bytesOf('<html><body><script type="module" src="./app.js"></script></body></html>') },
        {
          path: "app.js",
          mime: "text/javascript",
          bytes: bytesOf('import "https://cdn.example.com/x.js";\nconst text = \'from "./nope.js"\';\nexport {text};'),
        },
      ],
    });
    await settle();

    const source = await textOf(blobs.get((document.querySelector("script[type=module]") as HTMLScriptElement).src));
    expect(source).toContain('import "https://cdn.example.com/x.js"');
    // A match inside an unrelated string resolves to no file in the page, so it
    // is left alone. That is what makes a regex safe on plugin-authored source.
    expect(source).toContain('from "./nope.js"');
  });

  it("says so, in the host's own words, when the bytes never arrive", async () => {
    start();
    await settle();
    const boot = sent.find((message) => message.method === "page.boot") as Record<string, unknown>;
    fromHost({ kind: "response", id: boot.id, ok: false, message: "This computer can’t serve that plugin’s page." });
    await settle();
    expect(document.body.textContent).toBe("This computer can’t serve that plugin’s page.");
  });
});

describe("pluginPageGuestSource", () => {
  it("is a self-contained call with no reference to anything outside it", () => {
    const source = pluginPageGuestSource({
      nonce: NONCE,
      parentOrigin: "https://app.ade-app.dev",
      pluginId: "ade-linear",
      placement: "popover",
    });
    expect(source.startsWith("(function")).toBe(true);
    expect(source).toContain('"ade-linear"');
    // The bootstrap ships as the body of a <script> block, so the one sequence
    // that could end that block early must not survive in it.
    expect(source).not.toContain("</script");
  });
});
