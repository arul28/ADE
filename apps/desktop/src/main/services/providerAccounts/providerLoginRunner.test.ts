import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NodeModule from "node:module";
import type { ProviderInstance } from "../../../shared/types/providerInstances";
import type { ProviderInstanceLoginCommand } from "../../../shared/types/providerInstances";
import {
  createProviderLoginRunner,
  type ProviderLoginRunnerDeps,
} from "./providerLoginRunner";

/**
 * node-pty is native and loaded through `createRequire` inside the runner, so
 * `vi.mock("node-pty")` cannot reach it. The loader is shimmed instead, which
 * is still the process boundary: the runner asks the module loader for a PTY
 * and gets this fake.
 */
const ptyState = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>();
  const shimmedRequire = (id: string): unknown => {
    if (id === "node-pty") return { spawn: ptyState.spawn };
    return actual.createRequire(import.meta.url)(id);
  };
  return { ...actual, createRequire: () => shimmedRequire };
});

type FakePty = {
  pid: number;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (event: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  kill: () => void;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
  writes: string[];
  killed: boolean;
};

function makeFakePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number }) => void> = [];
  const pty: FakePty = {
    pid: 4242,
    writes: [],
    killed: false,
    onData: (cb) => {
      dataListeners.push(cb);
    },
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    write: (data) => {
      pty.writes.push(data);
    },
    kill: () => {
      pty.killed = true;
    },
    emitData: (data) => {
      for (const cb of [...dataListeners]) cb(data);
    },
    emitExit: (exitCode) => {
      for (const cb of [...exitListeners]) cb({ exitCode });
    },
  };
  return pty;
}

const WORK: ProviderInstance = {
  id: "work",
  provider: "claude",
  label: "Work",
  configHome: "/tmp/work",
  isDefault: false,
  createdAt: new Date(0).toISOString(),
  signedIn: false,
};

function makeRunner(overrides: Partial<ProviderLoginRunnerDeps> = {}) {
  const ptys: FakePty[] = [];
  ptyState.spawn.mockImplementation(() => {
    const pty = makeFakePty();
    ptys.push(pty);
    return pty;
  });
  const runner = createProviderLoginRunner({
    getInstance: (id) => (id === "work" ? WORK : id === "codex-work" ? { ...WORK, id, provider: "codex" } : null),
    loginCommand: (id): ProviderInstanceLoginCommand => (id === "codex-work"
      ? { command: "codex", args: ["login"], env: { CODEX_HOME: "/tmp/codex" } }
      : { command: "claude", args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: "/tmp/work" } }),
    verify: async () => null,
    ...overrides,
  });
  return { runner, ptys };
}

/** The argv the fake PTY was spawned with, per spawn call. */
function spawnArgs(index: number): string[] {
  const call = ptyState.spawn.mock.calls[index] as unknown[] | undefined;
  const args = call?.[1];
  return Array.isArray(args) ? args.map(String) : [];
}

describe("providerLoginRunner", () => {
  beforeEach(() => {
    ptyState.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replaces a live sign-in when the same account is started again", () => {
    const { runner, ptys } = makeRunner();

    const first = runner.start("work");
    const second = runner.start("work");

    expect(second.loginId).not.toBe(first.loginId);
    expect(runner.status(first.loginId)).toMatchObject({ state: "cancelled" });
    expect(runner.status(second.loginId)).toMatchObject({ state: "running" });
    expect(ptys[0]?.killed).toBe(true);
    expect(ptys[1]?.killed).toBe(false);
  });

  it("fails a sign-in nobody finishes within ten minutes", () => {
    vi.useFakeTimers();
    const { runner } = makeRunner();
    const login = runner.start("work");

    vi.advanceTimersByTime(10 * 60_000);

    expect(runner.status(login.loginId)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("timed out"),
    });
  });

  it("fails a sign-in whose CLI exits without a working saved login", async () => {
    const { runner, ptys } = makeRunner();
    const login = runner.start("work");

    ptys[0]?.emitExit(0);

    await vi.waitFor(() => {
      expect(runner.status(login.loginId).state).toBe("failed");
    });
    expect(runner.status(login.loginId).message).toContain("no working login was saved");
  });

  it("succeeds and reports the email when the saved login verifies after exit", async () => {
    const signedIn: ProviderInstance = { ...WORK, signedIn: true, account: { email: "arul@acme.com" } };
    const { runner, ptys } = makeRunner({ verify: async () => signedIn });
    const login = runner.start("work");

    ptys[0]?.emitExit(0);

    await vi.waitFor(() => {
      expect(runner.status(login.loginId).state).toBe("succeeded");
    });
    expect(runner.status(login.loginId).email).toBe("arul@acme.com");
  });

  it("keeps a cancelled sign-in cancelled when its verification lands later", async () => {
    const verify: { resolve?: (value: ProviderInstance | null) => void } = {};
    const signedIn: ProviderInstance = { ...WORK, signedIn: true, account: { email: "arul@acme.com" } };
    const { runner, ptys } = makeRunner({
      verify: () => new Promise((resolve) => {
        verify.resolve = resolve;
      }),
    });
    const login = runner.start("work");

    ptys[0]?.emitExit(0);
    await vi.waitFor(() => {
      expect(runner.status(login.loginId).state).toBe("verifying");
    });

    runner.cancel(login.loginId);
    verify.resolve?.(signedIn);
    // Drain the microtasks the verify continuation needs, so a late result that
    // could overwrite the cancel has had its chance before this asserts.
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.status(login.loginId).state).toBe("cancelled");
  });

  it("completes a sign-in link that arrives split across two reads", () => {
    const { runner, ptys } = makeRunner();
    const login = runner.start("work");

    ptys[0]?.emitData("Open https://claude.ai/au");
    ptys[0]?.emitData("th?code=abc123\r\n");

    expect(runner.status(login.loginId).url).toBe("https://claude.ai/auth?code=abc123");
  });

  it("adds the device flag and reads the one-time code for a codex device sign-in", () => {
    const { runner, ptys } = makeRunner();
    const login = runner.start("codex-work", { deviceAuth: true });

    expect(spawnArgs(0)).toContain("--device-auth");

    ptys[0]?.emitData("Enter this code in your browser: ABCD-EFGH\r\n");
    expect(runner.status(login.loginId).deviceCode).toBe("ABCD-EFGH");
  });

  it("redacts a pasted code from the sign-in output the sheet shows", () => {
    const { runner, ptys } = makeRunner();
    const login = runner.start("work");

    ptys[0]?.emitData("Paste the authorization code here:\r\n");
    expect(runner.status(login.loginId).awaitingCode).toBe(true);

    runner.submitCode(login.loginId, "abc12345");
    expect(ptys[0]?.writes.at(-1)).toBe("abc12345\r");

    ptys[0]?.emitData("abc12345\r\n");
    const output = runner.status(login.loginId).output;
    expect(output).not.toContain("abc12345");
    expect(output).toContain("[code]");
  });
});
