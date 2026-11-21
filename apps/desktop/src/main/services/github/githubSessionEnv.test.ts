import { describe, expect, it } from "vitest";
import type { AppGrantReader } from "../../../shared/github/githubAppGrant";
import { createGithubSessionEnv } from "./githubSessionEnv";

const APP = "ghu_app_token";
const GH_COPY = "gho_account_copy";

function service(input: { appToken: string | null; installed: boolean; ghCopy: string | null; ownGhLogin?: boolean }) {
  const readGrant = (async () => ({ installed: input.installed })) as unknown as AppGrantReader;
  return createGithubSessionEnv({
    // A service that does not answer shells leaves the process-wide answer alone.
    answersShells: false,
    readAccountAppToken: async () => input.appToken,
    peekAccountAppToken: () => input.appToken,
    peekAccountGhToken: () => input.ghCopy,
    readGrant,
    readRepoOwner: async () => "yoink-labs",
    hasOwnGhLogin: () => input.ownGhLogin ?? false,
  });
}

describe("createGithubSessionEnv", () => {
  // The shim is not configured in this process, so a session gets the token itself.
  it.each([
    { name: "App installed on the owner", appToken: APP, installed: true, ghCopy: GH_COPY, expected: APP },
    { name: "owner without the App, account gh copy", appToken: APP, installed: false, ghCopy: GH_COPY, expected: GH_COPY },
    { name: "no App sign-in, account gh copy", appToken: null, installed: false, ghCopy: GH_COPY, expected: GH_COPY },
    { name: "owner without the App, no copy", appToken: APP, installed: false, ghCopy: null, expected: null },
  ])("gives gh the right token: $name", async ({ appToken, installed, ghCopy, expected }) => {
    const env = service({ appToken, installed, ghCopy });
    expect(await env.tokenForOwner("yoink-labs")).toBe(expected);
    const session = await env.forSession({});
    expect(session?.GH_TOKEN ?? null).toBe(expected);
  });

  it.each([
    { name: "gh has its own login", env: {}, ownGhLogin: true },
    { name: "the session has its own token", env: { GITHUB_TOKEN: "ghp_own" }, ownGhLogin: false },
  ])("adds nothing when $name", async ({ env, ownGhLogin }) => {
    const sessionEnv = service({ appToken: APP, installed: false, ghCopy: GH_COPY, ownGhLogin });
    expect(await sessionEnv.forSession(env)).toBeNull();
  });
});
