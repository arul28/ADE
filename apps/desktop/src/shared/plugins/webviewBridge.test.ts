import { describe, expect, it } from "vitest";

import type { PluginSessionContext } from "./context";
import {
  clampPluginWebviewHeight,
  decodePluginWebviewContext,
  encodePluginWebviewContext,
  isPluginWebviewMethod,
  isPluginWebviewEventName,
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES,
  PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM,
  PLUGIN_WEBVIEW_EVENTS,
  PLUGIN_WEBVIEW_MAX_HEIGHT_PX,
  PLUGIN_WEBVIEW_METHODS,
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS,
  PLUGIN_WEBVIEW_UI_TIMEOUT_MS,
  pluginWebviewGuestKey,
  pluginWebviewKeepsGuestWhileHidden,
  pluginWebviewUiTimeoutMs,
  pluginWebviewUrl,
  readPluginWebviewPickerRect,
  sanitizePluginWebviewTheme,
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

describe("bridge v2 shape", () => {
  it("keeps every v1 method and adds the v2 verbs, and stays a closed list", () => {
    // v1 pages keep working: the promise the version number makes is that a
    // method is added, never removed or renamed.
    for (const method of [
      "collections.get",
      "collections.put",
      "collections.list",
      "invoke",
      "config.get",
      "config.set",
      "openDeeplink",
    ]) {
      expect(isPluginWebviewMethod(method)).toBe(true);
    }
    for (const method of [
      "openSettings",
      "surface.close",
      "composer.attach",
      "composer.insert",
      "ui.toast",
      "ui.dismissToast",
      "ui.prompt",
      "ui.confirm",
      "clipboard.read",
      "clipboard.write",
      "theme.get",
      "host.subscribe",
      "host.unsubscribe",
    ]) {
      expect(isPluginWebviewMethod(method)).toBe(true);
    }
    // The absences are the policy, not an oversight. See the module header.
    for (const method of ["secrets.get", "collections.delete", "panels.update", "contributions.publish"]) {
      expect(isPluginWebviewMethod(method)).toBe(false);
    }
    expect(new Set(PLUGIN_WEBVIEW_METHODS).size).toBe(PLUGIN_WEBVIEW_METHODS.length);
    expect(PLUGIN_WEBVIEW_BRIDGE_VERSION).toBe(2);
  });

  it("waits on a person longer than on a renderer", () => {
    expect(pluginWebviewUiTimeoutMs("ui.prompt")).toBe(PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS);
    expect(pluginWebviewUiTimeoutMs("ui.confirm")).toBe(PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS);
    expect(pluginWebviewUiTimeoutMs("ui.toast")).toBe(PLUGIN_WEBVIEW_UI_TIMEOUT_MS);
    expect(pluginWebviewUiTimeoutMs("actionResult")).toBe(PLUGIN_WEBVIEW_UI_TIMEOUT_MS);
    expect(PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS).toBeGreaterThan(PLUGIN_WEBVIEW_UI_TIMEOUT_MS);
  });

  it("names a guest by its webContents id", () => {
    expect(pluginWebviewGuestKey(42)).toBe("guest-42");
  });
});

describe("the surface a guest was drawn in", () => {
  it("round-trips a surface id and a placement the renderer named", () => {
    const context: PluginWebviewContext = {
      subject: null,
      surfaceId: "browser",
      placement: "popover",
    };
    expect(decodePluginWebviewContext(encodePluginWebviewContext(context))).toEqual(context);
  });

  it("drops a placement this host does not draw", () => {
    const encoded = encodeURIComponent(JSON.stringify({ subject: null, placement: "kiosk" }));
    expect(decodePluginWebviewContext(encoded)).toEqual({ subject: null });
  });

  it("never reads a project off the URL", () => {
    // `project` is the host's own word about the window's binding. A page that
    // could name one could claim to be open in a project it is not.
    const encoded = encodeURIComponent(JSON.stringify({
      subject: null,
      project: { projectId: "someone-elses", root: "/elsewhere", binding: "local" },
    }));
    expect(decodePluginWebviewContext(encoded)).toEqual({ subject: null });
  });
});

describe("sanitizePluginWebviewTheme", () => {
  it("keeps --ade-* tokens and drops everything else", () => {
    expect(sanitizePluginWebviewTheme({
      scheme: "light",
      tokens: { "--ade-bg": "#fff", "background": "#000", "--ade-fg": 12 },
    })).toEqual({ scheme: "light", tokens: { "--ade-bg": "#fff" } });
  });

  it("refuses a payload with no scheme, and bounds the token map", () => {
    expect(sanitizePluginWebviewTheme({ tokens: {} })).toBeNull();
    expect(sanitizePluginWebviewTheme("dark")).toBeNull();
    const tokens: Record<string, string> = {};
    for (let index = 0; index < 500; index += 1) tokens[`--ade-t${index}`] = "#fff";
    const sanitized = sanitizePluginWebviewTheme({ scheme: "dark", tokens });
    expect(Object.keys(sanitized?.tokens ?? {})).toHaveLength(400);
  });

  it("drops a value longer than the ceiling rather than truncating it", () => {
    const sanitized = sanitizePluginWebviewTheme({
      scheme: "dark",
      tokens: { "--ade-bg": "#".repeat(1_000) },
    });
    expect(sanitized).toEqual({ scheme: "dark", tokens: {} });
  });
});

describe("size-to-content", () => {
  it("clamps a reported height to the ceiling and rounds up a fraction", () => {
    expect(clampPluginWebviewHeight(240)).toBe(240);
    expect(clampPluginWebviewHeight(240.2)).toBe(241);
    expect(clampPluginWebviewHeight(99_999)).toBe(PLUGIN_WEBVIEW_MAX_HEIGHT_PX);
  });

  it("reads an unusable height as no answer rather than as zero", () => {
    // "The page said nothing usable" and "the page wants to be invisible" are
    // different instructions; collapsing them would hide a broken observer.
    for (const value of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, "240", null, undefined]) {
      expect(clampPluginWebviewHeight(value)).toBeNull();
    }
  });

  it("names one channel both halves agree on", () => {
    expect(PLUGIN_WEBVIEW_RESIZE_CHANNEL).toBe("ade:plugin-webview:resize");
  });
});

describe("plugin webview events", () => {
  it("accepts refresh alongside changed, theme and host", () => {
    expect(PLUGIN_WEBVIEW_EVENTS).toEqual(["changed", "theme", "host", "refresh"]);
    expect(isPluginWebviewEventName("refresh")).toBe(true);
    expect(isPluginWebviewEventName("unknown")).toBe(false);
  });
});

describe("pluginWebviewKeepsGuestWhileHidden", () => {
  it("keeps tabs and panes, and destroys anchored placements", () => {
    expect(pluginWebviewKeepsGuestWhileHidden("tab")).toBe(true);
    expect(pluginWebviewKeepsGuestWhileHidden("pane")).toBe(true);
    expect(pluginWebviewKeepsGuestWhileHidden("popover")).toBe(false);
    expect(pluginWebviewKeepsGuestWhileHidden("overlay")).toBe(false);
    expect(pluginWebviewKeepsGuestWhileHidden("drawer")).toBe(false);
    expect(pluginWebviewKeepsGuestWhileHidden("composer-picker")).toBe(false);
    expect(pluginWebviewKeepsGuestWhileHidden("dialog-picker")).toBe(false);
    expect(pluginWebviewKeepsGuestWhileHidden("settings-section")).toBe(false);
  });
});

describe("readPluginWebviewPickerRect", () => {
  it("reads a guest-relative box and drops anything else", () => {
    expect(readPluginWebviewPickerRect({ top: 12, left: 40, width: 80, height: 24 }))
      .toEqual({ top: 12, left: 40, width: 80, height: 24 });
    expect(readPluginWebviewPickerRect({ top: 12, left: 40 })).toEqual({ top: 12, left: 40 });
    expect(readPluginWebviewPickerRect({ top: "x", left: 1 })).toBeNull();
    expect(readPluginWebviewPickerRect(null)).toBeNull();
  });
});
