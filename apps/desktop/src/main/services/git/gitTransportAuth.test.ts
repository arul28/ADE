import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRunResult } from "./git";

const runGitMock = vi.hoisted(() => vi.fn());

// git is the process boundary: every run is answered by `respond` below.
vi.mock("./git", async () => {
  const actual = await vi.importActual<typeof import("./git")>("./git");
  return {
    ...actual,
    runGit: runGitMock,
    gitCommonDirFor: async (cwd: string) => `${cwd}/.git`,
  };
});

import { readGitTransportStatus, runGitWithGithubAuthFallback } from "./gitTransportAuth";

const TOKEN = "ghp_adeTokenValue123";
const NO_SIGN_IN = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
const DENIED = "remote: Permission to acme/app.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403";

type Call = { args: string[]; withToken: boolean };

/**
 * A fake repository. `system` answers runs that carry no ADE token; `ade`
 * answers runs that do. Returns the remote calls as they were made.
 */
function fakeRepo(opts: { pushUrl: string; system: Partial<GitRunResult>; ade?: Partial<GitRunResult> }): Call[] {
  const calls: Call[] = [];
  runGitMock.mockImplementation(async (args: string[], runOpts: { env?: NodeJS.ProcessEnv }) => {
    if ((args[0] === "remote" && args[1] === "get-url") || (args[0] === "ls-remote" && args[1] === "--get-url")) {
      return { exitCode: 0, stdout: `${opts.pushUrl}\n`, stderr: "" };
    }
    const header = runOpts.env?.GIT_CONFIG_VALUE_1 ?? "";
    const withToken = header.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    calls.push({ args, withToken });
    const answer = withToken ? opts.ade ?? { exitCode: 0 } : opts.system;
    return { exitCode: 0, stdout: "", stderr: "", ...answer };
  });
  return calls;
}

let repo = 0;
const nextRepo = () => `/repos/r${++repo}`;
const readToken = async () => TOKEN;

beforeEach(() => {
  runGitMock.mockReset();
});

describe("runGitWithGithubAuthFallback", () => {
  it("retries a failed sign-in with ADE's token, keeps the token out of argv, and goes straight to it next time", async () => {
    const cwd = nextRepo();
    const calls = fakeRepo({ pushUrl: "https://github.com/acme/app.git", system: { exitCode: 128, stderr: NO_SIGN_IN } });

    const first = await runGitWithGithubAuthFallback(["push", "origin", "main"], { cwd, readToken });
    expect(first.exitCode).toBe(0);
    expect(calls.map((call) => call.withToken)).toEqual([false, true]);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(TOKEN);

    await runGitWithGithubAuthFallback(["fetch", "origin"], { cwd, readToken });
    expect(calls.map((call) => call.withToken)).toEqual([false, true, true]);
    expect(await readGitTransportStatus(cwd, readToken)).toMatchObject({ state: "ok", via: "ade", adeCredentialTried: true });
  });

  it("leaves a machine whose own sign-in works, and non-GitHub or SSH remotes, alone", async () => {
    const working = nextRepo();
    const workingCalls = fakeRepo({ pushUrl: "https://github.com/acme/app.git", system: { exitCode: 0 } });
    await runGitWithGithubAuthFallback(["push"], { cwd: working, readToken });
    expect(workingCalls.map((call) => call.withToken)).toEqual([false]);
    expect(await readGitTransportStatus(working, readToken)).toMatchObject({ state: "ok", via: "system" });

    for (const pushUrl of ["git@github.com:acme/app.git", "https://gitlab.com/acme/app.git"]) {
      const cwd = nextRepo();
      const calls = fakeRepo({ pushUrl, system: { exitCode: 128, stderr: NO_SIGN_IN } });
      const result = await runGitWithGithubAuthFallback(["push"], { cwd, readToken });
      expect(result.exitCode, pushUrl).toBe(128);
      expect(calls.map((call) => call.withToken), pushUrl).toEqual([false]);
      expect(await readGitTransportStatus(cwd, readToken), pushUrl).toBeNull();
    }
  });

  it("reports can't-sign-in only for a sign-in failure, not for a repository the account cannot write", async () => {
    const noCredential = nextRepo();
    fakeRepo({ pushUrl: "https://github.com/acme/app.git", system: { exitCode: 128, stderr: NO_SIGN_IN } });
    await runGitWithGithubAuthFallback(["push"], { cwd: noCredential, readToken: async () => null });
    expect(await readGitTransportStatus(noCredential, async () => null))
      .toMatchObject({ state: "auth_failed", adeCredentialTried: false });

    const denied = nextRepo();
    const deniedCalls = fakeRepo({
      pushUrl: "https://github.com/acme/app.git",
      system: { exitCode: 128, stderr: DENIED },
      ade: { exitCode: 128, stderr: DENIED },
    });
    const result = await runGitWithGithubAuthFallback(["push"], { cwd: denied, readToken });
    expect(result.exitCode).toBe(128);
    expect(deniedCalls.map((call) => call.withToken)).toEqual([false, true]);
    const status = await readGitTransportStatus(denied, readToken);
    expect(status?.state).not.toBe("auth_failed");
  });

  it("tries git's own sign-in again when ADE's token is refused, without running the token twice", async () => {
    const cwd = nextRepo();
    // Git's own sign-in fails first; ADE's token works, so the next run goes straight to it.
    let calls = fakeRepo({ pushUrl: "https://github.com/acme/app.git", system: { exitCode: 128, stderr: NO_SIGN_IN } });
    await runGitWithGithubAuthFallback(["push"], { cwd, readToken });
    expect(calls.map((call) => call.withToken)).toEqual([false, true]);

    // Then the token is revoked and the person fixes git's own sign-in.
    calls = fakeRepo({
      pushUrl: "https://github.com/acme/app.git",
      system: { exitCode: 0 },
      ade: { exitCode: 128, stderr: "remote: Invalid username or token.\nfatal: Authentication failed" },
    });
    const fixed = await runGitWithGithubAuthFallback(["push"], { cwd, readToken });
    expect(fixed.exitCode).toBe(0);
    expect(calls.map((call) => call.withToken)).toEqual([true, false]);
    expect(await readGitTransportStatus(cwd, readToken)).toMatchObject({ state: "ok", via: "system" });
  });
});
