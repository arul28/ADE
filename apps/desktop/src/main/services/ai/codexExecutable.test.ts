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

  it("prefers the bundled platform Codex binary before auth or common PATH fallback", () => {
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
});
