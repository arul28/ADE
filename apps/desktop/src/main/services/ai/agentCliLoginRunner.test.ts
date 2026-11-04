import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliLoginProvider } from "../../../shared/types/agentCliLogin";
import {
  createAgentCliLoginRunner,
  type AgentCliLoginPty,
  type AgentCliSavedLoginRead,
} from "./agentCliLoginRunner";

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
function savedLogin(initial: AgentCliSavedLoginRead) {
  let current = initial;
  return {
    read: async () => current,
    set: (next: AgentCliSavedLoginRead) => { current = next; },
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

  // Copilot rewrites config.json when its login starts: a changed file while
  // it still waits must not read as signed in (a real sign-in did).
  it("does not call Copilot signed in until its CLI exits after approval", async () => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: true, fingerprint: "old" });
    const runner = runnerWith(saved, cli);
    const loginId = await startAndWait("copilot", runner);

    cli.print("To authenticate, visit https://github.com/login/device and enter code 1278-FC40\nWaiting for authorization...\n");
    saved.set({ signedIn: true, fingerprint: "rewritten-at-start", account: "octo" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner.status(loginId).state).toBe("running");

    cli.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.status(loginId)).toMatchObject({ state: "succeeded", email: "octo" });
  });

  it("calls Grok signed in as soon as a new login lands, while its CLI still runs", async () => {
    const cli = fakePty();
    const saved = savedLogin({ signedIn: false, fingerprint: "none" });
    const runner = runnerWith(saved, cli);
    const loginId = await startAndWait("grok", runner);

    cli.print("To sign in, open this URL in your browser: https://accounts.x.ai/oauth2/device?user_code=6HPS-5JPM\n");
    await vi.advanceTimersByTimeAsync(300);
    expect(runner.status(loginId).state).toBe("running");

    saved.set({ signedIn: true, fingerprint: "new" });
    await vi.advanceTimersByTimeAsync(300);
    expect(runner.status(loginId).state).toBe("succeeded");
    expect(cli.pty.kill).toHaveBeenCalled();
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
