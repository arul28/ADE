import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubStarActionSupported,
  parseGithubRepoUrl,
  readRepoStarState,
  setRepoStarred,
} from "./githubStars";

function installBridge(github: Record<string, unknown> | null): void {
  (globalThis as unknown as { window: { ade: { github: unknown } } }).window = {
    ade: { github },
  } as never;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("parseGithubRepoUrl", () => {
  it.each([
    ["https://github.com/acme/ade", { owner: "acme", name: "ade" }],
    ["https://github.com/acme/ade/", { owner: "acme", name: "ade" }],
    ["https://github.com/acme/ade.git", { owner: "acme", name: "ade" }],
    ["https://github.com/acme/ade.git/", { owner: "acme", name: "ade" }],
    ["  https://github.com/acme/ade  ", { owner: "acme", name: "ade" }],
    ["https://github.com/a-c.me_1/ade.js", { owner: "a-c.me_1", name: "ade.js" }],
  ])("accepts %s", (url, expected) => {
    expect(parseGithubRepoUrl(url)).toEqual(expected);
  });

  it.each([
    ["credentials in the authority", "https://user:token@github.com/acme/ade"],
    ["a username with no password", "https://user@github.com/acme/ade"],
    ["a non-GitHub host", "https://gitlab.com/acme/ade"],
    ["a lookalike host", "https://github.com.evil.example/acme/ade"],
    ["a GitHub subdomain", "https://raw.githubusercontent.com/acme/ade"],
    ["plain http", "http://github.com/acme/ade"],
    ["a deeper path", "https://github.com/acme/ade/tree/main"],
    ["an owner-only URL", "https://github.com/acme"],
    ["an encoded separator", "https://github.com/acme%2Fevil/ade"],
    ["a bare .git name", "https://github.com/acme/.git"],
    ["not a URL at all", "acme/ade"],
    ["an empty string", "   "],
  ])("rejects %s", (_reason, url) => {
    expect(parseGithubRepoUrl(url)).toBeNull();
  });

  it("rejects nullish input", () => {
    expect(parseGithubRepoUrl(null)).toBeNull();
    expect(parseGithubRepoUrl(undefined)).toBeNull();
  });
});

describe("githubStarActionSupported", () => {
  it("is false on a host whose github namespace predates the star members", () => {
    installBridge({ getStatus: vi.fn() });
    expect(githubStarActionSupported()).toBe(false);
  });

  it("is false when only one half of the pair exists", () => {
    installBridge({ getRepoStarState: vi.fn() });
    expect(githubStarActionSupported()).toBe(false);
  });

  it("is true once both members are present", () => {
    installBridge({ getRepoStarState: vi.fn(), setRepoStarred: vi.fn() });
    expect(githubStarActionSupported()).toBe(true);
  });
});

describe("readRepoStarState", () => {
  it("returns null on an unsupported host instead of throwing", async () => {
    installBridge({});
    await expect(readRepoStarState({ owner: "acme", name: "ade" })).resolves.toBeNull();
  });

  it("returns null when the read fails (not connected, rate limited, private)", async () => {
    installBridge({
      getRepoStarState: vi.fn().mockRejectedValue(new Error("GitHub auth missing.")),
      setRepoStarred: vi.fn(),
    });
    await expect(readRepoStarState({ owner: "acme", name: "ade" })).resolves.toBeNull();
  });

  it("normalizes an unreadable star count to null", async () => {
    installBridge({
      getRepoStarState: vi.fn().mockResolvedValue({ starred: true, stars: null }),
      setRepoStarred: vi.fn(),
    });
    await expect(readRepoStarState({ owner: "acme", name: "ade" })).resolves.toEqual({
      starred: true,
      stars: null,
    });
  });

  it("passes owner/name through and returns the state", async () => {
    const getRepoStarState = vi.fn().mockResolvedValue({ starred: false, stars: 42 });
    installBridge({ getRepoStarState, setRepoStarred: vi.fn() });

    await expect(readRepoStarState({ owner: "acme", name: "ade" })).resolves.toEqual({
      starred: false,
      stars: 42,
    });
    expect(getRepoStarState).toHaveBeenCalledWith({ owner: "acme", name: "ade" });
  });
});

describe("setRepoStarred", () => {
  it("rejects on an unsupported host", async () => {
    installBridge({});
    await expect(setRepoStarred({ owner: "acme", name: "ade" }, true)).rejects.toThrow(
      /cannot star/i,
    );
  });

  it("propagates the failure so the caller can revert its optimistic update", async () => {
    installBridge({
      getRepoStarState: vi.fn(),
      setRepoStarred: vi.fn().mockRejectedValue(new Error("Requires authentication")),
    });
    await expect(setRepoStarred({ owner: "acme", name: "ade" }, true)).rejects.toThrow(
      "Requires authentication",
    );
  });

  it("forwards the desired state", async () => {
    const bridgeSetRepoStarred = vi.fn().mockResolvedValue(undefined);
    installBridge({ getRepoStarState: vi.fn(), setRepoStarred: bridgeSetRepoStarred });

    await setRepoStarred({ owner: "acme", name: "ade" }, false);
    expect(bridgeSetRepoStarred).toHaveBeenCalledWith({
      owner: "acme",
      name: "ade",
      starred: false,
    });
  });
});
