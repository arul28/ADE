import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { createPluginInstallService } from "./pluginInstallService";

function testLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify(manifest), "utf8");
}

describe("pluginInstallService beforeReplace (R7)", () => {
  afterEach(() => {
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  it("runs beforeReplace with the manifest's own id before the rename — even when the source path names something else", async () => {
    // The bug R7 fixes: the old stop-before-rename in `pluginHostService`
    // could only ever learn a plugin's id from a LOCAL DIRECTORY's path
    // before staging began — a git clone or a bundled copy reveals its id
    // only once the manifest is parsed. Naming the source directory
    // differently from the plugin's declared name proves this hook is keyed
    // off the STAGED manifest, the one mechanism that works for every kind.
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });

    const sourceV1 = scratchDir("ade-plugin-source-v1-");
    writeManifest(sourceV1, { name: "widget", version: "1.0.0" });
    await install.install({ source: sourceV1 });

    const calls: string[] = [];
    let targetContentsAtCallTime: string[] = [];
    const targetDir = path.join(pluginsRoot, "widget");
    const install2 = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      beforeReplace: (pluginId) => {
        calls.push(pluginId);
        // Called BEFORE the rename: the old install is still fully in place.
        targetContentsAtCallTime = fs.readdirSync(targetDir).sort();
      },
    });

    // The upload directory is named "upload-tmp-xyz", not "widget" — the old
    // guess (readManifestFromDirectory on the SOURCE path) would have found
    // no manifest at all here and skipped the stop entirely.
    const uploadDir = path.join(scratchDir("ade-plugin-source-v2-"), "upload-tmp-xyz");
    writeManifest(uploadDir, { name: "widget", version: "2.0.0" });

    const installed = await install2.install({ source: uploadDir });

    expect(calls).toEqual(["widget"]);
    expect(targetContentsAtCallTime).toContain("plugin.json");
    expect(installed.record.version).toBe("2.0.0");
    expect(installed.manifest?.version).toBe("2.0.0");
  });

  it("does not run beforeReplace on a first-time install — there is nothing to replace", async () => {
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const calls: string[] = [];
    const install = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      beforeReplace: (pluginId) => {
        calls.push(pluginId);
      },
    });

    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    await install.install({ source });

    expect(calls).toEqual([]);
  });

  it("propagates a beforeReplace failure and leaves the old install untouched", async () => {
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const sourceV1 = scratchDir("ade-plugin-source-v1-");
    writeManifest(sourceV1, { name: "widget", version: "1.0.0" });
    await install.install({ source: sourceV1 });

    const install2 = createPluginInstallService({
      logger: testLogger(),
      pluginsRoot,
      builtinPluginsRoot: null,
      beforeReplace: () => {
        throw new Error("child would not stop");
      },
    });
    const sourceV2 = scratchDir("ade-plugin-source-v2-");
    writeManifest(sourceV2, { name: "widget", version: "2.0.0" });

    await expect(install2.install({ source: sourceV2 })).rejects.toThrow(/child would not stop/);

    // The old install is exactly as it was — the rename never ran.
    const record = install.get("widget");
    expect(record?.record.version).toBe("1.0.0");
    expect(record?.manifest?.version).toBe("1.0.0");
  });
});

describe("pluginInstallService reload resyncs a local source", () => {
  afterEach(() => {
    while (scratchDirs.length) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  const readInstalled = (pluginsRoot: string, file: string): string =>
    fs.readFileSync(path.join(pluginsRoot, "widget", file), "utf8");

  it("serves the edited bytes, not the ones the install copied", async () => {
    // The round-2 alpha footgun: `reload` re-read whatever already sat in the
    // install directory, so five edit-and-reload cycles ran identical stale
    // code with no signal that anything was out of date. Only a second
    // `install` of the same path pushed an edit through.
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    fs.writeFileSync(path.join(source, "index.js"), "exports.actions = { drink: () => 1 };", "utf8");
    await install.install({ source });

    fs.writeFileSync(path.join(source, "index.js"), "exports.actions = { drink: () => 2 };", "utf8");
    const reloaded = install.reload("widget");

    expect(readInstalled(pluginsRoot, "index.js")).toContain("=> 2");
    expect(reloaded.warnings).toEqual([]);
  });

  it("picks up a version bump made in the source, and files the source deleted", async () => {
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    fs.writeFileSync(path.join(source, "stale.js"), "// removed later", "utf8");
    await install.install({ source });

    writeManifest(source, { name: "widget", version: "1.1.0" });
    fs.rmSync(path.join(source, "stale.js"));
    const reloaded = install.reload("widget");

    expect(reloaded.record.version).toBe("1.1.0");
    expect(reloaded.manifest?.version).toBe("1.1.0");
    // A full replace, as an install is: a file the author deleted is gone.
    expect(fs.existsSync(path.join(pluginsRoot, "widget", "stale.js"))).toBe(false);
  });

  it("keeps the installed copy and warns when the source folder is gone", async () => {
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    await install.install({ source });
    fs.rmSync(source, { recursive: true, force: true });

    const reloaded = install.reload("widget");

    // Refused, and it SAYS so: a silent no-op here is the same class of bug as
    // the stale bytes this resync exists to prevent.
    expect(reloaded.warnings.join(" ")).toMatch(/is gone/);
    expect(reloaded.manifest?.version).toBe("1.0.0");
    expect(readInstalled(pluginsRoot, "plugin.json")).toContain("1.0.0");
  });

  it("refuses a source that renamed itself to another plugin id", async () => {
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    await install.install({ source });

    writeManifest(source, { name: "gadget", version: "2.0.0" });
    const reloaded = install.reload("widget");

    expect(reloaded.warnings.join(" ")).toMatch(/now declares the id "gadget"/);
    expect(reloaded.manifest?.name).toBe("widget");
    expect(reloaded.record.version).toBe("1.0.0");
  });

  it("leaves a git-source install alone", async () => {
    // Nothing fetches on a reload, so a git install must re-read exactly the
    // bytes it already has — the resync is a local-source affordance only.
    const pluginsRoot = scratchDir("ade-plugin-install-");
    const install = createPluginInstallService({ logger: testLogger(), pluginsRoot, builtinPluginsRoot: null });
    const source = scratchDir("ade-plugin-source-");
    writeManifest(source, { name: "widget", version: "1.0.0" });
    await install.install({ source });

    // Rewrite the record as a git install, the way a clone would have left it.
    const statePath = path.join(pluginsRoot, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, { source: unknown }>;
    };
    state.plugins.widget!.source = { kind: "git", url: "https://example.test/widget.git" };
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");

    fs.writeFileSync(path.join(source, "index.js"), "// never copied", "utf8");
    const reloaded = install.reload("widget");

    expect(reloaded.warnings).toEqual([]);
    expect(fs.existsSync(path.join(pluginsRoot, "widget", "index.js"))).toBe(false);
  });
});
