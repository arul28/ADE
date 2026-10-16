import { describe, expect, it } from "vitest";

import { devinCloudRepoMatchKey, repoMatchKey } from "./cursorCloudRepoMatch";

describe("repoMatchKey", () => {
  it("normalizes https, scp-style ssh, and ssh:// URL forms to one key", () => {
    const key = "github.com/owner/repo";
    expect(repoMatchKey("https://github.com/owner/repo")).toBe(key);
    expect(repoMatchKey("https://github.com/owner/repo.git")).toBe(key);
    expect(repoMatchKey("git@github.com:owner/repo.git")).toBe(key);
    expect(repoMatchKey("ssh://git@github.com/owner/repo.git")).toBe(key);
  });

  it("drops an explicit port on URL-form remotes", () => {
    expect(repoMatchKey("ssh://git@ssh.github.com:443/owner/repo.git")).toBe("github.com/owner/repo");
    expect(repoMatchKey("https://git.example.com:8443/owner/repo.git")).toBe("git.example.com/owner/repo");
  });

  it("canonicalizes GitHub's dedicated ssh host", () => {
    expect(repoMatchKey("ssh://git@ssh.github.com/owner/repo")).toBe("github.com/owner/repo");
  });

  it("is case-insensitive and ignores trailing slashes", () => {
    expect(repoMatchKey("HTTPS://GitHub.com/Owner/Repo/")).toBe("github.com/owner/repo");
  });

  it("returns empty for missing input", () => {
    expect(repoMatchKey(null)).toBe("");
    expect(repoMatchKey("")).toBe("");
    expect(repoMatchKey("   ")).toBe("");
  });
});

describe("devinCloudRepoMatchKey", () => {
  it("host-qualifies bare owner/repo slugs as github.com", () => {
    expect(devinCloudRepoMatchKey("Owner/Repo")).toBe("github.com/owner/repo");
  });

  it("matches a lane remote against either reporting form", () => {
    const laneKey = repoMatchKey("git@github.com:owner/repo.git");
    expect(devinCloudRepoMatchKey("owner/repo")).toBe(laneKey);
    expect(devinCloudRepoMatchKey("https://github.com/owner/repo")).toBe(laneKey);
  });

  it("leaves non-GitHub qualified remotes untouched", () => {
    expect(devinCloudRepoMatchKey("https://gitlab.example.com/owner/repo")).toBe("gitlab.example.com/owner/repo");
  });
});
