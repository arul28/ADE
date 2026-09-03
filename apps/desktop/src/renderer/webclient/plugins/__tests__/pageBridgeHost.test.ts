/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLUGIN_WEBVIEW_MAX_HEIGHT_PX } from "../../../../shared/plugins/webviewBridge";
import { createPluginPageHost, coalesceHostEvents, type PluginPageHostOptions } from "../pageBridgeHost";
import { PLUGIN_PAGE_CHANNEL, PLUGIN_PAGE_PROTOCOL_VERSION } from "../pageProtocol";
import type { PluginPageBundle } from "../pageAssets";

const applied: Array<{ result: unknown; answeringPrompt: boolean }> = [];
let nextPromptAnswer: unknown = null;

// The control-flow reader is exercised by its own tests and by the socket
// path's. What matters here is that the bridge CALLS it with the handler's
// result and honours the question it reports back, so it is faked to a
// recorder rather than run for real.
vi.mock("../pageActionResult", () => ({
  applyPluginPageActionAnswers: (result: unknown, source: { answeringPrompt: boolean }) => {
    applied.push({ result, answeringPrompt: source.answeringPrompt });
    return { prompt: nextPromptAnswer };
  },
}));

const BUNDLE: PluginPageBundle = {
  pluginId: "ade-linear",
  version: "1.0.0",
  revision: 1,
  versionKey: "1.0.0-1",
  entry: "index.html",
  files: [{ path: "index.html", mime: "text/html; charset=utf-8", bytes: new TextEncoder().encode("<html></html>") }],
};

/** A stand-in for the frame's `contentWindow`: it only has to receive messages. */
function fakeGuest(): { window: Window; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const window = {
    postMessage: (message: Record<string, unknown>) => {
      sent.push(message);
    },
  } as unknown as Window;
  return { window, sent };
}

function build(overrides: Partial<PluginPageHostOptions> = {}) {
  const guest = fakeGuest();
  const ui = {
    toast: vi.fn(() => ({ id: "toast-1" })),
    dismissToast: vi.fn(),
    prompt: vi.fn(async () => ({ id: "q", text: "typed" })),
    confirm: vi.fn(async () => true),
    closeSurface: vi.fn(),
    composerInsert: vi.fn(() => true),
    openSettings: vi.fn(() => true),
    openDeeplink: vi.fn(),
    resize: vi.fn(),
  };
  const data = {
    invoke: vi.fn(async () => ({ ok: true })),
    collectionsGet: vi.fn(async () => ({ value: 1 })),
    collectionsList: vi.fn(async () => [{ key: "a", value: 1 }]),
    configGet: vi.fn(async () => ({})),
    configSet: vi.fn(async () => ({})),
  };
  const host = createPluginPageHost({
    guestWindow: () => guest.window,
    hostWindow: window,
    nonce: "NONCE",
    pluginId: "ade-linear",
    context: { subject: null, placement: "tab" },
    bundle: BUNDLE,
    theme: () => ({ scheme: "dark", tokens: { "--color-bg": "#000" } }),
    ui,
    data,
    ...overrides,
  });
  return { host, guest, ui, data };
}

/**
 * Deliver one message as the guest, exactly as the browser would.
 *
 * `source` is defined on the event rather than passed to the constructor:
 * jsdom's `MessageEvent` exposes it as a getter and refuses a plain object
 * there, and the whole point of these tests is a source that is NOT a real
 * window.
 */
function fromGuest(source: Window, body: Record<string, unknown>, nonce = "NONCE"): void {
  const event = new MessageEvent("message", {
    data: { ...body, channel: PLUGIN_PAGE_CHANNEL, v: PLUGIN_PAGE_PROTOCOL_VERSION, nonce },
  });
  Object.defineProperty(event, "source", { value: source, configurable: true });
  window.dispatchEvent(event);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let hosts: Array<{ dispose: () => void }> = [];

beforeEach(() => {
  applied.length = 0;
  nextPromptAnswer = null;
  hosts = [];
});

afterEach(() => {
  for (const host of hosts) host.dispose();
});

describe("the guest → host bridge", () => {
  it("answers a boot request with the page's bytes and the injected context", async () => {
    const { host, guest } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 1, method: "page.boot", params: {} });
    await settle();

    const [response] = guest.sent;
    expect(response.kind).toBe("response");
    expect(response.ok).toBe(true);
    const value = response.value as { pluginId: string; entry: string; files: unknown[]; theme: unknown };
    expect(value.pluginId).toBe("ade-linear");
    expect(value.entry).toBe("index.html");
    expect(value.files).toHaveLength(1);
    expect(value.theme).toEqual({ scheme: "dark", tokens: { "--color-bg": "#000" } });
    expect(host.booted).toBe(true);
  });

  it("round-trips a verb and answers exactly once", async () => {
    const { host, guest, ui } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 7, method: "ui.toast", params: { toast: { level: "info", message: "hi" } } });
    await settle();

    expect(ui.toast).toHaveBeenCalledWith({ level: "info", message: "hi" });
    expect(guest.sent).toEqual([
      { channel: PLUGIN_PAGE_CHANNEL, v: PLUGIN_PAGE_PROTOCOL_VERSION, nonce: "NONCE", kind: "response", id: 7, ok: true, value: { id: "toast-1" } },
    ]);
  });

  it("refuses a method outside the closed list, and never drops the request", async () => {
    const { host, guest } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 2, method: "secrets.get", params: {} });
    await settle();
    expect(guest.sent[0]).toMatchObject({ id: 2, ok: false });
    expect(String(guest.sent[0].message)).toMatch(/isn’t part of the bridge/);
  });

  it("ignores a message with the wrong nonce", async () => {
    const { host, guest, ui } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 3, method: "ui.toast", params: { toast: { level: "info", message: "x" } } }, "GUESSED");
    await settle();
    expect(ui.toast).not.toHaveBeenCalled();
    expect(guest.sent).toEqual([]);
  });

  it("ignores a message from a window that is not the guest", async () => {
    const { host, guest, ui } = build();
    hosts.push(host);
    const impostor = fakeGuest();
    fromGuest(impostor.window, { kind: "request", id: 4, method: "ui.toast", params: { toast: { level: "info", message: "x" } } });
    await settle();
    expect(ui.toast).not.toHaveBeenCalled();
    expect(guest.sent).toEqual([]);
  });

  it("refuses a deeplink scheme a page must not reach", async () => {
    const { host, guest, ui } = build();
    hosts.push(host);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "blob:https://app.ade-app.dev/x"]) {
      fromGuest(guest.window, { kind: "request", id: 10, method: "openDeeplink", params: { url } });
    }
    await settle();
    expect(ui.openDeeplink).not.toHaveBeenCalled();
    expect(guest.sent.every((message) => message.ok === false)).toBe(true);

    fromGuest(guest.window, { kind: "request", id: 11, method: "openDeeplink", params: { url: "ade://lanes" } });
    await settle();
    expect(ui.openDeeplink).toHaveBeenCalledWith("ade://lanes");
  });

  it("refuses a collection write, because this transport has none", async () => {
    const { host, guest } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 5, method: "collections.put", params: { collection: "c", key: "k", value: 1 } });
    await settle();
    expect(guest.sent[0]).toMatchObject({ id: 5, ok: false });
    expect(String(guest.sent[0].message)).toMatch(/can’t save plugin data/);
  });

  it("caps a list read at the contract's page size", async () => {
    const { host, guest, data } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "request", id: 6, method: "collections.list", params: { collection: "c", limit: 99_999 } });
    await settle();
    expect(data.collectionsList).toHaveBeenCalledWith("c", { limit: 500 });
  });

  it("passes a resize through at the shared ceiling, and drops an unusable one", async () => {
    const { host, guest, ui } = build();
    hosts.push(host);
    fromGuest(guest.window, { kind: "resize", height: 12_000 });
    fromGuest(guest.window, { kind: "resize", height: 240.6 });
    // Not a height: dropped, never applied as zero. A page that measured
    // nothing must not collapse its own section.
    fromGuest(guest.window, { kind: "resize", height: 0 });
    fromGuest(guest.window, { kind: "resize", height: "tall" });
    await settle();
    expect(ui.resize).toHaveBeenNthCalledWith(1, PLUGIN_WEBVIEW_MAX_HEIGHT_PX);
    expect(ui.resize).toHaveBeenNthCalledWith(2, 241);
    expect(ui.resize).toHaveBeenCalledTimes(2);
  });

  it("stops answering once disposed", async () => {
    const { host, guest, ui } = build();
    host.dispose();
    fromGuest(guest.window, { kind: "request", id: 8, method: "ui.toast", params: { toast: { level: "info", message: "x" } } });
    await settle();
    expect(ui.toast).not.toHaveBeenCalled();
    expect(guest.sent).toEqual([]);
  });
});

describe("invoke", () => {
  it("applies the answer's control-flow verbs and resolves with the handler's result", async () => {
    const { host, guest, data } = build();
    hosts.push(host);
    data.invoke.mockResolvedValueOnce({ navigate: { tab: "lanes" } } as never);
    fromGuest(guest.window, { kind: "request", id: 1, method: "invoke", params: { action: "open", args: { a: 1 } } });
    await settle();

    expect(data.invoke).toHaveBeenCalledWith("open", { a: 1 });
    expect(applied).toEqual([{ result: { navigate: { tab: "lanes" } }, answeringPrompt: false }]);
    expect(guest.sent[0]).toMatchObject({ ok: true, value: { navigate: { tab: "lanes" } } });
  });

  it("asks one question, re-invokes once, and answers with the second result", async () => {
    const { host, guest, data, ui } = build();
    hosts.push(host);
    nextPromptAnswer = { id: "q", title: "Which?" };
    data.invoke.mockResolvedValueOnce({ prompt: { id: "q" } } as never).mockResolvedValueOnce({ done: true } as never);

    fromGuest(guest.window, { kind: "request", id: 1, method: "invoke", params: { action: "file", args: {} } });
    await settle();
    await settle();

    expect(ui.prompt).toHaveBeenCalledTimes(1);
    expect(data.invoke).toHaveBeenNthCalledWith(2, "file", { prompt: { id: "q", text: "typed" } });
    // The second pass is marked as answering, which is what stops a plugin
    // asking a second question and building a wizard out of one hop.
    expect(applied[1]).toEqual({ result: { done: true }, answeringPrompt: true });
    expect(guest.sent[0]).toMatchObject({ ok: true, value: { done: true } });
  });
});

describe("coalesceHostEvents", () => {
  it("merges a burst into one frame per kind", async () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const coalesced = coalesceHostEvents((event) => frames.push(event), 120);
    coalesced.deliver({ kind: "lane", ids: ["a"], overflow: false });
    coalesced.deliver({ kind: "lane", ids: ["b", "a"], overflow: false });
    coalesced.deliver({ kind: "pr", ids: ["1"], overflow: false });
    expect(frames).toEqual([]);
    vi.advanceTimersByTime(120);
    expect(frames).toEqual([
      { kind: "lane", ids: ["a", "b"], overflow: false },
      { kind: "pr", ids: ["1"], overflow: false },
    ]);
    coalesced.cancel();
    vi.useRealTimers();
  });

  it("says overflow rather than carrying an unbounded id list", () => {
    vi.useFakeTimers();
    const frames: Array<{ ids: string[]; overflow: boolean }> = [];
    const coalesced = coalesceHostEvents((event) => frames.push(event), 10);
    coalesced.deliver({ kind: "lane", ids: Array.from({ length: 400 }, (_, index) => `lane-${index}`), overflow: false });
    vi.advanceTimersByTime(10);
    expect(frames[0].ids).toHaveLength(200);
    expect(frames[0].overflow).toBe(true);
    coalesced.cancel();
    vi.useRealTimers();
  });
});
