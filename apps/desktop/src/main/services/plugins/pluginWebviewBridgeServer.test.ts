import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginManifest } from "../../../shared/plugins/manifest";
import { PluginSdkError, type PluginDetail } from "../../../shared/plugins/sdk";
import { PLUGIN_WEBVIEW_BRIDGE_VERSION } from "../../../shared/plugins/webviewBridge";
import {
  createPluginWebviewBridgeServer,
  type PluginWebviewBridgeServer,
  type PluginWebviewDomain,
} from "./pluginWebviewBridgeServer";
import { registerPluginWebviewGuest, resetPluginWebviewGuestsForTests } from "./pluginWebviewGuests";

const GUEST_WEB_CONTENTS_ID = 42;

function manifestFor(pluginId: string): PluginManifest {
  return {
    name: pluginId,
    version: "1.0.0",
    displayName: pluginId,
    description: "",
    vocabVersion: 1,
    surfaces: [],
    panels: [],
    sockets: [],
    collections: { notes: { sync: false } },
    settings: [],
    cli: [],
    skills: [],
    tools: [],
    automationTriggers: [],
    automationSteps: [],
    searchProviders: [],
    keybindings: [],
    chatRuntimes: [],
    webhookIngress: [],
    official: false,
  };
}

type Harness = {
  server: PluginWebviewBridgeServer;
  domain: {
    get: ReturnType<typeof vi.fn>;
    getCollection: ReturnType<typeof vi.fn>;
    getManifest: ReturnType<typeof vi.fn>;
    invoke: ReturnType<typeof vi.fn>;
  };
  putCollection: ReturnType<typeof vi.fn>;
  openDeeplink: ReturnType<typeof vi.fn>;
  openExternalUrl: ReturnType<typeof vi.fn>;
};

const servers: PluginWebviewBridgeServer[] = [];

function harness(): Harness {
  registerPluginWebviewGuest({
    webContentsId: GUEST_WEB_CONTENTS_ID,
    pluginId: "demo-plugin",
    hostWindowId: 1,
    context: null,
    send: () => {},
  });
  const domain = {
    get: vi.fn(async (): Promise<PluginDetail | null> => (
      { config: { token: "from-host" } } as unknown as PluginDetail
    )),
    getCollection: vi.fn(async (args: { pluginId: string }) => [
      { collection: "notes", key: "a", value: { owner: args.pluginId }, updatedAt: "" },
    ]),
    getManifest: vi.fn(async (args: { pluginId: string }) => manifestFor(args.pluginId)),
    invoke: vi.fn(async (args: { pluginId: string; action: string }) => `${args.pluginId}:${args.action}`),
  };
  const putCollection = vi.fn(async () => {});
  const openDeeplink = vi.fn(async () => {});
  const openExternalUrl = vi.fn(async () => {});
  const server = createPluginWebviewBridgeServer({
    domainFor: () => domain as unknown as PluginWebviewDomain,
    putCollection,
    openDeeplink,
    openExternalUrl,
  });
  servers.push(server);
  return { server, domain, putCollection, openDeeplink, openExternalUrl };
}

const SENDER = {
  webContentsId: GUEST_WEB_CONTENTS_ID,
  frameUrl: "ade-plugin://demo-plugin/index.html",
};

function request(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { bridgeVersion: PLUGIN_WEBVIEW_BRIDGE_VERSION, method, params };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.dispose();
  resetPluginWebviewGuestsForTests();
});

describe("createPluginWebviewBridgeServer", () => {
  it("answers against the sender's plugin id and never a pluginId in the payload", async () => {
    const { server, domain } = harness();
    const result = await server.handle(SENDER, request("invoke", {
      action: "refresh",
      // There is no `pluginId` field in `PluginWebviewRequest`; supplying one
      // has to change nothing at all.
      pluginId: "other-plugin",
      args: { pluginId: "other-plugin" },
    }));
    expect(result).toBe("demo-plugin:refresh");
    expect(domain.invoke).toHaveBeenCalledWith({
      pluginId: "demo-plugin",
      action: "refresh",
      args: { pluginId: "other-plugin" },
    });
  });

  it("reads collections for the sender's plugin whatever the payload claims", async () => {
    const { server, domain } = harness();
    const rows = await server.handle(SENDER, request("collections.list", {
      collection: "notes",
      pluginId: "other-plugin",
    }));
    expect(rows).toEqual([{ key: "a", value: { owner: "demo-plugin" } }]);
    expect(domain.getCollection).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "demo-plugin", collection: "notes" }),
    );
  });

  it("refuses a sender that was never registered as a plugin guest", async () => {
    const { server } = harness();
    await expect(
      server.handle({ webContentsId: 999, frameUrl: "ade-plugin://demo-plugin/index.html" }, request("config.get")),
    ).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("reports the guest's pinned id and injected subject in the handshake", () => {
    const { server } = harness();
    // The harness registers a subject-less guest; overwrite it with one carrying
    // a session subject, the way `main.ts` does for a drawer tab or an overlay.
    registerPluginWebviewGuest({
      webContentsId: GUEST_WEB_CONTENTS_ID,
      pluginId: "demo-plugin",
      hostWindowId: 1,
      context: { subject: { kind: "session", id: "sess-1", title: "Fix", provider: null, status: null } },
      send: () => {},
    });
    expect(server.resolveHandshake(SENDER)).toEqual({
      pluginId: "demo-plugin",
      context: { subject: { kind: "session", id: "sess-1", title: "Fix", provider: null, status: null } },
    });
    // A stranger gets nothing to vouch for — the same grounds every call is
    // refused on.
    expect(server.resolveHandshake({ webContentsId: 999, frameUrl: "ade-plugin://demo-plugin/index.html" }))
      .toBeNull();
  });

  it("refuses a sender whose frame origin disagrees with the registry", async () => {
    const { server } = harness();
    await expect(
      server.handle(
        { webContentsId: GUEST_WEB_CONTENTS_ID, frameUrl: "ade-plugin://other-plugin/index.html" },
        request("config.get"),
      ),
    ).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("refuses a collection the manifest does not declare, on read and on write", async () => {
    const { server, putCollection } = harness();
    await expect(
      server.handle(SENDER, request("collections.get", { collection: "secrets", key: "a" })),
    ).rejects.toBeInstanceOf(PluginSdkError);
    await expect(
      server.handle(SENDER, request("collections.put", { collection: "secrets", key: "a", value: 1 })),
    ).rejects.toMatchObject({ code: "not_permitted" });
    expect(putCollection).not.toHaveBeenCalled();
  });

  it("writes a declared collection through the injected writer", async () => {
    const { server, putCollection } = harness();
    await server.handle(SENDER, request("collections.put", { collection: "notes", key: "a", value: { n: 1 } }));
    expect(putCollection).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "notes", key: "a", value: { n: 1 } }),
    );
  });

  it("opens ade:// through the deeplink dispatch and https through the browser", async () => {
    const { server, openDeeplink, openExternalUrl } = harness();
    await server.handle(SENDER, request("openDeeplink", { url: "ade://lane/abc" }));
    await server.handle(SENDER, request("openDeeplink", { url: "https://example.com/docs" }));
    expect(openDeeplink).toHaveBeenCalledWith(expect.objectContaining({ url: "ade://lane/abc" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("refuses file: and javascript: links", async () => {
    const { server, openDeeplink, openExternalUrl } = harness();
    await expect(
      server.handle(SENDER, request("openDeeplink", { url: "file:///etc/passwd" })),
    ).rejects.toMatchObject({ code: "not_permitted" });
    await expect(
      server.handle(SENDER, request("openDeeplink", { url: "javascript:alert(1)" })),
    ).rejects.toMatchObject({ code: "not_permitted" });
    expect(openDeeplink).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("refuses a method outside the closed list and a version this host never shipped", async () => {
    const { server } = harness();
    await expect(
      server.handle(SENDER, request("secrets.get", { name: "TOKEN" })),
    ).rejects.toMatchObject({ code: "unsupported_method" });
    await expect(
      server.handle(SENDER, {
        bridgeVersion: PLUGIN_WEBVIEW_BRIDGE_VERSION + 1,
        method: "config.get",
        params: {},
      }),
    ).rejects.toMatchObject({ code: "unsupported_method" });
  });
});
