import { describe, expect, it } from "vitest";
import {
  comparePluginVersions,
  isPluginSupportedByAdeVersion,
  isSafePluginRelativePath,
  isValidPluginId,
  parsePluginManifest,
  parsePluginManifestJson,
  pluginHasRuntimeEntry,
} from "./manifest";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "graph",
    version: "1.2.0",
    displayName: "Graph",
    description: "Lane and PR graph.",
    icon: "graph",
    accent: "#7C6FF0",
    minAdeVersion: "1.3.0",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
    panels: [{ id: "main", schemaFile: "panels/main.json" }],
    sockets: [{ socket: "row-badge", surface: "lanes", id: "drift", label: "Drift" }],
    collections: { issues: { sync: true }, scratch: {} },
    settings: [{ key: "defaultLane", kind: "select", label: "Default lane", optionsAction: "listLanes" }],
    cli: ["issues", "open"],
    skills: ["skills/using-graph"],
    official: false,
    ...overrides,
  };
}

describe("parsePluginManifest", () => {
  it("parses a complete valid manifest with no errors", () => {
    const result = parsePluginManifest(validManifest());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const manifest = result.manifest!;
    expect(manifest.name).toBe("graph");
    expect(manifest.surfaces).toHaveLength(1);
    expect(manifest.collections).toEqual({ issues: { sync: true }, scratch: { sync: false } });
    expect(manifest.cli).toEqual(["issues", "open"]);
    expect(pluginHasRuntimeEntry(manifest)).toBe(true);
  });

  // The whole point of the tolerant half: a manifest written against a newer
  // ADE must still load here, minus the fields this build cannot use.
  it("ignores unknown top-level keys instead of failing", () => {
    const result = parsePluginManifest(validManifest({
      futureFeature: { enabled: true },
      permissions: ["network"],
    }));
    expect(result.errors).toEqual([]);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest as unknown as Record<string, unknown>).not.toHaveProperty("futureFeature");
  });

  it("rejects an identity that could not be a directory name", () => {
    for (const name of ["Graph", "../escape", "graph plugin", "", "9lives"]) {
      const result = parsePluginManifest(validManifest({ name }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.manifest).toBeNull();
    }
    expect(isValidPluginId("graph-2")).toBe(true);
    expect(isValidPluginId("Graph")).toBe(false);
  });

  it("rejects a non-semver version and a malformed accent", () => {
    expect(parsePluginManifest(validManifest({ version: "1.2" })).errors.length).toBeGreaterThan(0);
    expect(parsePluginManifest(validManifest({ accent: "rebeccapurple" })).errors.length).toBeGreaterThan(0);
  });

  it("refuses an entry or schemaFile that escapes the plugin directory", () => {
    expect(parsePluginManifest(validManifest({ entry: "../../etc/passwd" })).errors.length).toBeGreaterThan(0);
    expect(parsePluginManifest(validManifest({ entry: "/abs/index.js" })).errors.length).toBeGreaterThan(0);
    const escapingPanel = parsePluginManifest(validManifest({
      panels: [{ id: "main", schemaFile: "../outside.json" }],
    }));
    expect(escapingPanel.manifest?.panels).toEqual([]);
    expect(escapingPanel.warnings.length).toBeGreaterThan(0);
    expect(isSafePluginRelativePath("panels/main.json")).toBe(true);
    expect(isSafePluginRelativePath("panels/../../main.json")).toBe(false);
  });

  // A badge with no label renders nothing. It used to parse clean and then
  // vanish downstream, which left an author with a manifest ADE said was fine
  // and a surface that never showed their contribution.
  it("refuses a socket that could not render, and says which field is missing", () => {
    const result = parsePluginManifest(validManifest({
      sockets: [
        { socket: "row-badge", surface: "lanes", id: "unlabelled" },
        { socket: "filter-chip", surface: "prs", id: "no-label" },
        { socket: "row-badge", surface: "lanes", id: "drift", label: "Drift" },
      ],
    }));

    expect(result.errors).toEqual([]);
    expect(result.manifest?.sockets.map((socket) => socket.id)).toEqual(["drift"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.includes("requires label"))).toBe(true);
  });

  // A malformed entry is dropped with a warning, not fatal: one bad socket must
  // not cost the user the other nine contributions.
  it("drops a malformed socket entry and keeps the rest of the manifest", () => {
    const result = parsePluginManifest(validManifest({
      sockets: [
        { socket: "row-badge", surface: "lanes", id: "drift", label: "Drift" },
        { socket: "not-a-socket", surface: "lanes", id: "bogus" },
        { socket: "detail-section", surface: "prs", id: "missing-panel" },
      ],
    }));
    expect(result.errors).toEqual([]);
    expect(result.manifest?.sockets.map((socket) => socket.id)).toEqual(["drift"]);
    expect(result.warnings).toHaveLength(2);
  });

  it("requires a file-viewer socket to declare extensions and a panel", () => {
    const ok = parsePluginManifest(validManifest({
      sockets: [{ socket: "file-viewer", surface: "files", id: "video", panelId: "player", extensions: [".MP4"] }],
    }));
    expect(ok.manifest?.sockets[0]).toMatchObject({ panelId: "player", extensions: [".mp4"] });

    const missing = parsePluginManifest(validManifest({
      sockets: [{ socket: "file-viewer", surface: "files", id: "video", panelId: "player" }],
    }));
    expect(missing.manifest?.sockets).toEqual([]);
  });

  it("keeps only allowlisted theme tokens", () => {
    const result = parsePluginManifest(validManifest({
      theme: {
        tokens: {
          dark: { "--color-accent": "#fff", "--evil-injection": "url(x)" },
          light: {},
        },
      },
    }));
    expect(result.manifest?.theme?.tokens.dark).toEqual({ "--color-accent": "#fff" });
    expect(result.warnings.some((warning) => warning.includes("--evil-injection"))).toBe(true);
  });

  it("treats a UI-only plugin with no entry as valid", () => {
    const result = parsePluginManifest(validManifest({ entry: undefined }));
    expect(result.errors).toEqual([]);
    expect(pluginHasRuntimeEntry(result.manifest!)).toBe(false);
  });

  it("reports invalid JSON as an error rather than throwing", () => {
    const result = parsePluginManifestJson("{ not json");
    expect(result.manifest).toBeNull();
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });
});

describe("webview surfaces", () => {
  const webviewSurface = (overrides: Record<string, unknown> = {}) => validManifest({
    surfaces: [{
      kind: "webview",
      id: "board",
      title: "Board",
      panelId: "main",
      entryHtml: "web/index.html",
      ...overrides,
    }],
  });

  it("parses a webview surface with its entry page", () => {
    const result = parsePluginManifest(webviewSurface());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.manifest!.surfaces[0]).toMatchObject({
      kind: "webview",
      entryHtml: "web/index.html",
      panelId: "main",
    });
  });

  // The whole cross-surface promise rests on this: every webview names the
  // panel iOS, the web client and the TUI render in its place.
  it("drops a webview surface that names no panel", () => {
    const result = parsePluginManifest(webviewSurface({ panelId: undefined }));
    expect(result.manifest!.surfaces).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/panelId is missing/);
  });

  it("drops a webview surface with no entry page", () => {
    const result = parsePluginManifest(webviewSurface({ entryHtml: undefined }));
    expect(result.manifest!.surfaces).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/entryHtml must be a relative path/);
  });

  it.each([
    ["traversal", "../../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["backslash", "web\\index.html"],
    ["nested traversal", "web/../../secrets.html"],
  ])("refuses an entry page that escapes the plugin (%s)", (_label, entryHtml) => {
    const result = parsePluginManifest(webviewSurface({ entryHtml }));
    expect(result.manifest!.surfaces).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/entryHtml must be a relative path/);
  });

  // A page is a document, not a script or a binary: the protocol serves what the
  // manifest names, so the extension is where that is settled.
  it("refuses an entry page that is not HTML", () => {
    const result = parsePluginManifest(webviewSurface({ entryHtml: "web/index.js" }));
    expect(result.manifest!.surfaces).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/must name an \.html file/);
  });

  it("ignores entryHtml on a surface that is not a webview", () => {
    const result = parsePluginManifest(validManifest({
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main", entryHtml: "web/index.html" }],
    }));
    expect(result.errors).toEqual([]);
    expect(result.manifest!.surfaces[0]).not.toHaveProperty("entryHtml");
    expect(result.warnings.join(" ")).toMatch(/applies only to a "webview" surface/);
  });

  it("refuses to let a webview surface also gate a compiled tab", () => {
    const result = parsePluginManifest(validManifest({
      official: true,
      surfaces: [{
        kind: "webview",
        id: "board",
        title: "Board",
        panelId: "main",
        entryHtml: "web/index.html",
        builtin: "graph",
      }],
    }));
    expect(result.manifest!.surfaces[0]).not.toHaveProperty("builtin");
    expect(result.warnings.join(" ")).toMatch(/cannot be combined with a "webview" surface/);
  });

  it("refuses a surface kind it does not know", () => {
    const result = parsePluginManifest(validManifest({
      surfaces: [{ kind: "overlay", id: "x", title: "X", panelId: "main" }],
    }));
    expect(result.manifest!.surfaces).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/kind must be "tab", "pane" or "webview"/);
  });
});

describe("isPluginSupportedByAdeVersion", () => {
  it("compares against the declared floor", () => {
    const manifest = parsePluginManifest(validManifest({ minAdeVersion: "1.3.0" })).manifest!;
    expect(isPluginSupportedByAdeVersion(manifest, "1.3.0")).toBe(true);
    expect(isPluginSupportedByAdeVersion(manifest, "1.4.1")).toBe(true);
    expect(isPluginSupportedByAdeVersion(manifest, "1.2.57")).toBe(false);
  });

  // An unreadable host version must not lock a user out of plugins they have
  // already installed and are already using.
  it("assumes support when the host version is unknown", () => {
    const manifest = parsePluginManifest(validManifest({ minAdeVersion: "9.9.9" })).manifest!;
    expect(isPluginSupportedByAdeVersion(manifest, null)).toBe(true);
    expect(isPluginSupportedByAdeVersion(manifest, "dev")).toBe(true);
  });

  it("orders versions numerically, not lexically", () => {
    expect(comparePluginVersions("1.10.0", "1.9.0")).toBe(1);
    expect(comparePluginVersions("1.2.0", "1.2.0")).toBe(0);
    expect(comparePluginVersions("1.2.0-beta.1", "1.2.0")).toBe(0);
  });
});
