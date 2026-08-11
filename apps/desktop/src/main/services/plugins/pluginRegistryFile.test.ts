import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parsePluginRegistryContents,
  pluginRegistryFilePath,
  readPluginInstallRecords,
  readPluginRegistryFile,
} from "./pluginRegistryFile";

/**
 * The version 1 → 2 upgrade, which is what an existing machine experiences when
 * it first runs a build with no seeding in it.
 *
 * This is the single line that removes the plugins round 1 put on every machine,
 * so the thing worth proving is not that it drops them — it is that it drops
 * ONLY them, and that reading twice says the same thing both times. A migration
 * that also took a user's own local install with it would be silent data loss
 * with no undo, and nothing else in the tree exercises this path.
 */

const scratchDirs: string[] = [];

function scratchRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-registry-"));
  scratchDirs.push(dir);
  return dir;
}

function writeState(root: string, contents: unknown): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pluginRegistryFilePath(root), JSON.stringify(contents, null, 2));
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const LEGACY_STATE = {
  version: 1,
  removedBuiltins: ["ade-theme-ink"],
  plugins: {
    "ade-graph": {
      pluginId: "ade-graph",
      version: "1.0.0",
      enabled: true,
      source: { kind: "builtin" },
      installedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
    "my-plugin": {
      pluginId: "my-plugin",
      version: "0.2.0",
      enabled: true,
      source: { kind: "local", path: "/Users/someone/code/my-plugin" },
      installedAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      disabledContributions: ["socket:row"],
    },
    "team-plugin": {
      pluginId: "team-plugin",
      version: "3.1.0",
      enabled: false,
      source: { kind: "git", url: "https://github.com/example/team-plugin", ref: "v3.1.0" },
      installedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  },
};

describe("plugin registry file — version 1 upgrade", () => {
  it("drops seeded builtin records and keeps everything the user installed", () => {
    const root = scratchRoot();
    writeState(root, LEGACY_STATE);

    const records = readPluginInstallRecords(root);
    expect([...records.keys()]).toEqual(["my-plugin", "team-plugin"]);
    // The settings that survive a version bump: an off contribution stays off,
    // and a disabled plugin stays disabled.
    expect(records.get("my-plugin")?.disabledContributions).toEqual(["socket:row"]);
    expect(records.get("team-plugin")?.enabled).toBe(false);
    expect(records.get("team-plugin")?.source).toEqual({
      kind: "git",
      url: "https://github.com/example/team-plugin",
      ref: "v3.1.0",
    });
  });

  it("reports version 2 and carries no tombstone list forward", () => {
    const contents = parsePluginRegistryContents(LEGACY_STATE);
    expect(contents.version).toBe(2);
    expect(contents).not.toHaveProperty("removedBuiltins");
  });

  it("is stable when read again, so nothing reappears on a later launch", () => {
    const root = scratchRoot();
    writeState(root, LEGACY_STATE);
    const first = readPluginRegistryFile(root);
    const second = readPluginRegistryFile(root);
    expect(first).toEqual(second);
    expect(first.kind).toBe("present");
  });

  it("keeps a version 2 builtin record, because nothing seeds one any more", () => {
    const root = scratchRoot();
    writeState(root, {
      version: 2,
      plugins: {
        "ade-graph": {
          pluginId: "ade-graph",
          version: "1.0.0",
          enabled: true,
          // Written by a deliberate `ade plugin install ade-graph`, which is the
          // only thing that can produce this record now.
          source: { kind: "builtin" },
          installedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    expect([...readPluginInstallRecords(root).keys()]).toEqual(["ade-graph"]);
  });

  it("tells an unreadable registry from an empty one", () => {
    const root = scratchRoot();
    expect(readPluginRegistryFile(root).kind).toBe("absent");
    fs.writeFileSync(pluginRegistryFilePath(root), "{ not json");
    expect(readPluginRegistryFile(root).kind).toBe("unreadable");
  });
});
