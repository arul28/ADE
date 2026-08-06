import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolsContext, ensureTools } from "./install";
import { type ToolsManifest, parseToolsManifest } from "./manifest";
import { TOOL_INSTALL_SENTINEL, toolSentinelPath, toolVersionDir } from "./paths";

const PACKAGE_NAME = "demo-tool-darwin-arm64";
const VERSION = "1.2.3";

let tmpRoot = "";
let toolsRoot = "";

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-tools-flap-"));
  toolsRoot = path.join(tmpRoot, "tools");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function manifest(): ToolsManifest {
  return parseToolsManifest({
    schemaVersion: 1,
    generatedFrom: "test",
    tools: [
      {
        name: "demo",
        description: "Demo tool.",
        entry: { kind: "binary", path: "bin/demo" },
        targets: {
          "darwin-arm64": {
            package: PACKAGE_NAME,
            version: VERSION,
            tarball: `https://registry.npmjs.org/${PACKAGE_NAME}/-/demo-${VERSION}.tgz`,
            integrity: "sha512-deadbeef",
          },
        },
      },
    ],
  });
}

function context(): ToolsContext {
  return {
    manifest: manifest(),
    toolsRoot,
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    lock: { pollIntervalMs: 1, timeoutMs: 2_000, staleMs: 1_000 },
  };
}

describe("ensureTools with a flapping install sentinel", () => {
  it("gives up with a typed error instead of recursing forever", async () => {
    // The lock reports `satisfied` (its poll saw a complete install) but the
    // read-back immediately after finds nothing. Before the bound, that path
    // called ensureOneTool again with no depth limit, so a sentinel that keeps
    // flipping pinned a core with no diagnosis and no download ever starting.
    const versionDir = toolVersionDir(toolsRoot, PACKAGE_NAME, VERSION);
    const sentinelPath = toolSentinelPath(versionDir);
    // The declared entry is real, so only the sentinel decides installedness.
    await fsp.mkdir(path.join(versionDir, "bin"), { recursive: true });
    await fsp.writeFile(path.join(versionDir, "bin", "demo"), "#!/bin/sh\n", "utf8");

    // Per attempt the sentinel is probed three times: the pre-lock cache check
    // (absent), the lock's isSatisfied poll (present), and the post-`satisfied`
    // read-back (absent again). That middle `true` is the flap.
    let probes = 0;
    const realExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((target) => {
      if (target !== sentinelPath) return realExistsSync(target);
      const present = probes % 3 === 1;
      probes += 1;
      return present;
    });

    const download = vi.fn(async () => {
      throw new Error("a flapping sentinel must never reach the network");
    });

    await expect(
      ensureTools(["demo"], { ...context(), download: download as never }),
    ).rejects.toMatchObject({
      name: "ToolError",
      kind: "filesystem",
      tool: "demo",
      packageName: PACKAGE_NAME,
      version: VERSION,
    });

    await expect(
      ensureTools(["demo"], { ...context(), download: download as never }),
    ).rejects.toThrow(new RegExp(`demo.*${TOOL_INSTALL_SENTINEL.replace(".", "\\.")}`, "s"));

    expect(download).not.toHaveBeenCalled();
    // Three attempts per call, three sentinel probes each, across two calls.
    expect(probes).toBe(18);
  });
});
