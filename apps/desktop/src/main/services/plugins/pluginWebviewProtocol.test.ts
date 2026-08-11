import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PLUGIN_WEBVIEW_CSP } from "../../../shared/plugins/webviewBridge";
import { createPluginWebviewProtocolHandler } from "./pluginWebviewProtocol";

const tempRoots: string[] = [];

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-webview-"));
  tempRoots.push(root);
  // Realpath because macOS resolves `/var` through a symlink: the handler
  // compares real paths, and a test that held the symlinked spelling would be
  // asserting against a root the handler never sees.
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { handler: (request: { url: string }) => Response; pluginRoot: string; outside: string } {
  const machine = scratch();
  const pluginRoot = path.join(machine, "plugins", "demo-plugin");
  fs.mkdirSync(path.join(pluginRoot, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "index.html"), "<h1>hello</h1>", "utf8");
  fs.writeFileSync(path.join(pluginRoot, "app.js"), "export const x = 1;", "utf8");
  fs.writeFileSync(path.join(pluginRoot, "assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(pluginRoot, "notes.weird"), "unknown", "utf8");

  const outside = path.join(machine, "secrets.txt");
  fs.writeFileSync(outside, "do not serve", "utf8");
  fs.symlinkSync(outside, path.join(pluginRoot, "escape.txt"));

  const handler = createPluginWebviewProtocolHandler({
    resolvePluginRoot: (pluginId) => (pluginId === "demo-plugin" ? pluginRoot : null),
  });
  return { handler, pluginRoot, outside };
}

describe("createPluginWebviewProtocolHandler", () => {
  it("serves a file that lives inside the plugin directory", async () => {
    const { handler } = fixture();
    const response = handler({ url: "ade-plugin://demo-plugin/index.html" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>hello</h1>");
  });

  it("serves the directory index for the origin root", async () => {
    const { handler } = fixture();
    const response = handler({ url: "ade-plugin://demo-plugin/" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>hello</h1>");
  });

  it("never serves a file above the plugin directory through a literal ..", async () => {
    const { handler } = fixture();
    // A literal `..` never survives to the handler: `ade-plugin` is a STANDARD
    // scheme, so the URL parser collapses the segments and clamps at the origin
    // root. The escape attempt therefore reads as a request for a file the
    // plugin does not have — a 404 with none of the outside file's bytes. The
    // encoded spelling below is the one that reaches the traversal check.
    const response = handler({ url: "ade-plugin://demo-plugin/x/../../secrets.txt" });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("do not serve");
  });

  it("refuses an encoded parent-directory escape", async () => {
    const { handler } = fixture();
    // `%2e%2e%2f` survives URL normalization, so it only becomes `../` at the
    // decode step — which is why the decode happens before the containment
    // check and not after.
    const response = handler({ url: "ade-plugin://demo-plugin/%2e%2e%2fsecrets.txt" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("do not serve");
  });

  it("refuses an absolute path", () => {
    const { handler } = fixture();
    expect(handler({ url: "ade-plugin://demo-plugin/%2Fetc%2Fpasswd" }).status).toBe(403);
  });

  it("refuses a symlink that points outside the plugin directory", async () => {
    const { handler } = fixture();
    const response = handler({ url: "ade-plugin://demo-plugin/escape.txt" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("do not serve");
  });

  it("answers a directory request with 404 and never a listing", async () => {
    const { handler } = fixture();
    const response = handler({ url: "ade-plugin://demo-plugin/assets" });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("icon.png");
  });

  it("404s an unknown or disabled plugin", () => {
    const { handler } = fixture();
    expect(handler({ url: "ade-plugin://other-plugin/index.html" }).status).toBe(404);
  });

  it("names a content type from the closed map and falls back to octet-stream", () => {
    const { handler } = fixture();
    expect(handler({ url: "ade-plugin://demo-plugin/index.html" }).headers.get("Content-Type"))
      .toBe("text/html; charset=utf-8");
    expect(handler({ url: "ade-plugin://demo-plugin/app.js" }).headers.get("Content-Type"))
      .toBe("text/javascript; charset=utf-8");
    expect(handler({ url: "ade-plugin://demo-plugin/assets/icon.png" }).headers.get("Content-Type"))
      .toBe("image/png");
    expect(handler({ url: "ade-plugin://demo-plugin/notes.weird" }).headers.get("Content-Type"))
      .toBe("application/octet-stream");
  });

  it("carries the plugin CSP and nosniff on every response, refusals included", () => {
    const { handler } = fixture();
    const responses = [
      handler({ url: "ade-plugin://demo-plugin/index.html" }),
      handler({ url: "ade-plugin://demo-plugin/assets" }),
      handler({ url: "ade-plugin://demo-plugin/%2e%2e%2fsecrets.txt" }),
      handler({ url: "ade-plugin://other-plugin/index.html" }),
      handler({ url: "ade-plugin://demo-plugin/missing.html" }),
    ];
    for (const response of responses) {
      expect(response.headers.get("Content-Security-Policy")).toBe(PLUGIN_WEBVIEW_CSP);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
});
