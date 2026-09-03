import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_OUTPUT_CAP_BYTES,
  PROVIDER_STATUS_DETAILS,
  cursorSdkPackageDir,
  PROVIDER_STATUS_CACHE_TTL_MS,
  probeProviderStatuses,
  resetProviderStatusProbeForTests,
  type ChildProcessLike,
  type FsLike,
  type ProviderAuthResolver,
  type ProviderBinaryResolver,
  type ProviderStatusCache,
  type ProviderStatusProbeOptions,
  type SpawnLike,
} from "./providerStatusProbe";
import { REMEDIATION_PROVIDERS } from "../../../shared/providerRemediation";
import { CURSOR_WINDOWS_ARM_BLOCKER } from "../../../shared/providerPlatformSupport";
import type { ShippedProvider } from "../../../shared/providers";

const readClaudeCredentials = vi.fn(async (): Promise<unknown> => null);
const readCodexCredentials = vi.fn(async (): Promise<unknown> => null);
const getCachedCliAuthStatuses = vi.fn((): { cli: string; authenticated: boolean }[] => []);

vi.mock("./providerCredentialSources", () => ({
  readClaudeCredentials: (...args: unknown[]) => readClaudeCredentials(...(args as [])),
  readCodexCredentials: (...args: unknown[]) => readCodexCredentials(...(args as [])),
}));

// Only the cached-verdict accessor is faked. `parseJsonAuthStatus` stays real,
// because the point of the last rung is that the status RPC reads
// `claude auth status --json` exactly the way the auth detector does.
vi.mock("./authDetector", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCachedCliAuthStatuses: () => getCachedCliAuthStatuses(),
}));

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: { windowsHide: boolean; windowsVerbatimArguments?: boolean };
};

type SpawnBehavior = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Never exits — exercises the version timeout. */
  hang?: boolean;
  /** Fails to start. */
  error?: string;
};

function createSpawn(
  behavior: SpawnBehavior,
): { spawn: SpawnLike; calls: SpawnCall[]; children: ChildProcessLike[] } {
  const calls: SpawnCall[] = [];
  const children: ChildProcessLike[] = [];
  let nextPid = 4242;
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    const listeners: { error?: (error: Error) => void; exit?: (code: number | null) => void } = {};
    const makeStream = (payload: string | undefined) => ({
      on(_event: "data", listener: (chunk: unknown) => void) {
        if (payload != null) queueMicrotask(() => listener(payload));
        return this;
      },
    });
    const child: ChildProcessLike = {
      stdout: makeStream(behavior.stdout),
      stderr: makeStream(behavior.stderr),
      on(event: "error" | "exit", listener: never) {
        if (event === "error") listeners.error = listener as unknown as (error: Error) => void;
        if (event === "exit") listeners.exit = listener as unknown as (code: number | null) => void;
        return child;
      },
      kill: () => true,
      // A real child carries these three. `terminateProcessTree` needs `pid` to
      // reach descendants and reads the other two as its PID-reuse guard.
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
    };
    children.push(child);
    if (behavior.error) {
      queueMicrotask(() => listeners.error?.(new Error(behavior.error)));
    } else if (!behavior.hang) {
      // Two microtask hops so the stdout chunk lands before the exit.
      queueMicrotask(() => queueMicrotask(() => listeners.exit?.(behavior.exitCode ?? 0)));
    }
    return child;
  };
  return { spawn, calls, children };
}

/** A filesystem where only the listed paths exist, with the mode each was given. */
function createFs(entries: Record<string, { isFile?: boolean; mode?: number }>): FsLike {
  return {
    statSync(target: string) {
      const entry = entries[target];
      if (!entry) throw new Error(`ENOENT: ${target}`);
      return {
        isFile: () => entry.isFile !== false,
        mode: entry.mode ?? 0o755,
      };
    },
    existsSync(target: string) {
      return Object.prototype.hasOwnProperty.call(entries, target);
    },
  };
}

const absentResolver: ProviderBinaryResolver = () => ({ path: null });
const signedOutAuth: ProviderAuthResolver = async () => ({ authenticated: false, authMethod: null });

function allProviders<T>(value: T): Record<ShippedProvider, T> {
  return Object.fromEntries(
    REMEDIATION_PROVIDERS.map((provider) => [provider, value]),
  ) as Record<ShippedProvider, T>;
}

/**
 * Every provider absent and signed out unless the case under test says
 * otherwise, so one assertion is about one provider rather than about whatever
 * happens to be installed on the machine running the suite.
 */
function baseOptions(overrides: ProviderStatusProbeOptions = {}): ProviderStatusProbeOptions {
  return {
    env: {},
    platform: "darwin",
    // Pinned, not inherited from the host: a case that overrides `platform` to
    // win32 would otherwise pair it with this machine's arch and trip the
    // Cursor availability gate by accident.
    arch: "x64",
    now: () => 1_700_000_000_000,
    fs: createFs({}),
    spawn: createSpawn({ stdout: "" }).spawn,
    findOnPath: () => null,
    readTextFile: () => null,
    cache: new Map() as ProviderStatusCache,
    ...overrides,
    resolvers: { ...allProviders(absentResolver), ...overrides.resolvers },
    auth: { ...allProviders(signedOutAuth), ...overrides.auth },
  };
}

/**
 * Like {@link baseOptions}, but lets one provider run its real credential
 * ladder. The rung tests are about that ladder, so stubbing it out would test
 * nothing.
 */
function realAuthFor(
  provider: ShippedProvider,
  overrides: ProviderStatusProbeOptions = {},
): ProviderStatusProbeOptions {
  const options = baseOptions(overrides);
  const auth = { ...(options.auth as Record<ShippedProvider, ProviderAuthResolver>) };
  delete auth[provider];
  return { ...options, auth };
}

beforeEach(() => {
  resetProviderStatusProbeForTests();
  readClaudeCredentials.mockReset();
  readClaudeCredentials.mockResolvedValue(null);
  readCodexCredentials.mockReset();
  readCodexCredentials.mockResolvedValue(null);
  getCachedCliAuthStatuses.mockReset();
  getCachedCliAuthStatuses.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  resetProviderStatusProbeForTests();
});

describe("probeProviderStatuses — detection table", () => {
  it("reports an executable binary with its version", async () => {
    const { spawn, calls } = createSpawn({ stdout: "1.2.3 (Claude Code)\nsecond line\n" });
    const report = await probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/usr/local/bin/claude": { mode: 0o755 } }),
      resolvers: { claude: () => ({ path: "/usr/local/bin/claude" }) },
    }));

    expect(report.providers.claude).toMatchObject({
      provider: "claude",
      displayName: "Claude Code",
      installed: true,
      binaryPath: "/usr/local/bin/claude",
      version: "1.2.3 (Claude Code)",
      source: "probed",
      stale: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/local/bin/claude",
      args: ["--version"],
      options: { windowsHide: true },
    });
  });

  it("treats a present but non-executable file as not installed", async () => {
    const { spawn, calls } = createSpawn({ stdout: "1.0.0" });
    const report = await probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/opt/claude": { mode: 0o644 } }),
      resolvers: { claude: () => ({ path: "/opt/claude" }) },
    }));

    expect(report.providers.claude).toMatchObject({
      installed: false,
      binaryPath: null,
      version: null,
    });
    expect(report.providers.claude.detail).toContain(PROVIDER_STATUS_DETAILS.notExecutable("/opt/claude"));
    expect(calls).toHaveLength(0);
  });

  it("reports an absent binary without spawning anything", async () => {
    const { spawn, calls } = createSpawn({ stdout: "1.0.0" });
    const report = await probeProviderStatuses(baseOptions({ spawn }));

    expect(report.providers.codex).toMatchObject({
      installed: false,
      binaryPath: null,
      version: null,
      source: "probed",
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps version null when --version exits non-zero", async () => {
    const { spawn } = createSpawn({ stdout: "usage: codex [options]", exitCode: 1 });
    const report = await probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/usr/local/bin/codex": { mode: 0o755 } }),
      resolvers: { codex: () => ({ path: "/usr/local/bin/codex" }) },
    }));

    expect(report.providers.codex).toMatchObject({
      installed: true,
      binaryPath: "/usr/local/bin/codex",
      version: null,
    });
  });

  it("keeps version null when --version never exits, and still finishes", async () => {
    vi.useFakeTimers();
    const { spawn } = createSpawn({ hang: true });
    const pending = probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/usr/local/bin/codex": { mode: 0o755 } }),
      resolvers: { codex: () => ({ path: "/usr/local/bin/codex" }) },
    }));

    await vi.advanceTimersByTimeAsync(6_000);
    const report = await pending;

    expect(report.providers.codex).toMatchObject({
      installed: true,
      binaryPath: "/usr/local/bin/codex",
      version: null,
    });
  });

  it("keeps version null when the spawn itself fails", async () => {
    const { spawn } = createSpawn({ error: "EACCES" });
    const report = await probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/usr/local/bin/droid": { mode: 0o755 } }),
      resolvers: { droid: () => ({ path: "/usr/local/bin/droid" }) },
    }));

    expect(report.providers.droid).toMatchObject({ installed: true, version: null });
  });
});

describe("probeProviderStatuses — fallback-command resolutions", () => {
  it("does not count a bare command name as installed", async () => {
    const report = await probeProviderStatuses(baseOptions({
      resolvers: {
        claude: () => ({ path: null, requiresPathConfirmation: true, command: "claude" }),
      },
      findOnPath: () => null,
    }));

    expect(report.providers.claude).toMatchObject({ installed: false, binaryPath: null });
    expect(report.providers.claude.detail).toContain(PROVIDER_STATUS_DETAILS.notOnPath("claude"));
  });

  it("counts it as installed once a PATH lookup confirms a file", async () => {
    const report = await probeProviderStatuses(baseOptions({
      fs: createFs({ "/opt/homebrew/bin/claude": { mode: 0o755 } }),
      spawn: createSpawn({ stdout: "2.0.0" }).spawn,
      resolvers: {
        claude: () => ({ path: null, requiresPathConfirmation: true, command: "claude" }),
      },
      findOnPath: (command) => (command === "claude" ? "/opt/homebrew/bin/claude" : null),
    }));

    expect(report.providers.claude).toMatchObject({
      installed: true,
      binaryPath: "/opt/homebrew/bin/claude",
      version: "2.0.0",
    });
  });
});

describe("probeProviderStatuses — timeout kills the process tree", () => {
  it("terminates the whole tree with the live child when --version never exits", async () => {
    // `child.kill()` is a TerminateProcess on the leader alone. On Windows the
    // leader is the `cmd.exe /d /s /c` wrapper every npm-installed provider CLI
    // takes, so the real CLI survives and a status screen that polls leaks one
    // process per provider per poll.
    vi.useFakeTimers();
    const { spawn, children } = createSpawn({ hang: true });
    const terminated: { child: ChildProcessLike; signal: NodeJS.Signals }[] = [];
    const pending = probeProviderStatuses(baseOptions({
      spawn,
      terminateTree: (child, signal) => {
        terminated.push({ child, signal });
      },
      fs: createFs({ "/usr/local/bin/codex": { mode: 0o755 } }),
      resolvers: { codex: () => ({ path: "/usr/local/bin/codex" }) },
    }));

    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(terminated).toHaveLength(1);
    expect(terminated[0]?.signal).toBe("SIGKILL");
    // The LIVE child, not a `{ pid }` snapshot: `exitCode`/`signalCode` are the
    // terminator's PID-reuse guard and a snapshot disables it.
    expect(terminated[0]?.child).toBe(children[0]);
    expect(typeof terminated[0]?.child.pid).toBe("number");
  });
});

describe("probeProviderStatuses — bounded output", () => {
  it("stops accumulating stdout past the cap instead of growing without limit", async () => {
    // A chatty or looping CLI would otherwise allocate freely inside the brain
    // process for the whole timeout window.
    const oversized = `9.9.9\n${"x".repeat(PROVIDER_OUTPUT_CAP_BYTES * 4)}`;
    const { spawn } = createSpawn({ stdout: oversized });
    const report = await probeProviderStatuses(baseOptions({
      spawn,
      fs: createFs({ "/usr/local/bin/codex": { mode: 0o755 } }),
      resolvers: { codex: () => ({ path: "/usr/local/bin/codex" }) },
    }));

    // The version still reads, because it is the first line.
    expect(report.providers.codex.version).toBe("9.9.9");
    expect(PROVIDER_OUTPUT_CAP_BYTES).toBe(16 * 1024);
  });
});

describe("cursor SDK detection", () => {
  it("resolves @cursor/sdk from this module rather than from process.cwd()", () => {
    // A packaged runtime's cwd is whatever the brain was started in — a user
    // project, `/`, a lane worktree. Anchoring there reported Cursor as absent
    // on machines where Cursor chat works, and reported a user project's own
    // node_modules as Cursor's install path whenever that project depended on
    // the package.
    const fromRealCwd = cursorSdkPackageDir();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-cwd-for-this-test");
    try {
      const resolved = cursorSdkPackageDir();
      expect(resolved).toBe(fromRealCwd);
      expect(resolved).not.toBeNull();
      expect(resolved).toContain(`@cursor${path.sep}sdk`);
      expect(resolved).not.toContain("nonexistent-cwd-for-this-test");
    } finally {
      cwd.mockRestore();
    }
  });

  it("walks up through the injected filesystem seam, not node:fs", () => {
    // Cursor was the one provider whose install verdict
    // `ProviderStatusProbeOptions.fs` could not steer, because the walk up to
    // the owning directory used its own `node:fs` import.
    expect(cursorSdkPackageDir(createFs({}))).toBeNull();
  });

  it("stops at the first directory the seam says owns a package.json", () => {
    const real = cursorSdkPackageDir();
    expect(real).not.toBeNull();
    const asked: string[] = [];
    const seam = {
      existsSync(target: string) {
        asked.push(target);
        return target === path.join(real!, "package.json");
      },
    };
    expect(cursorSdkPackageDir(seam)).toBe(real);
    expect(asked).toContain(path.join(real!, "package.json"));
  });
});

describe("probeProviderStatuses — Windows", () => {
  it("runs a .cmd shim through the cmd.exe wrapper", async () => {
    const { spawn, calls } = createSpawn({ stdout: "1.4.0" });
    const report = await probeProviderStatuses(baseOptions({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      spawn,
      fs: createFs({ "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd": { mode: 0o644 } }),
      resolvers: { claude: () => ({ path: "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd" }) },
    }));

    // On win32 there is no execute bit, so a regular file counts as installed.
    expect(report.providers.claude).toMatchObject({ installed: true, version: "1.4.0" });
    expect(calls[0].command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(calls[0].args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(calls[0].options.windowsVerbatimArguments).toBe(true);
    expect(calls[0].options.windowsHide).toBe(true);
  });

  it("uses the Windows install command on win32", async () => {
    const report = await probeProviderStatuses(baseOptions({ platform: "win32" }));
    expect(report.providers.claude.installCommand).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(report.providers.codex.installCommand).toBe("npm install -g @openai/codex");
    // Cursor's POSIX line is a `curl … | bash` pipe, which a Windows user
    // cannot run. Cursor ships its own Windows installer.
    expect(report.providers.cursor.installCommand).toBe(
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
  });

  it("reports Cursor as unavailable on win32/arm64, with the blocker as the reason", async () => {
    // ADE refuses to load Cursor there — `@cursor/sdk` has no win32-arm64
    // build. Offering an install command sends the user to install a CLI the
    // app will not use, with no reason given.
    const report = await probeProviderStatuses(baseOptions({
      platform: "win32",
      arch: "arm64",
      resolvers: { cursor: () => ({ path: "C:\\cursor-agent.exe" }) },
    }));
    expect(report.providers.cursor).toMatchObject({
      installed: false,
      binaryPath: null,
      authenticated: false,
      installCommand: null,
      detail: CURSOR_WINDOWS_ARM_BLOCKER,
    });
    // The docs URL is the whole remediation that is left.
    expect(report.providers.cursor.docsUrl).toBe("https://cursor.com/dashboard/api");
    // Every other provider is untouched by the gate.
    expect(report.providers.claude.installCommand).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("leaves Cursor alone on win32/x64, where it runs natively", async () => {
    const report = await probeProviderStatuses(baseOptions({
      platform: "win32",
      arch: "x64",
      fs: createFs({ "C:\\cursor-agent.exe": { mode: 0o644 } }),
      resolvers: { cursor: () => ({ path: "C:\\cursor-agent.exe", skipVersionProbe: true }) },
    }));
    expect(report.providers.cursor.installed).toBe(true);
    expect(report.providers.cursor.detail).not.toBe(CURSOR_WINDOWS_ARM_BLOCKER);
  });
});

describe("probeProviderStatuses — credentials", () => {
  it("reports the auth method the credential source implies", async () => {
    const report = await probeProviderStatuses(baseOptions({
      auth: {
        claude: async () => ({ authenticated: true, authMethod: "subscription" }),
        codex: async () => ({ authenticated: true, authMethod: "oauth" }),
      },
    }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "subscription" });
    expect(report.providers.codex).toMatchObject({ authenticated: true, authMethod: "oauth" });
    expect(report.providers.cursor).toMatchObject({ authenticated: false, authMethod: null });
  });

  it("separates an installed CLI from a signed-in one", async () => {
    const report = await probeProviderStatuses(baseOptions({
      fs: createFs({ "/usr/local/bin/claude": { mode: 0o755 } }),
      spawn: createSpawn({ stdout: "1.0.0" }).spawn,
      resolvers: { claude: () => ({ path: "/usr/local/bin/claude" }) },
    }));

    expect(report.providers.claude).toMatchObject({ installed: true, authenticated: false });
    expect(report.providers.claude.loginCommand).toBe("claude auth login");
  });

  it("keeps a provider in the report when its credential read throws", async () => {
    const report = await probeProviderStatuses(baseOptions({
      auth: {
        claude: async () => {
          throw new Error("keychain locked");
        },
      },
    }));

    expect(report.providers.claude).toMatchObject({ authenticated: false, authMethod: null });
    expect(report.providers.claude.detail).toContain(PROVIDER_STATUS_DETAILS.credentialsUnreadable);
  });
});

/**
 * The rungs exist because a machine where Claude works every day can have no
 * readable credentials file: on macOS the live token sits in the Keychain,
 * which this path refuses to open. Each test pins one rung and proves the
 * cheaper ones ran first.
 */
describe("probeProviderStatuses — Claude credential ladder", () => {
  const installedClaude = {
    fs: createFs({ "/usr/local/bin/claude": { mode: 0o755 } }),
    // The version spawn is skipped so the only spawn a test can see is the
    // last-resort `auth status`.
    resolvers: { claude: () => ({ path: "/usr/local/bin/claude", skipVersionProbe: true }) },
  } satisfies ProviderStatusProbeOptions;

  it("rung 1: reports a subscription from the credentials file without spawning", async () => {
    readClaudeCredentials.mockResolvedValue({ accessToken: "t", source: "claude-credentials-file" });
    const { spawn, calls } = createSpawn({ stdout: "" });
    const report = await probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "subscription" });
    expect(readClaudeCredentials).toHaveBeenCalledWith({ allowKeychain: false });
    expect(calls).toHaveLength(0);
  });

  it("rung 1: reports an api-key from ANTHROPIC_API_KEY", async () => {
    const report = await probeProviderStatuses(realAuthFor("claude", {
      ...installedClaude,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "api-key" });
  });

  it("rung 2: reads oauthAccount from ~/.claude.json when no credentials file exists", async () => {
    const { spawn, calls } = createSpawn({ stdout: "" });
    const report = await probeProviderStatuses(realAuthFor("claude", {
      ...installedClaude,
      spawn,
      env: { HOME: "/Users/tester" },
      readTextFile: (target) => (
        target === "/Users/tester/.claude.json"
          ? JSON.stringify({ oauthAccount: { accountUuid: "abc", emailAddress: "a@b.c" } })
          : null
      ),
    }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "subscription" });
    expect(calls).toHaveLength(0);
  });

  it("rung 2: honors CLAUDE_CONFIG_DIR for the config file", async () => {
    const report = await probeProviderStatuses(realAuthFor("claude", {
      ...installedClaude,
      env: { HOME: "/Users/tester", CLAUDE_CONFIG_DIR: "/custom/claude" },
      readTextFile: (target) => (
        target === "/custom/claude/.claude.json"
          ? JSON.stringify({ oauthAccount: { accountUuid: "abc" } })
          : null
      ),
    }));

    expect(report.providers.claude.authenticated).toBe(true);
  });

  it("rung 2: an empty oauthAccount does not stop the ladder", async () => {
    const { spawn, calls } = createSpawn({ stdout: JSON.stringify({ loggedIn: false }) });
    const report = await probeProviderStatuses(realAuthFor("claude", {
      ...installedClaude,
      spawn,
      env: { HOME: "/Users/tester" },
      readTextFile: () => JSON.stringify({ oauthAccount: {} }),
    }));

    // An empty object is a config file, not a sign-in, so the ladder falls
    // through to the CLI rather than claiming a subscription.
    expect(report.providers.claude).toMatchObject({ authenticated: false, authMethod: null });
    expect(calls).toHaveLength(1);
  });

  it("rung 3: uses the cached CLI verdict instead of spawning", async () => {
    getCachedCliAuthStatuses.mockReturnValue([{ cli: "claude", authenticated: true }]);
    const { spawn, calls } = createSpawn({ stdout: "" });
    const report = await probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "subscription" });
    expect(calls).toHaveLength(0);
  });

  it("rung 3: a cached signed-out verdict also stops the ladder", async () => {
    getCachedCliAuthStatuses.mockReturnValue([{ cli: "claude", authenticated: false }]);
    const { spawn, calls } = createSpawn({ stdout: "" });
    const report = await probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    expect(report.providers.claude).toMatchObject({ authenticated: false, authMethod: null });
    expect(calls).toHaveLength(0);
  });

  it("rung 4: spawns claude auth status --json when nothing cheaper knows", async () => {
    const { spawn, calls } = createSpawn({ stdout: JSON.stringify({ loggedIn: true }) });
    const report = await probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    expect(report.providers.claude).toMatchObject({ authenticated: true, authMethod: "subscription" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/local/bin/claude",
      args: ["auth", "status", "--json"],
      options: { windowsHide: true },
    });
  });

  it("rung 4: a loggedIn:false answer is a definite signed-out", async () => {
    const { spawn } = createSpawn({ stdout: JSON.stringify({ loggedIn: false }) });
    const report = await probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    expect(report.providers.claude).toMatchObject({ authenticated: false, authMethod: null });
    expect(report.providers.claude.detail).toBeNull();
  });

  it("rung 4: a timed-out auth status says the login state could not be verified", async () => {
    vi.useFakeTimers();
    const { spawn } = createSpawn({ hang: true });
    const pending = probeProviderStatuses(realAuthFor("claude", { ...installedClaude, spawn }));

    await vi.advanceTimersByTimeAsync(6_000);
    const report = await pending;

    expect(report.providers.claude).toMatchObject({ authenticated: false, authMethod: null });
    expect(report.providers.claude.detail).toContain(PROVIDER_STATUS_DETAILS.authStatusUnverified);
  });

  it("rung 4: does not spawn at all when the CLI is not installed", async () => {
    const { spawn, calls } = createSpawn({ stdout: JSON.stringify({ loggedIn: true }) });
    const report = await probeProviderStatuses(realAuthFor("claude", { spawn }));

    expect(report.providers.claude).toMatchObject({ installed: false, authenticated: false });
    expect(calls).toHaveLength(0);
  });
});

describe("probeProviderStatuses — Codex credential ladder", () => {
  const installedCodex = {
    fs: createFs({ "/usr/local/bin/codex": { mode: 0o755 } }),
    resolvers: { codex: () => ({ path: "/usr/local/bin/codex", skipVersionProbe: true }) },
  } satisfies ProviderStatusProbeOptions;

  it("reports oauth from ~/.codex/auth.json without spawning", async () => {
    readCodexCredentials.mockResolvedValue({ tokens: { accessToken: "t" } });
    const { spawn, calls } = createSpawn({ stdout: "" });
    const report = await probeProviderStatuses(realAuthFor("codex", { ...installedCodex, spawn }));

    expect(report.providers.codex).toMatchObject({ authenticated: true, authMethod: "oauth" });
    expect(calls).toHaveLength(0);
  });

  it("spawns codex login status when the auth file is absent and no verdict is cached", async () => {
    const { spawn, calls } = createSpawn({ stdout: JSON.stringify({ authenticated: true }) });
    const report = await probeProviderStatuses(realAuthFor("codex", { ...installedCodex, spawn }));

    expect(report.providers.codex.authenticated).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "/usr/local/bin/codex",
      args: ["login", "status"],
      options: { windowsHide: true },
    });
  });

  it("treats a zero exit with no JSON as signed in but of an unknown method", async () => {
    const { spawn } = createSpawn({ stdout: "Logged in as tester@example.com", exitCode: 0 });
    const report = await probeProviderStatuses(realAuthFor("codex", { ...installedCodex, spawn }));

    expect(report.providers.codex).toMatchObject({ authenticated: true, authMethod: "unknown" });
  });

  it("reports the timeout detail when codex login status hangs", async () => {
    vi.useFakeTimers();
    const { spawn } = createSpawn({ hang: true });
    const pending = probeProviderStatuses(realAuthFor("codex", { ...installedCodex, spawn }));

    await vi.advanceTimersByTimeAsync(6_000);
    const report = await pending;

    expect(report.providers.codex.authenticated).toBe(false);
    expect(report.providers.codex.detail).toContain(PROVIDER_STATUS_DETAILS.authStatusUnverified);
  });
});

describe("probeProviderStatuses — Pi credentials", () => {
  // Pi's rung used to import `node:fs` directly, which made it the one row in
  // the table whose verdict `ProviderStatusProbeOptions.fs` could not steer.
  const piEnv = { PI_CODING_AGENT_DIR: "/pi-agent" };

  it("reports authenticated when Pi's auth file exists on the injected filesystem", async () => {
    const report = await probeProviderStatuses(realAuthFor("pi", {
      env: piEnv,
      fs: createFs({ "/pi-agent/auth.json": {} }),
    }));

    expect(report.providers.pi).toMatchObject({ authenticated: true, authMethod: "unknown" });
  });

  it("accepts the models file as the same proof", async () => {
    const report = await probeProviderStatuses(realAuthFor("pi", {
      env: piEnv,
      fs: createFs({ "/pi-agent/models.json": {} }),
    }));

    expect(report.providers.pi.authenticated).toBe(true);
  });

  it("reports signed out when neither file is there", async () => {
    const report = await probeProviderStatuses(realAuthFor("pi", {
      env: piEnv,
      fs: createFs({}),
    }));

    expect(report.providers.pi).toMatchObject({ authenticated: false, authMethod: null });
  });
});

describe("probeProviderStatuses — caching", () => {
  it("probes once within the TTL and marks later reads stale", async () => {
    const cache: ProviderStatusCache = new Map();
    const resolver = vi.fn(() => ({ path: "/usr/local/bin/claude" }));
    let clock = 1_700_000_000_000;
    const options = () => baseOptions({
      cache,
      now: () => clock,
      fs: createFs({ "/usr/local/bin/claude": { mode: 0o755 } }),
      spawn: createSpawn({ stdout: "1.0.0" }).spawn,
      resolvers: { claude: resolver },
    });

    const first = await probeProviderStatuses(options());
    expect(first.providers.claude.stale).toBe(false);

    clock += 30_000;
    const second = await probeProviderStatuses(options());
    const third = await probeProviderStatuses(options());

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(second.providers.claude.stale).toBe(true);
    expect(third.providers.claude).toMatchObject({ stale: true, installed: true, version: "1.0.0" });
  });

  it("re-probes once the TTL has passed", async () => {
    const cache: ProviderStatusCache = new Map();
    const resolver = vi.fn(() => ({ path: null }));
    let clock = 1_700_000_000_000;
    const options = () => baseOptions({ cache, now: () => clock, resolvers: { claude: resolver } });

    await probeProviderStatuses(options());
    clock += PROVIDER_STATUS_CACHE_TTL_MS + 1;
    const second = await probeProviderStatuses(options());

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(second.providers.claude.stale).toBe(false);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const cache: ProviderStatusCache = new Map();
    const resolver = vi.fn(() => ({ path: null }));
    const options = (refresh?: boolean) => baseOptions({ cache, refresh, resolvers: { claude: resolver } });

    await probeProviderStatuses(options());
    await probeProviderStatuses(options());
    expect(resolver).toHaveBeenCalledTimes(1);

    const refreshed = await probeProviderStatuses(options(true));
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(refreshed.providers.claude.stale).toBe(false);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    const cache: ProviderStatusCache = new Map();
    const resolver = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { path: null };
    });
    const options = () => baseOptions({ cache, resolvers: { claude: resolver } });

    const [a, b] = await Promise.all([
      probeProviderStatuses(options()),
      probeProviderStatuses(options()),
    ]);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe("probeProviderStatuses — report shape", () => {
  it("covers every remediation provider and carries the remediation strings", async () => {
    const report = await probeProviderStatuses(baseOptions());

    expect(Object.keys(report.providers).sort()).toEqual([...REMEDIATION_PROVIDERS].sort());
    expect(typeof report.checkedAt).toBe("string");
    for (const provider of REMEDIATION_PROVIDERS) {
      const record = report.providers[provider];
      expect(record.provider).toBe(provider);
      expect(record.source).toBe("probed");
      expect(record.docsUrl).toMatch(/^https:\/\//);
      expect(record.installCommand).toBeTruthy();
      expect(record.loginCommand).toBeTruthy();
    }
  });

  it("survives a resolver that throws", async () => {
    const report = await probeProviderStatuses(baseOptions({
      resolvers: {
        pi: () => {
          throw new Error("boom");
        },
      },
    }));

    expect(report.providers.pi).toMatchObject({ installed: false, binaryPath: null });
    expect(report.providers.pi.detail).toContain(PROVIDER_STATUS_DETAILS.detectionFailed("boom"));
    expect(report.providers.claude.installed).toBe(false);
  });
});
