import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";

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
});
