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
