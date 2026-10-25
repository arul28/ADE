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
const execFileFailure = vi.hoisted(() => ({ hosts: new Set<string>(), missing: new Set<string>(), calls: 0 }));

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
    execFile: ((command: string, args: string[], _options: unknown, callback: (error: unknown, stdout: string) => void) => {
      if (command !== "ssh") throw new Error(`unexpected command ${command}`);
      const host = args[args.length - 1]!;
      if (execFileFailure.missing.has(host)) {
        execFileFailure.calls += 1;
        callback(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }), "");
        return;
      }
      if (execFileFailure.hosts.has(host)) {
        execFileFailure.calls += 1;
        callback(Object.assign(new Error("ssh exited 255"), { code: 255 }), "");
        return;
      }
      callback(null, `hostname ${sshState.hostnames.get(host) ?? host}\n`);
    }) as unknown as typeof actual.execFile,
  };
});

import { gitRemoteIdentity, peerGitRemoteIdentity, resolveCanonicalGitOrigin } from "./githubSshAlias";

beforeEach(() => {
  sshState.calls.length = 0;
});

describe("resolveCanonicalGitOrigin", () => {
  it.each([
    ["an scp alias of github.com", "git@github.com-work:Acme/Shop.git", "git@github.com:Acme/Shop.git"],
    ["an ssh:// alias of ssh.github.com on port 443", "ssh://git@gh443:443/Acme/Shop.git", "ssh://git@github.com/Acme/Shop.git"],
    ["an scp alias with a leading slash", "git@github.com-work:/Acme/Shop.git", "git@github.com:Acme/Shop.git"],
    ["GitHub's port-443 host itself", "ssh://git@ssh.github.com:443/Acme/Shop.git", "ssh://git@github.com/Acme/Shop.git"],
    ["a known public forge", "git@bitbucket.org:Acme/Shop.git", "git@bitbucket.org:Acme/Shop.git"],
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
    if (/^(https:|C:)|-oProxy|ssh\.github|bitbucket/.test(input)) expect(sshState.calls).toEqual([]);
  });

  it("gives an alias checkout and an https checkout one repository identity, and asks ssh once per host", () => {
    expect(gitRemoteIdentity("git@github.com-work:Acme/Shop.git")).toBe(gitRemoteIdentity("https://github.com/acme/shop"));
    expect(gitRemoteIdentity("git@gitlab-alias:Acme/Shop.git")).not.toBe(gitRemoteIdentity("https://github.com/acme/shop"));
    const before = sshState.calls.length;
    gitRemoteIdentity("git@github.com-work:Acme/Other.git");
    expect(sshState.calls.length).toBe(before);
    // An origin from another machine never resolves an alias, even one this
    // machine knows: the same alias name can point elsewhere over there.
    expect(peerGitRemoteIdentity("git@github.com-work:Acme/Shop.git")).toBe("github.com-work/acme/shop");
    expect(peerGitRemoteIdentity("ssh://git@ssh.github.com:443/Acme/Shop.git")).toBe("github.com/acme/shop");
    expect(sshState.calls.length).toBe(before);
  });

  it("reports a failed lookup and missing ssh as retryable, and keeps a good answer through a failed refresh", async () => {
    expect(resolveCanonicalGitOrigin("git@broken-host:Acme/Shop.git")).toEqual({
      url: "git@broken-host:Acme/Shop.git",
      lookupFailed: true,
    });
    expect(resolveCanonicalGitOrigin("git@missing-ssh:Acme/Shop.git")).toEqual({
      url: "git@missing-ssh:Acme/Shop.git",
      lookupFailed: true,
    });

    // Only the clock is fake, so the background refresh settles on real ticks.
    vi.useFakeTimers({ toFake: ["Date"] });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      sshState.hostnames.set("flaky-alias", "github.com");
      expect(resolveCanonicalGitOrigin("git@flaky-alias:Acme/Shop.git").url).toBe("git@github.com:Acme/Shop.git");
      // The answer expires and the background refresh fails.
      sshState.hostnames.set("flaky-alias", "");
      vi.setSystemTime(Date.now() + 61_000);
      execFileFailure.hosts.add("flaky-alias");
      resolveCanonicalGitOrigin("git@flaky-alias:Acme/Shop.git");
      await vi.waitFor(() => expect(execFileFailure.calls).toBe(1));
      await settle();
      expect(resolveCanonicalGitOrigin("git@flaky-alias:Acme/Shop.git").url).toBe("git@github.com:Acme/Shop.git");
      // ssh then disappears from PATH: the good answer still holds.
      vi.setSystemTime(Date.now() + 61_000);
      execFileFailure.hosts.delete("flaky-alias");
      execFileFailure.missing.add("flaky-alias");
      resolveCanonicalGitOrigin("git@flaky-alias:Acme/Shop.git");
      await vi.waitFor(() => expect(execFileFailure.calls).toBe(2));
      await settle();
      expect(resolveCanonicalGitOrigin("git@flaky-alias:Acme/Shop.git").url).toBe("git@github.com:Acme/Shop.git");
    } finally {
      vi.useRealTimers();
    }
  });
});
