import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliLoginProvider, AgentCliSavedLogin } from "../../../shared/types/agentCliLogin";
import { createAgentCliLoginRunner, type AgentCliLoginPty } from "./agentCliLoginRunner";

/** A stand-in for the CLI's PTY: the test prints its output and ends it. */
function fakePty() {
  let onData: (data: string) => void = () => {};
  let onExit: (event: { exitCode: number }) => void = () => {};
  const pty: AgentCliLoginPty = {
    pid: 4242,
    onData: (listener) => { onData = listener; },
    onExit: (listener) => { onExit = listener; },
    write: vi.fn(),
    kill: vi.fn(),
  };
  return { pty, print: (text: string) => onData(text), exit: (exitCode: number) => onExit({ exitCode }) };
}

/** The provider's login on disk, as the test changes it. */
function savedLogin(initial: AgentCliSavedLogin) {
  let current = initial;
  return {
    read: async () => current,
    set: (next: AgentCliSavedLogin) => { current = next; },
  };
}

function runnerWith(saved: ReturnType<typeof savedLogin>, cli: ReturnType<typeof fakePty>, platform: NodeJS.Platform = "linux") {
  return createAgentCliLoginRunner({
    resolveCli: () => ({ kind: "ready", cli: { command: "/tools/cli", leadingArgs: [], env: {} } }),
    baseEnv: () => ({}),
    spawnPty: () => cli.pty,
    stopPty: (pty) => pty.kill(),
    readSavedLogin: saved.read,
    pollMs: 100,
    platform,
  });
}

async function startAndWait(provider: AgentCliLoginProvider, runner: ReturnType<typeof createAgentCliLoginRunner>) {
  const login = await runner.start({ provider });
  await vi.advanceTimersByTimeAsync(0);
  return login.loginId;
}

describe("agentCliLoginRunner verification", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // A changed login file while the CLI still waits is not a sign-in when the
  // CLI rewrites it at start (Copilot, measured with a real sign-in) or a
  // login was already there (signing in again: a session using it refreshes
  // its token in the same file). Only the CLI's clean exit after that counts.
  it.each([
    ["copilot", "To authenticate, visit https://github.com/login/device and enter code 1278-FC40\nWaiting for authorization...\n", "octo"],
    ["kimi", "Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=HIM4-52GR\n", undefined],
  ] as const)("does not call %s signed in on a rewritten login until its CLI exits", async (provider, prompt, account) => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: true, fingerprint: "old" });
    const runner = runnerWith(saved, cli);
    const loginId = await startAndWait(provider, runner);

    cli.print(prompt);
    saved.set({ signedIn: true, fingerprint: "rewritten-while-waiting", ...(account ? { account } : {}) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.status(loginId).state).toBe("running");
    expect(cli.pty.kill).not.toHaveBeenCalled();

    cli.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status(loginId)).toMatchObject({ state: "succeeded", ...(account ? { email: account } : {}) });
  });

  it("calls Grok signed in as soon as a new login lands, while its CLI still runs", async () => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: false, fingerprint: "none" });
    const runner = runnerWith(saved, cli);
    const loginId = await startAndWait("grok", runner);

    cli.print("To sign in, open this URL in your browser: https://accounts.x.ai/oauth2/device?user_code=6HPS-5JPM\n");
    await vi.advanceTimersByTimeAsync(300);
    // Grok prints its code only on the link.
    expect(runner.status(loginId)).toMatchObject({ state: "running", deviceCode: "6HPS-5JPM" });

    saved.set({ signedIn: true, fingerprint: "new" });
    await vi.advanceTimersByTimeAsync(300);
    expect(runner.status(loginId).state).toBe("succeeded");
    expect(cli.pty.kill).toHaveBeenCalled();
  });

  // A CLI can exit 0 on an expired code; with a login already there, nothing new was saved.
  it("fails signing in again when the CLI exits cleanly without a new login", async () => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: true, fingerprint: "old" });
    const runner = runnerWith(saved, cli);
    const loginId = await startAndWait("grok", runner);

    cli.print("To sign in, open this URL in your browser: https://accounts.x.ai/oauth2/device?user_code=6HPS-5JPM\nError: device code expired\n");
    cli.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status(loginId).state).toBe("failed");
  });

  // Muse keeps its login in the macOS Keychain, which ADE never reads, so a
  // clean exit decides there, unless Muse said the sign-in failed.
  it.each([
    ["darwin", "Waiting for approval…\n", "succeeded"],
    ["darwin", "Not approved in time\n", "failed"],
    ["linux", "Waiting for approval…\n", "failed"],
  ] as const)("Muse on %s, exiting after %j, reads %s", async (platform, tail, expected) => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: false, fingerprint: "none" });
    const runner = runnerWith(saved, cli, platform);
    const loginId = await startAndWait("muse", runner);

    cli.print(`Open this page to sign in:\nhttps://auth.meta.com/oauth/device/?code=RXBW-LRZP\n${tail}`);
    cli.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status(loginId).state).toBe(expected);
  });
});
