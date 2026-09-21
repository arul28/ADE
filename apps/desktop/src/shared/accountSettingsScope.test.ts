import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SCOPE_ALL,
  accountRepoScopeKey,
  accountSettingScopeKey,
  isAccountScope,
  isRepoScope,
} from "./accountSettingsScope";

describe("account setting scope keys", () => {
  it("files an account-wide setting under one key", () => {
    expect(accountSettingScopeKey("account", null)).toBe(ACCOUNT_SCOPE_ALL);
    expect(accountSettingScopeKey("account", "git@github.com:arul28/ADE.git")).toBe(ACCOUNT_SCOPE_ALL);
  });

  // The placement rule is enforced here rather than merely documented: a value
  // holding a path, a port, or a piece of hardware never leaves the machine.
  it("never sends a machine-scoped setting to the account store", () => {
    expect(accountSettingScopeKey("machine", "git@github.com:arul28/ADE.git")).toBeNull();
    expect(accountSettingScopeKey("machine-repo", "git@github.com:arul28/ADE.git")).toBeNull();
  });

  it("gives every form of the same remote one key", () => {
    const expected = "repo:github.com/arul28/ade";
    for (const remote of [
      "git@github.com:arul28/ADE.git",
      "https://github.com/arul28/ADE.git",
      "https://github.com/arul28/ADE",
      "https://GitHub.com/Arul28/ADE.git",
      "ssh://git@github.com/arul28/ADE.git",
    ]) {
      expect(accountRepoScopeKey(remote), remote).toBe(expected);
    }
  });

  // This key is sent to a Worker and stored in D1. A remote of the form
  // https://<token>@github.com/owner/repo is a real thing people have in
  // .git/config, and it must not ride along inside the key.
  it("strips a credential out of the key", () => {
    expect(accountRepoScopeKey("https://ghp_secrettoken@github.com/arul28/ADE.git"))
      .toBe("repo:github.com/arul28/ade");
    expect(accountRepoScopeKey("https://user:pass@github.com/arul28/ADE"))
      .not.toContain("pass");
  });

  it("works for hosts that are not GitHub", () => {
    expect(accountRepoScopeKey("git@gitlab.com:team/service.git"))
      .toBe("repo:gitlab.com/team/service");
    expect(accountRepoScopeKey("https://git.internal.example/dept/tool.git"))
      .toBe("repo:git.internal.example/dept/tool");
  });

  // A repository with no remote has no identity that means anything on a second
  // machine, so its repo-scoped settings stay local until it gets one. That is
  // an answer, not a failure.
  it("answers null for a project with no usable remote", () => {
    expect(accountRepoScopeKey(null)).toBeNull();
    expect(accountRepoScopeKey("")).toBeNull();
    expect(accountRepoScopeKey("   ")).toBeNull();
    expect(accountSettingScopeKey("account-repo", null)).toBeNull();
  });

  // A bare host is not a repository; treating it as one would make every
  // unparseable remote share a single bucket across unrelated projects.
  it("refuses a bare host as a repository", () => {
    expect(accountRepoScopeKey("github.com")).toBeNull();
    expect(accountRepoScopeKey("https://github.com")).toBeNull();
  });

  it("ignores a trailing slash", () => {
    expect(accountRepoScopeKey("https://github.com/arul28/ADE/"))
      .toBe("repo:github.com/arul28/ade");
  });

  it("classifies the four scopes", () => {
    expect(isAccountScope("account")).toBe(true);
    expect(isAccountScope("account-repo")).toBe(true);
    expect(isAccountScope("machine")).toBe(false);
    expect(isAccountScope("machine-repo")).toBe(false);

    expect(isRepoScope("account-repo")).toBe(true);
    expect(isRepoScope("machine-repo")).toBe(true);
    expect(isRepoScope("account")).toBe(false);
    expect(isRepoScope("machine")).toBe(false);
  });

  // The Worker validates this shape, so a key it would reject is a bug the
  // client should never be able to produce.
  it("only ever produces a key the relay accepts", () => {
    const key = accountRepoScopeKey("git@github.com:arul28/ADE.git")!;
    expect(key.startsWith("repo:")).toBe(true);
    expect(key.length).toBeGreaterThan("repo:".length);
    expect(ACCOUNT_SCOPE_ALL).toBe("all");
  });
});
