import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

let augmentProcessPathWithShellAndKnownCliDirs: typeof import("./cliExecutableResolver").augmentProcessPathWithShellAndKnownCliDirs;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

describe("augmentProcessPathWithShellAndKnownCliDirs", () => {
  beforeEach(async () => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    setPlatform("darwin");
    ({ augmentProcessPathWithShellAndKnownCliDirs } = await import("./cliExecutableResolver"));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("merges login and interactive shell PATH entries on macOS", () => {
    execFileSyncMock.mockImplementation((_shellPath: string, args: string[]) => {
      if (args[0] === "-lc") {
        return "noise __ADE_PATH_START__/usr/bin:/bin:/opt/custom/login/bin__ADE_PATH_END__";
      }
      if (args[0] === "-ic") {
        return "__ADE_PATH_START__/usr/bin:/bin:/Users/test/.interactive/bin__ADE_PATH_END__";
      }
      return "";
    });

    const env: NodeJS.ProcessEnv = {
      HOME: "/Users/test",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };

    const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
      env,
      includeInteractiveShell: true,
      timeoutMs: 250,
    });

    const entries = nextPath.split(path.delimiter);
    expect(entries).toContain("/opt/custom/login/bin");
    expect(entries).toContain("/Users/test/.interactive/bin");
    expect(entries).toContain("/Users/test/.npm-global/bin");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(nextPath).not.toBe(env.PATH);
  });
});
