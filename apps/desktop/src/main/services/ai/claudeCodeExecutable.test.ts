import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import {
  TOOL_INSTALL_SENTINEL,
  findToolTargetPin,
  loadToolsManifest,
} from "../../../../../ade-cli/src/services/tools";

/**
 * Materialize a pinned tool into a throwaway cache root exactly as an install
 * leaves it: the real package/version directory, the entry file, and the
 * sentinel written last. Coordinates come from the manifest rather than
 * literals so bumping a pin does not break these tests.
 */
function installFakeCachedTool(args: {
  toolsRoot: string;
  tool: string;
  target: "darwin-arm64";
  entryRelativePath: string;
}): string {
  const pin = findToolTargetPin(loadToolsManifest(), args.tool, args.target);
  const versionDir = path.join(args.toolsRoot, ...pin.package.split("/"), pin.version);
  const entryPath = path.join(versionDir, args.entryRelativePath);
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(entryPath, 0o755);
  fs.writeFileSync(path.join(versionDir, TOOL_INSTALL_SENTINEL), "{}\n");
  return entryPath;
}

describe("resolveClaudeCodeExecutable", () => {
  it("prefers the explicit env override", () => {
    expect(
      resolveClaudeCodeExecutable({
        env: {
          CLAUDE_CODE_EXECUTABLE_PATH: "/custom/bin/claude",
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/custom/bin/claude",
      source: "env",
    });
  });

  it("uses the detected Claude auth path before falling back to PATH lookup", () => {
    expect(
      resolveClaudeCodeExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "claude",
            path: "/opt/homebrew/bin/claude",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/opt/homebrew/bin/claude",
      source: "auth",
    });
  });

  it("prefers the packaged bundled native binary before detected auth paths", () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-bundled-"));
    const binaryPath = path.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-darwin-arm64",
      "claude",
    );
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(binaryPath, 0o755);
    try {
      expect(
        resolveClaudeCodeExecutable({
          auth: [
            {
              type: "cli-subscription",
              cli: "claude",
              path: "/opt/homebrew/bin/claude",
              authenticated: true,
              verified: true,
            },
          ],
          env: {
            PATH: "/usr/bin:/bin",
          },
          resourcesPath,
          platform: "darwin",
          arch: "arm64",
        }),
      ).toEqual({
        path: binaryPath,
        source: "bundled",
      });
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
  describe("pinned tools cache", () => {
    it("resolves the fetched binary and reports it as tools-cache", () => {
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-claude-"));
      try {
        const entryPath = installFakeCachedTool({
          toolsRoot,
          tool: "claude-code",
          target: "darwin-arm64",
          entryRelativePath: "claude",
        });

        expect(
          resolveClaudeCodeExecutable({
            env: { ADE_TOOLS_ROOT: toolsRoot, PATH: "/usr/bin:/bin" },
            platform: "darwin",
            arch: "arm64",
          }),
        ).toEqual({ path: entryPath, source: "tools-cache" });
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });

    it("ignores a cache entry whose install never completed", () => {
      // A version directory without the sentinel is a crashed or half-copied
      // install. Handing that path to the SDK would fail at spawn time, so the
      // resolver must treat it as absent and fall through.
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-claude-"));
      try {
        const entryPath = installFakeCachedTool({
          toolsRoot,
          tool: "claude-code",
          target: "darwin-arm64",
          entryRelativePath: "claude",
        });
        fs.rmSync(path.join(path.dirname(entryPath), TOOL_INSTALL_SENTINEL));

        expect(
          resolveClaudeCodeExecutable({
            env: { ADE_TOOLS_ROOT: toolsRoot, PATH: "/usr/bin:/bin" },
            platform: "darwin",
            arch: "arm64",
          }).source,
        ).not.toBe("tools-cache");
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });

    it("still lets the explicit env override win over the cache", () => {
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-claude-"));
      try {
        installFakeCachedTool({
          toolsRoot,
          tool: "claude-code",
          target: "darwin-arm64",
          entryRelativePath: "claude",
        });

        expect(
          resolveClaudeCodeExecutable({
            env: {
              ADE_TOOLS_ROOT: toolsRoot,
              CLAUDE_CODE_EXECUTABLE_PATH: "/custom/bin/claude",
              PATH: "/usr/bin:/bin",
            },
            platform: "darwin",
            arch: "arm64",
          }),
        ).toEqual({ path: "/custom/bin/claude", source: "env" });
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });

    it("falls back to the bundled copy on a target the manifest does not pin", () => {
      // The manifest pins five targets; the bundled platform-package map also
      // covers win32-arm64. On that host the cache lookup must degrade to a
      // miss rather than throw its unsupported-target error.
      const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-tools-claude-"));
      try {
        expect(() =>
          resolveClaudeCodeExecutable({
            env: { ADE_TOOLS_ROOT: toolsRoot, PATH: "/usr/bin:/bin" },
            platform: "win32",
            arch: "arm64",
          }),
        ).not.toThrow();
      } finally {
        fs.rmSync(toolsRoot, { recursive: true, force: true });
      }
    });
  });
});
