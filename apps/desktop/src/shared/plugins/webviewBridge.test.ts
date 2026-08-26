import { describe, expect, it } from "vitest";

import type { PluginSessionContext } from "./context";
import {
  decodePluginWebviewContext,
  encodePluginWebviewContext,
  PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES,
  PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM,
  pluginWebviewUrl,
  type PluginWebviewContext,
} from "./webviewBridge";

const SESSION: PluginSessionContext = {
  kind: "session",
  id: "sess-1",
  title: "Fix auth",
  provider: "claude",
  status: "active",
};

describe("plugin webview context on the source URL", () => {
  it("round-trips a subject and a pointer", () => {
    const context: PluginWebviewContext = { subject: SESSION, pointer: { drink: 4 } };
    const encoded = encodePluginWebviewContext(context);
    expect(encoded).not.toBeNull();
    expect(decodePluginWebviewContext(encoded)).toEqual(context);
  });

  it("appends the context to the guest URL as one opaque query token, and omits it when absent", () => {
    const plain = pluginWebviewUrl("demo", "web/index.html");
    expect(plain).toBe("ade-plugin://demo/web/index.html");

    const withContext = pluginWebviewUrl("demo", "web/index.html", { subject: SESSION });
    const url = new URL(withContext);
    expect(url.pathname).toBe("/web/index.html");
    const raw = url.searchParams.get(PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM);
    expect(raw).not.toBeNull();
    expect(decodePluginWebviewContext(raw)).toEqual({ subject: SESSION });
  });

  // The subject is the host's own word about which chat/lane/PR, and a decode is
  // where a page's attempt to smuggle a non-context shape has to be dropped.
  it("keeps only a subject that looks like a context object", () => {
    expect(decodePluginWebviewContext(encodeURIComponent(JSON.stringify({ subject: { no: "kind" } }))))
      .toEqual({ subject: null });
    expect(decodePluginWebviewContext(encodeURIComponent(JSON.stringify({ subject: "hijack" }))))
      .toEqual({ subject: null });
    // A bare pointer with no subject still yields a null subject, never a subject
    // the page invented.
    expect(decodePluginWebviewContext(encodeURIComponent(JSON.stringify({ pointer: { a: 1 } }))))
      .toEqual({ subject: null, pointer: { a: 1 } });
  });

  it("degrades to no context on anything malformed", () => {
    for (const raw of [null, undefined, "", "%%%not-uri", encodeURIComponent("not json"), encodeURIComponent("[]"),
      encodeURIComponent("42")]) {
      expect(decodePluginWebviewContext(raw)).toBeNull();
    }
  });

  // The token rides on a URL captured host-side, so an oversize value is dropped
  // at encode time — a page opens without a subject rather than with a truncated
  // one, the same rule the navigation context follows.
  it("refuses to encode a context past the ceiling", () => {
    const huge: PluginWebviewContext = {
      subject: SESSION,
      pointer: { blob: "x".repeat(PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES + 1) },
    };
    expect(encodePluginWebviewContext(huge)).toBeNull();
    expect(pluginWebviewUrl("demo", "web/index.html", huge)).toBe("ade-plugin://demo/web/index.html");
  });
});
