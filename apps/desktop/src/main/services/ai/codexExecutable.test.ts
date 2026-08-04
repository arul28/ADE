import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockState = vi.hoisted(() => ({
  resolveExecutableFromKnownLocations: vi.fn(),
}));

vi.mock("./cliExecutableResolver", () => ({
  resolveExecutableFromKnownLocations: (...args: unknown[]) => mockState.resolveExecutableFromKnownLocations(...args),
}));

import { resolveCodexExecutable } from "./codexExecutable";
import {
  TOOL_INSTALL_SENTINEL,
  findToolTargetPin,
  loadToolsManifest,
} from "../../../../../ade-cli/src/services/tools";

/**
 * Materialize the pinned Codex build into a throwaway cache root the way an
 * install leaves it. The entry is deliberately created under a concrete
 * `vendor/<triple>/` directory so the manifest's `vendor/*` glob expansion is
 * exercised rather than assumed.
 */
function installFakeCachedCodex(toolsRoot: string, triple = "aarch64-apple-darwin"): string {
  const pin = findToolTargetPin(loadToolsManifest(), "codex", "darwin-arm64");
  const versionDir = path.join(toolsRoot, ...pin.package.split("/"), pin.version);
  const entryPath = path.join(versionDir, "vendor", triple, "bin", "codex");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(entryPath, 0o755);
  fs.writeFileSync(path.join(versionDir, TOOL_INSTALL_SENTINEL), "{}\n");
  return entryPath;
}


describe("resolveCodexExecutable", () => {
  it("uses the detected Codex auth path after bundled lookup is unavailable", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    expect(
      resolveCodexExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "codex",
            path: "/Users/arul/.npm-global/bin/codex",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          PATH: "/usr/bin:/bin",
        },
        bundledRoots: [],
      }),
    ).toEqual({
      path: "/Users/arul/.npm-global/bin/codex",
      source: "auth",
    });
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });

  it("honors CODEX_EXECUTABLE before PATH lookup", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    expect(
      resolveCodexExecutable({
        env: {
          CODEX_EXECUTABLE: "/opt/codex/bin/codex",
          PATH: "/usr/bin:/bin",
        },
        bundledRoots: [],
      }),
    ).toEqual({
      path: "/opt/codex/bin/codex",
      source: "path",
    });
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });

  it("prefers the bundled platform Codex binary from the current package layout", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-bundle-"));
    const binaryPath = path.join(
      tmpDir,
      "codex-darwin-arm64",
      "vendor",
      "aarch64-apple-darwin",
      "bin",
      "codex",
    );
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);

    try {
      expect(
        resolveCodexExecutable({
          auth: [
            {
              type: "cli-subscription",
              cli: "codex",
              path: "/Users/arul/.npm-global/bin/codex",
              authenticated: true,
              verified: true,
            },
          ],
          env: {
            PATH: "/usr/bin:/bin",
          },
          bundledRoots: [tmpDir],
          platform: "darwin",
          arch: "arm64",
        }),
      ).toEqual({
        path: binaryPath,
        source: "bundled",
      });
      expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still supports the legacy bundled platform Codex binary layout", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-bundle-"));
    const binaryPath = path.join(
      tmpDir,
      "codex-darwin-arm64",
      "vendor",
      "aarch64-apple-darwin",
      "codex",
      "codex",
    );
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "#!/bin/sh\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);

    try {
      expect(
        resolveCodexExecutable({
          env: {
            PATH: "/usr/bin:/bin",
          },
          bundledRoots: [tmpDir],
          platform: "darwin",
          arch: "arm64",
        }),
      ).toEqual({
        path: binaryPath,
        source: "bundled",
      });
      expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  describe("pinned tools cache", () => {
    it("resolves the fetched binary through the vendor glob", () => {
      mockState.resolveExecutableFromKnownLocations.mockReset();
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-codex-"));
      try {
        const entryPath = installFakeCachedCodex(toolsRoot);

        expect(
          resolveCodexExecutable({
            env: { ADE_TOOLS_ROOT: toolsRoot, PATH: "/usr/bin:/bin" },
            platform: "darwin",
            arch: "arm64",
          }),
        ).toEqual({ path: entryPath, source: "tools-cache" });
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });

    it("honours ADE_DISABLE_BUNDLED_CODEX by skipping the cache too", () => {
      // The flag means "use my Codex, not ADE's". Leaving the cache in play
      // would make it a no-op now that the cache, not node_modules, is where
      // ADE's own copy lives.
      mockState.resolveExecutableFromKnownLocations.mockReset();
      mockState.resolveExecutableFromKnownLocations.mockReturnValue({
        path: "/usr/local/bin/codex",
        source: "path",
      });
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-codex-"));
      try {
        installFakeCachedCodex(toolsRoot);

        expect(
          resolveCodexExecutable({
            env: {
              ADE_TOOLS_ROOT: toolsRoot,
              ADE_DISABLE_BUNDLED_CODEX: "1",
              PATH: "/usr/bin:/bin",
            },
            platform: "darwin",
            arch: "arm64",
          }),
        ).toEqual({ path: "/usr/local/bin/codex", source: "path" });
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });

    it("ignores a cache entry whose install never completed", () => {
      mockState.resolveExecutableFromKnownLocations.mockReset();
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-codex-"));
      try {
        const entryPath = installFakeCachedCodex(toolsRoot);
        const versionDir = path.resolve(entryPath, "..", "..", "..", "..");
        fs.rmSync(path.join(versionDir, TOOL_INSTALL_SENTINEL));

        expect(
          resolveCodexExecutable({
            env: { ADE_TOOLS_ROOT: toolsRoot, PATH: "/usr/bin:/bin" },
            platform: "darwin",
            arch: "arm64",
          }).source,
        ).not.toBe("tools-cache");
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });
  });
});
