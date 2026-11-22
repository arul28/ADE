import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCloudGitIdentity, NEUTRAL_GIT_IDENTITY, type GithubUser } from "./cloudGitIdentity";

// The real git, on a global config file of the test's own (GIT_CONFIG_GLOBAL).
describe("ensureCloudGitIdentity", () => {
  let dir: string;
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  const config = (key: string): string => {
    try {
      return execFileSync("git", ["config", "--global", "--get", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const setConfig = (key: string, value: string) => execFileSync("git", ["config", "--global", key, value]);
  const run = (user: GithubUser | null) => ensureCloudGitIdentity({
    adeHome: path.join(dir, "ade"),
    readAppUser: async () => user,
    readGithubToken: async () => null,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-git-identity-"));
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });
  afterEach(() => {
    if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.global;
    if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["a name and an email", [["user.name", "Person"], ["user.email", "person@example.com"]]],
    ["only an email", [["user.email", "person@example.com"]]],
  ])("never writes over an identity a person set (%s)", async (_label, values) => {
    for (const [key, value] of values) setConfig(key!, value!);
    const outcome = await run({ login: "octo", id: 42 });
    expect(outcome).toEqual({ state: "kept" });
    expect(config("user.name")).toBe(values.find(([key]) => key === "user.name")?.[1] ?? "");
    expect(config("user.email")).toBe("person@example.com");
  });

  it("writes the neutral identity, replaces only its own value once GitHub is known, and keeps a later change by a person", async () => {
    expect(await run(null)).toEqual({ state: "written", source: "neutral" });
    expect(config("user.email")).toBe(NEUTRAL_GIT_IDENTITY.email);

    expect(await run({ login: "octo", id: 42 })).toEqual({ state: "written", source: "github" });
    expect(config("user.name")).toBe("octo");
    expect(config("user.email")).toBe("42+octo@users.noreply.github.com");
    expect(await run({ login: "octo", id: 42 })).toEqual({ state: "current", source: "github" });

    setConfig("user.email", "agent@example.com");
    expect(await run({ login: "other", id: 7 })).toEqual({ state: "kept" });
    expect(config("user.email")).toBe("agent@example.com");
  });
});
