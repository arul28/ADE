/**
 * The git identity of an ADE Cloud computer. A new computer has no
 * `user.name` and no `user.email`, so every `git commit` there (an agent's,
 * and the idle cleanup's `ade cloud push-work`) fails with "Author identity
 * unknown".
 *
 * ADE writes the global identity once the computer knows the account:
 *
 * 1. The account's GitHub user, as GitHub's noreply address
 *    (`<id>+<login>@users.noreply.github.com`), so commits link to the
 *    person on GitHub. The user comes from the ADE GitHub App status
 *    (`GET /github/app/status`), else from `GET api.github.com/user` with
 *    the GitHub token this computer's git uses.
 * 2. With no GitHub user: a neutral ADE identity (`NEUTRAL_IDENTITY`).
 *
 * ADE never writes over an identity that a person or an agent set. It
 * remembers the value it wrote (`<ADE_HOME>/cloud/git-identity.json`). A
 * global identity that is not that value belongs to someone else and stays.
 * The value ADE wrote is replaced only by a better one: the neutral identity
 * gives way to the GitHub user when GitHub is connected later.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NEUTRAL_GIT_IDENTITY = { name: "ADE Cloud", email: "cloud@users.noreply.ade-app.dev" } as const;

export type CloudGitIdentity = { name: string; email: string };
export type CloudGitIdentitySource = "github" | "neutral";

/** What ADE wrote, so a later run knows the global identity is its own. */
type IdentityState = { v: 1; name: string; email: string; source: CloudGitIdentitySource };

export type CloudGitIdentityOutcome =
  /** Someone else set the identity; ADE left it. */
  | { state: "kept" }
  /** ADE's value is already in place. */
  | { state: "current"; source: CloudGitIdentitySource }
  /** ADE wrote the identity now. */
  | { state: "written"; source: CloudGitIdentitySource }
  /** Git could not read or write the config. */
  | { state: "failed"; error: string };

export type GithubUser = { login: string; id: number };

export type CloudGitIdentityDeps = {
  /** `<ADE_HOME>`; the state file is `<ADE_HOME>/cloud/git-identity.json`. */
  adeHome: string;
  /** The account's GitHub user from the ADE GitHub App status, or null. */
  readAppUser: () => Promise<GithubUser | null>;
  /** The GitHub token this computer's git uses, or null. Used only when the App has no user. */
  readGithubToken: () => Promise<string | null>;
  /** Called after a write, so cached `git config` reads in this process see the new value. */
  onWritten?: () => void;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
};

const GITHUB_USER_TIMEOUT_MS = 8_000;

function runGitGlobal(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: os.homedir(), timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      // A git that ran and failed has a number; one that could not start (ENOENT, a timeout) reads as 127.
      const code = !error ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127;
      resolve({ exitCode: code, stdout: String(stdout ?? "") });
    });
  });
}

function statePath(adeHome: string): string {
  return path.join(adeHome, "cloud", "git-identity.json");
}

function readState(adeHome: string): IdentityState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(adeHome), "utf8")) as Partial<IdentityState>;
    if (parsed?.v !== 1 || typeof parsed.name !== "string" || typeof parsed.email !== "string") return null;
    if (parsed.source !== "github" && parsed.source !== "neutral") return null;
    return { v: 1, name: parsed.name, email: parsed.email, source: parsed.source };
  } catch {
    return null;
  }
}

function writeState(adeHome: string, state: IdentityState): void {
  const file = statePath(adeHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** GitHub's noreply identity for a user: the login as the name. */
export function githubNoreplyIdentity(user: GithubUser): CloudGitIdentity {
  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A login and id that are safe to put in a git config value. */
export function validGithubUser(login: unknown, id: unknown): GithubUser | null {
  if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  return { login, id };
}

async function readUserWithToken(token: string): Promise<GithubUser | null> {
  const response = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "ADE" },
    signal: AbortSignal.timeout(GITHUB_USER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { login?: unknown; id?: unknown } | null;
  return validGithubUser(body?.login, body?.id);
}

async function resolveGithubUser(deps: CloudGitIdentityDeps): Promise<GithubUser | null> {
  try {
    const fromApp = await deps.readAppUser();
    if (fromApp) return fromApp;
  } catch (error) {
    deps.logger?.warn("cloud.git_identity_app_read_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const token = await deps.readGithubToken();
    if (!token) return null;
    return await readUserWithToken(token);
  } catch (error) {
    deps.logger?.warn("cloud.git_identity_user_read_failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/**
 * Sets the global git identity of this cloud computer when nobody else did.
 * Safe to call often: it reads two config keys and returns when ADE's
 * GitHub identity is already in place. Never throws.
 */
export async function ensureCloudGitIdentity(deps: CloudGitIdentityDeps): Promise<CloudGitIdentityOutcome> {
  const git = runGitGlobal;
  try {
    const read = async (key: string): Promise<string> => {
      const result = await git(["config", "--global", "--get", key]);
      // Exit 1: the key is not set. Anything else is an error git could not read past.
      if (result.exitCode === 1) return "";
      if (result.exitCode !== 0) throw new Error(`git config --get ${key} exited ${result.exitCode}`);
      return result.stdout.trim();
    };
    const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
    const written = readState(deps.adeHome);
    const ours = Boolean(written && written.name === name && written.email === email);
    if ((name || email) && !ours) return { state: "kept" };
    // ADE's GitHub identity is the best value: nothing more to look up.
    if (ours && written?.source === "github") return { state: "current", source: "github" };

    const user = await resolveGithubUser(deps);
    const target = user ? githubNoreplyIdentity(user) : NEUTRAL_GIT_IDENTITY;
    const source: CloudGitIdentitySource = user ? "github" : "neutral";
    if (ours && written?.source === source && written.name === target.name && written.email === target.email) {
      return { state: "current", source };
    }
    for (const [key, value] of [["user.name", target.name], ["user.email", target.email]] as const) {
      const result = await git(["config", "--global", key, value]);
      if (result.exitCode !== 0) throw new Error(`git config ${key} exited ${result.exitCode}`);
    }
    writeState(deps.adeHome, { v: 1, name: target.name, email: target.email, source });
    deps.onWritten?.();
    deps.logger?.info("cloud.git_identity_written", { source });
    return { state: "written", source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger?.warn("cloud.git_identity_failed", { error: message });
    return { state: "failed", error: message };
  }
}

/**
 * The identity a commit can pass with `-c` when git has none: the value ADE
 * wrote, else the neutral one. A cloud computer's git service commits with
 * it (`commitIdentityFallback`), so a commit never fails on a missing
 * identity, even when the global write failed.
 */
export function fallbackCommitIdentity(adeHome: string): CloudGitIdentity {
  const written = readState(adeHome);
  return written ? { name: written.name, email: written.email } : { ...NEUTRAL_GIT_IDENTITY };
}

/**
 * The brain's single-flight runner: one check at a time, and every caller
 * waits for the same one. The account's GitHub user comes from the ADE
 * GitHub App status with the account's token.
 */
export function createBrainCloudGitIdentity(deps: {
  adeHome: string;
  directoryBaseUrl: () => string | null;
  accountAccessToken: () => Promise<string | null>;
  readGithubToken: () => Promise<string | null>;
  logger: NonNullable<CloudGitIdentityDeps["logger"]>;
}): { ensure: () => Promise<CloudGitIdentityOutcome> } {
  let running: Promise<CloudGitIdentityOutcome> | null = null;
  const readAppUser = async (): Promise<GithubUser | null> => {
    const baseUrl = deps.directoryBaseUrl();
    if (!baseUrl) return null;
    const { createAccountAppTokenClient } = await import("../../../../desktop/src/shared/github/accountAppTokenClient");
    const client = createAccountAppTokenClient({
      getAccountAccessToken: async () => await deps.accountAccessToken().catch(() => null),
      // A status read only: no cached token, so no account to key one by.
      getAccountUserId: () => null,
      getDirectoryBaseUrl: () => baseUrl,
      store: null,
      holderId: "cloud-git-identity",
      clientKind: "cli",
    });
    const answer = await client.status();
    if (!answer.ok || !answer.status.connected) return null;
    return validGithubUser(answer.status.githubLogin, answer.status.githubUserId);
  };
  const ensure = (): Promise<CloudGitIdentityOutcome> => {
    running ??= (async () => {
      const { invalidateGitRepoCache } = await import("../../../../desktop/src/main/services/git/gitRepoCache");
      return await ensureCloudGitIdentity({
        adeHome: deps.adeHome,
        readAppUser,
        readGithubToken: deps.readGithubToken,
        // `getUserIdentity` keeps `git config` reads as stable answers.
        onWritten: () => invalidateGitRepoCache(),
        logger: deps.logger,
      });
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return { ensure };
}
