import { describe, expect, it } from "vitest";
import {
  classifyClaudeStartupFailure,
  getClaudeNativeBinaryFileName,
  getClaudeNativeBinaryPackageName,
  probeCrsqliteExtension,
} from "./packagedRuntimeSmokeShared";
import path from "node:path";

describe("packagedRuntimeSmoke", () => {
  it("classifies a missing bundled Claude binary distinctly", () => {
    expect(
      classifyClaudeStartupFailure(
        "Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional.",
      ),
    ).toEqual({
      state: "binary-missing",
      message:
        "Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional.",
    });
  });

  it("keeps non-binary startup failures fatal", () => {
    expect(
      classifyClaudeStartupFailure(
        "Claude startup probe returned an error result.",
      ),
    ).toEqual({
      state: "runtime-failed",
      message: "Claude startup probe returned an error result.",
    });
  });

  it("still classifies auth failures distinctly", () => {
    expect(
      classifyClaudeStartupFailure("API Error: 401 invalid authentication credentials"),
    ).toEqual({
      state: "auth-failed",
      message: "API Error: 401 invalid authentication credentials",
    });
  });

  it("maps supported platforms to Claude Agent SDK native binary packages", () => {
    expect(getClaudeNativeBinaryPackageName("win32", "x64")).toBe("@anthropic-ai/claude-agent-sdk-win32-x64");
    expect(getClaudeNativeBinaryPackageName("darwin", "arm64")).toBe("@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(getClaudeNativeBinaryPackageName("linux", "x64")).toBe("@anthropic-ai/claude-agent-sdk-linux-x64");
    expect(getClaudeNativeBinaryPackageName("freebsd", "x64")).toBeNull();
    expect(getClaudeNativeBinaryFileName("win32")).toBe("claude.exe");
    expect(getClaudeNativeBinaryFileName("darwin")).toBe("claude");
  });

  it.skipIf(process.platform !== "win32")("loads the packaged Windows CR-SQLite extension and records a CRR change", () => {
    const result = probeCrsqliteExtension(
      path.resolve(process.cwd(), "vendor", "crsqlite", "win32-x64", "crsqlite.dll"),
    );
    expect(result).toEqual({ ok: true, changeRows: 1 });
  });
});
