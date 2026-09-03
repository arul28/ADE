import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parsePluginManifestJson } from "../../../shared/plugins/manifest";
import type { PluginSocketKind } from "../../../shared/plugins/sockets";
import {
  PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT,
  PLUGIN_SOCKET_WEBVIEW_PLACEMENT,
  resolvePluginDeclaredWebview,
  resolvePluginSlotWebview,
  type PluginWebviewInstalledRow,
} from "./sockets/pluginDeclaredWebview";

/**
 * Every `webviewSurfaceId` the shipped Linear plugin declares, resolved against
 * the surfaces it also declares, and pinned to the placement it reaches.
 *
 * This is G15 as an assertion rather than a promise. The field was inert for a
 * whole release: the manifest named a page on nine sockets, the parser carried
 * it, and exactly one host — the settings section — ever read it, so the plugin
 * was reachable as a rail tab and nowhere else. A declaration nothing resolves
 * is indistinguishable from a typo, and neither the author nor the reader can
 * see the difference.
 *
 * So the test reads the REAL `plugins/ade-linear/plugin.json` rather than a
 * fixture. A fixture would prove the resolver is self-consistent; the shipped
 * manifest is what has to resolve, and a renamed surface or a socket that
 * quietly lost its page fails here rather than in an acceptance walk.
 *
 * A pure resolution test on purpose: it asks what each declaration RESOLVES to,
 * not what any component draws. The eight hosts have their own render tests;
 * what none of them can see is the table — which socket kind opens a page
 * where — and that is the thing a reordered manifest or a new kind breaks.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const manifestPath = path.join(repoRoot, "plugins/ade-linear/plugin.json");

const parsed = parsePluginManifestJson(fs.readFileSync(manifestPath, "utf8"));

/**
 * The installed-plugin summary the renderer resolves against, built from the
 * manifest's own surfaces — which is exactly what the registry does with them.
 */
function installedFromManifest(): PluginWebviewInstalledRow[] {
  const manifest = parsed.manifest;
  if (!manifest) throw new Error("ade-linear's manifest did not parse");
  return [{
    pluginId: manifest.name,
    enabled: true,
    tabs: manifest.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      entryHtml: surface.entryHtml ?? null,
      panelId: surface.panelId,
    })),
  }];
}

/** The sockets that declare a page, as `{kind, socketId, surfaceId}` rows. */
function declaringSockets(): { kind: PluginSocketKind; socketId: string; surfaceId: string }[] {
  const manifest = parsed.manifest;
  if (!manifest) throw new Error("ade-linear's manifest did not parse");
  return manifest.sockets
    .filter((socket): socket is typeof socket & { webviewSurfaceId: string } => (
      typeof socket.webviewSurfaceId === "string" && socket.webviewSurfaceId.length > 0
    ))
    .map((socket) => ({
      kind: socket.socket,
      socketId: socket.id,
      surfaceId: socket.webviewSurfaceId,
    }));
}

describe("ade-linear's declared pages", () => {
  it("parses the shipped manifest", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.name).toBe("ade-linear");
  });

  it("declares a page on every socket the page tier ports", () => {
    // The nine placements the port carries. Named rather than counted, so a
    // socket that silently loses its page is a failure with a name in it.
    expect(declaringSockets().map((entry) => entry.socketId).sort()).toEqual([
      "attach-issue",
      "chat-issue",
      "connection",
      "create-lane-issue",
      "create-pr-issue",
      "issue-context",
      "issues-pane",
      "lane-issue",
      "top-bar-issues",
    ]);
  });

  it("resolves every declared surface id to a webview surface with a page", () => {
    const installed = installedFromManifest();
    for (const socket of declaringSockets()) {
      const page = resolvePluginDeclaredWebview({
        pluginId: "ade-linear",
        surfaceId: socket.surfaceId,
        installed,
        supported: true,
      });
      expect(page, `${socket.socketId} → ${socket.surfaceId}`).not.toBeNull();
      expect(page?.surfaceId).toBe(socket.surfaceId);
      expect(page?.entryHtml).toBe("dist/index.html");
    }
  });

  it("reaches a concrete placement from every declaring socket", () => {
    const placements = Object.fromEntries(
      declaringSockets().map((socket) => [
        socket.socketId,
        PLUGIN_SOCKET_WEBVIEW_PLACEMENT[socket.kind] ?? null,
      ]),
    );
    // The whole point of the gap: a declaration with no placement is a page
    // nothing can draw. Pinned per kind rather than merely asserted non-null,
    // because "somewhere" is not a design — the rail pane must not open a
    // popover and the top-bar button must not take over the tab.
    expect(placements).toEqual({
      "issues-pane": "pane",
      "attach-issue": "composer-picker",
      "chat-issue": "popover",
      "lane-issue": "popover",
      connection: "settings-section",
      "top-bar-issues": "popover",
      "issue-context": "pane",
      // G12: the Create-lane and Create-PR issue pickers, which the vocabulary
      // could not be — a search box over a live list.
      "create-lane-issue": "dialog-picker",
      "create-pr-issue": "dialog-picker",
    });
    expect(Object.values(placements)).not.toContain(null);
  });

  it("gives every action-shaped socket the placement its press opens", () => {
    // The second table, in the vocabulary `openPluginActionWebview` speaks. The
    // composer's `picker` becomes a `composer-picker` guest, which is the one
    // place the two tables use different words for one thing.
    const pressed = Object.fromEntries(
      declaringSockets()
        .filter((socket) => PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT[socket.kind])
        .map((socket) => [socket.socketId, PLUGIN_SOCKET_WEBVIEW_ACTION_PLACEMENT[socket.kind]]),
    );
    expect(pressed).toEqual({
      "attach-issue": "picker",
      "chat-issue": "popover",
      "lane-issue": "popover",
      "top-bar-issues": "popover",
    });
  });

  it("resolves the rail pane's page by its declared id, not by declaration order", () => {
    const manifest = parsed.manifest;
    if (!manifest) throw new Error("ade-linear's manifest did not parse");
    const railPane = manifest.sockets.find((socket) => socket.id === "issues-pane");
    expect(railPane?.panelId).toBe("issues");
    expect(railPane?.webviewSurfaceId).toBe("issues");

    // The whole slot resolution, declared id and panel fallback in one call.
    // With the declaration it is `issues` whatever the manifest's order is;
    // strip the declaration and it is whichever page named `panelId: "issues"`
    // first, which is the ambiguity the field exists to remove.
    const installed = installedFromManifest();
    const declared = resolvePluginSlotWebview({
      pluginId: "ade-linear",
      panelId: "issues",
      payload: { label: "Linear", panelId: "issues", webviewSurfaceId: "quickview" },
      installed,
      supported: true,
    });
    expect(declared?.surfaceId).toBe("quickview");

    const byPanel = resolvePluginSlotWebview({
      pluginId: "ade-linear",
      panelId: "issues",
      payload: { label: "Linear", panelId: "issues" },
      installed,
      supported: true,
    });
    expect(byPanel?.surfaceId).toBe(
      manifest.surfaces.find((surface) => surface.kind === "webview" && surface.panelId === "issues")?.id,
    );

    // A declared id that resolves to nothing draws the PANEL rather than
    // falling through to a page the socket did not name.
    expect(resolvePluginSlotWebview({
      pluginId: "ade-linear",
      panelId: "issues",
      payload: { label: "Linear", panelId: "issues", webviewSurfaceId: "renamed" },
      installed,
      supported: true,
    })).toBeNull();
  });

  it("resolves the rail pane by its declared id, not by declaration order", () => {
    // Three surfaces share `panelId: "issues"` — `issues`, `quickview` and
    // `picker` — so a host that matched on the panel alone would resolve the
    // rail pane by whichever was declared FIRST. It happens to be the right one
    // today, which is exactly why the ambiguity is worth a test: reordering the
    // manifest would silently put the popover's page in the rail.
    const manifest = parsed.manifest;
    if (!manifest) throw new Error("ade-linear's manifest did not parse");
    const sharingPanel = manifest.surfaces
      .filter((surface) => surface.kind === "webview" && surface.panelId === "issues")
      .map((surface) => surface.id);
    expect(sharingPanel.length).toBeGreaterThan(1);

    const railPane = manifest.sockets.find((socket) => socket.id === "issues-pane");
    expect(railPane?.webviewSurfaceId).toBe("issues");
    expect(resolvePluginDeclaredWebview({
      pluginId: "ade-linear",
      surfaceId: railPane?.webviewSurfaceId,
      installed: installedFromManifest(),
      supported: true,
    })?.surfaceId).toBe("issues");
  });
});

describe("resolvePluginDeclaredWebview", () => {
  const installed: PluginWebviewInstalledRow[] = [{
    pluginId: "acme",
    enabled: true,
    tabs: [
      { id: "page", kind: "webview", entryHtml: "dist/index.html", panelId: "main" },
      { id: "no-bytes", kind: "webview", entryHtml: null, panelId: "main" },
      { id: "not-a-page", kind: "tab", entryHtml: "dist/index.html", panelId: "main" },
    ],
  }];

  it("answers the page for a resolvable declaration", () => {
    expect(resolvePluginDeclaredWebview({
      pluginId: "acme",
      surfaceId: "page",
      installed,
      supported: true,
    })).toEqual({ surfaceId: "page", entryHtml: "dist/index.html" });
  });

  it("answers null for every ordinary reason, so the caller draws its panel", () => {
    const base = { pluginId: "acme", installed, supported: true };
    // No declaration at all.
    expect(resolvePluginDeclaredWebview({ ...base, surfaceId: undefined })).toBeNull();
    // A client with no page host — the terminal, an older build.
    expect(resolvePluginDeclaredWebview({ ...base, surfaceId: "page", supported: false })).toBeNull();
    // An id that names nothing, a surface that is not a page, a page with no
    // bytes, and a plugin that is not installed or is switched off.
    expect(resolvePluginDeclaredWebview({ ...base, surfaceId: "gone" })).toBeNull();
    expect(resolvePluginDeclaredWebview({ ...base, surfaceId: "not-a-page" })).toBeNull();
    expect(resolvePluginDeclaredWebview({ ...base, surfaceId: "no-bytes" })).toBeNull();
    expect(resolvePluginDeclaredWebview({ ...base, pluginId: "other", surfaceId: "page" })).toBeNull();
    expect(resolvePluginDeclaredWebview({
      ...base,
      surfaceId: "page",
      installed: [{ ...installed[0]!, enabled: false }],
    })).toBeNull();
  });
});
