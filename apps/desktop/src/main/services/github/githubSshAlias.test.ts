import { beforeEach, describe, expect, it, vi } from "vitest";

// `ssh -G` is the process boundary. Each host maps to the `hostname` line a
// two-account ~/.ssh/config would print; "missing" and "broken" are failures.
const sshState = vi.hoisted(() => ({
  hostnames: new Map<string, string>([
    ["github.com-work", "github.com"],
    ["gh443", "ssh.github.com"],
    ["gitlab-alias", "gitlab.com"],
    ["evil-alias", "evilgithub.com"],
  ]),
  calls: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args: string[]) => {
      if (command !== "ssh") throw new Error(`unexpected command ${command}`);
      sshState.calls.push(args);
      const host = args[args.length - 1]!;
      if (host.startsWith("missing")) {
        return { status: null, stdout: "", stderr: "", signal: null, error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) };
      }
      if (host.startsWith("broken")) return { status: 255, stdout: "", stderr: "bad config", signal: null, error: undefined };
      return { status: 0, stdout: `user git\nhostname ${sshState.hostnames.get(host) ?? host}\n`, stderr: "", signal: null, error: undefined };
    }) as typeof actual.spawnSync,
  };
});

import { gitRemoteIdentity, resolveCanonicalGitOrigin } from "./githubSshAlias";

beforeEach(() => {
  sshState.calls.length = 0;
});

describe("resolveCanonicalGitOrigin", () => {
  it.each([
    ["an scp alias of github.com", "git@github.com-work:Acme/Shop.git", "git@github.com:Acme/Shop.git"],
    ["an ssh:// alias of ssh.github.com on port 443", "ssh://git@gh443:443/Acme/Shop.git", "ssh://git@github.com/Acme/Shop.git"],
    ["an alias of another forge", "git@gitlab-alias:Acme/Shop.git", "git@gitlab-alias:Acme/Shop.git"],
    ["an alias of a look-alike host", "git@evil-alias:Acme/Shop.git", "git@evil-alias:Acme/Shop.git"],
    ["a plain GitHub URL", "https://github.com/Acme/Shop.git", "https://github.com/Acme/Shop.git"],
    ["a host that ssh would read as an option", "git@-oProxyCommand=touch:Acme/Shop.git", "git@-oProxyCommand=touch:Acme/Shop.git"],
    ["a Windows drive path", "C:/repos/shop", "C:/repos/shop"],
  ])("maps %s to the URL that names the repository", (_label, input, expected) => {
    expect(resolveCanonicalGitOrigin(input)).toEqual({ url: expected, lookupFailed: false });
    for (const args of sshState.calls) {
      expect(args[0]).toBe("-G");
      expect(args[args.length - 1]).not.toMatch(/^-/);
    }
    if (/^(https:|C:)|-oProxy/.test(input)) expect(sshState.calls).toEqual([]);
  });

  it("gives an alias checkout and an https checkout one repository identity, and asks ssh once per host", () => {
    expect(gitRemoteIdentity("git@github.com-work:Acme/Shop.git")).toBe(gitRemoteIdentity("https://github.com/acme/shop"));
    expect(gitRemoteIdentity("git@gitlab-alias:Acme/Shop.git")).not.toBe(gitRemoteIdentity("https://github.com/acme/shop"));
    const before = sshState.calls.length;
    gitRemoteIdentity("git@github.com-work:Acme/Other.git");
    expect(sshState.calls.length).toBe(before);
  });

  it("reports a failed lookup as retryable, and missing ssh as a final answer", () => {
    expect(resolveCanonicalGitOrigin("git@broken-host:Acme/Shop.git")).toEqual({
      url: "git@broken-host:Acme/Shop.git",
      lookupFailed: true,
    });
    expect(resolveCanonicalGitOrigin("git@missing-ssh:Acme/Shop.git")).toEqual({
      url: "git@missing-ssh:Acme/Shop.git",
      lookupFailed: false,
    });
  });
});
