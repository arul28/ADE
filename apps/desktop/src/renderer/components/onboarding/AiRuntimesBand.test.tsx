import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolCacheState, AgentToolsCacheSnapshot } from "../../../shared/types";
import {
  availableRuntimes,
  cursorInstallCommand,
  runtimeToolState,
  toolFetchFailureText,
} from "./AiRuntimesBand";

describe("cursorInstallCommand", () => {
  it("uses Cursor's PowerShell installer on Windows", () => {
    const command = cursorInstallCommand("win32");
    expect(command).toContain("powershell.exe");
    expect(command).toContain("cursor.com/install?win32=true");
    expect(command).not.toContain("curl");
    expect(command).not.toContain("mkdir -p");
    expect(command).not.toContain("$HOME");
  });

  it("keeps the documented POSIX one-liner elsewhere", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const command = cursorInstallCommand(platform);
      expect(command).toContain("curl https://cursor.com/install -fsS | bash");
      expect(command).not.toContain("powershell");
    }
  });
});

// Onboarding must not offer a runtime that cannot be installed usefully:
// @cursor/sdk has no win32-arm64 build. See shared/providerPlatformSupport.ts.
describe("availableRuntimes", () => {
  function setRuntimeTarget(platform: string, arch: string) {
    (globalThis as { window?: unknown }).window = {
      ade: { app: { runtimeTarget: { platform, arch } } },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("drops Cursor on Windows on ARM and keeps every other runtime", () => {
    setRuntimeTarget("win32", "arm64");
    const ids = availableRuntimes().map((rt) => rt.id);
    expect(ids).not.toContain("cursor");
    expect(ids).toEqual(["claude", "codex", "droid", "opencode"]);
  });

  it("keeps Cursor on Windows x64 and on macOS", () => {
    for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const) {
      setRuntimeTarget(platform, arch);
      const ids = availableRuntimes().map((rt) => rt.id);
      expect(ids, `${platform}-${arch}`).toEqual(["claude", "codex", "cursor", "droid", "opencode"]);
    }
  });

  // ADE fetches these three into the machine cache; the pinned tool names come
  // from the tools manifest and are NOT the runtime ids.
  it("maps only the fetched runtimes onto their pinned tool names", () => {
    setRuntimeTarget("darwin", "arm64");
    const byId = Object.fromEntries(availableRuntimes().map((rt) => [rt.id, rt.toolName]));
    expect(byId).toEqual({
      claude: "claude-code",
      codex: "codex",
      cursor: undefined,
      droid: undefined,
      opencode: "opencode",
    });
  });
});

describe("runtimeToolState", () => {
  const state = (over: Partial<AgentToolCacheState> = {}): AgentToolCacheState => ({
    tool: "claude-code",
    status: "fetching",
    percent: 42,
    errorKind: null,
    ...over,
  });
  const snapshot = (...tools: AgentToolCacheState[]): AgentToolsCacheSnapshot => ({
    tools,
    fetching: tools.some((tool) => tool.status === "fetching"),
  });

  it("surfaces a fetch in flight for the runtime's own tool", () => {
    const found = runtimeToolState({ toolName: "claude-code" }, snapshot(state()), "missing");
    expect(found?.percent).toBe(42);
  });

  it("ignores other tools' states", () => {
    expect(runtimeToolState({ toolName: "codex" }, snapshot(state()), "missing")).toBeNull();
  });

  it("stays quiet for runtimes ADE does not fetch", () => {
    expect(runtimeToolState({ toolName: undefined }, snapshot(state()), "missing")).toBeNull();
  });

  // A CLI already on PATH satisfies the runtime, so a cache failure is noise.
  it("never shouts a failure over a runtime that is already ready", () => {
    const failed = snapshot(state({ status: "failed", percent: null, errorKind: "network" }));
    expect(runtimeToolState({ toolName: "claude-code" }, failed, "ready")).toBeNull();
    expect(runtimeToolState({ toolName: "claude-code" }, failed, "missing")?.errorKind).toBe("network");
  });

  // "installed"/"missing" are the states the existing readiness scan already
  // describes better than the cache can.
  it("defers to the normal readiness treatment when nothing is in flight", () => {
    for (const status of ["installed", "missing"] as const) {
      const quiet = snapshot(state({ status, percent: null }));
      expect(runtimeToolState({ toolName: "claude-code" }, quiet, "missing"), status).toBeNull();
    }
  });
});

describe("toolFetchFailureText", () => {
  it("names the failures a user can act on", () => {
    expect(toolFetchFailureText("network")).toContain("connection");
    expect(toolFetchFailureText("disk-space")).toContain("disk space");
  });

  it("falls back for kinds with no tailored copy", () => {
    expect(toolFetchFailureText("extract")).toBe("Download failed");
    expect(toolFetchFailureText(null)).toBe("Download failed");
  });
});
