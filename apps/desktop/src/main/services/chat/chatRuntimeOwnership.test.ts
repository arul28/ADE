import { describe, expect, it } from "vitest";
import {
  decideChatRuntimeOwnership,
  nextBrainInstanceId,
  normalizeChatRuntimeOwner,
  resolveAdeHomeForOwnership,
  type ChatRuntimeOwner,
} from "./chatRuntimeOwnership";

const SELF = {
  brainId: "brain-b",
  pid: 999,
  startedAt: "2026-09-18T20:00:00.000Z",
  adeHome: "/Users/x/.ade",
} as const;

function owner(overrides: Partial<ChatRuntimeOwner> = {}): ChatRuntimeOwner {
  return {
    brainId: "brain-a",
    pid: 42765,
    startedAt: "2026-09-18T10:00:00.000Z",
    adeHome: "/Users/x/.ade",
    claimedAt: "2026-09-18T10:00:01.000Z",
    ...overrides,
  };
}

describe("decideChatRuntimeOwnership", () => {
  it("leaves a session claimed by a live foreign brain on the same ADE home untouched", () => {
    const decision = decideChatRuntimeOwnership({
      owner: owner(),
      self: SELF,
      isProcessIdentityLive: (pid, startedAt) =>
        pid === 42765 && startedAt === "2026-09-18T10:00:00.000Z",
    });
    expect(decision).toEqual({ adoptable: false, verdict: "live-foreign-brain" });
  });

  it("adopts a session whose owning brain process is dead", () => {
    const decision = decideChatRuntimeOwnership({
      owner: owner(),
      self: SELF,
      isProcessIdentityLive: () => false,
    });
    expect(decision).toEqual({ adoptable: true, verdict: "dead-owner" });
  });

  it("adopts a legacy record that carries no ownership at all", () => {
    expect(
      decideChatRuntimeOwnership({
        owner: null,
        self: SELF,
        isProcessIdentityLive: () => true,
      }),
    ).toEqual({ adoptable: true, verdict: "legacy" });
  });

  it("treats its own earlier claim as its own even after a pid re-read", () => {
    expect(
      decideChatRuntimeOwnership({
        owner: owner({ brainId: SELF.brainId, pid: SELF.pid }),
        self: SELF,
        isProcessIdentityLive: () => true,
      }),
    ).toEqual({ adoptable: true, verdict: "self" });
  });

  it("ignores a claim made against a different ADE home, whose pid means nothing here", () => {
    expect(
      decideChatRuntimeOwnership({
        owner: owner({ adeHome: "/Users/x/.ade-other" }),
        self: SELF,
        // Same pid IS live locally — the home mismatch must win anyway.
        isProcessIdentityLive: () => true,
      }),
    ).toEqual({ adoptable: true, verdict: "foreign-home" });
  });

  it("still defends a claim when neither side recorded an ADE home", () => {
    expect(
      decideChatRuntimeOwnership({
        owner: owner({ adeHome: null }),
        self: { ...SELF, adeHome: null },
        isProcessIdentityLive: () => true,
      }),
    ).toEqual({ adoptable: false, verdict: "live-foreign-brain" });
  });

  it("case-folds Windows ADE homes before deciding ownership", () => {
    expect(
      decideChatRuntimeOwnership({
        owner: owner({ adeHome: "c:\\users\\me\\.ade" }),
        self: { ...SELF, adeHome: "C:\\Users\\Me\\.ade" },
        platform: "win32",
        isProcessIdentityLive: () => false,
      }),
    ).toEqual({ adoptable: true, verdict: "dead-owner" });
  });
});

describe("normalizeChatRuntimeOwner", () => {
  it("drops a stamp that cannot identify a process, so corruption never locks a chat", () => {
    expect(normalizeChatRuntimeOwner(null)).toBeNull();
    expect(normalizeChatRuntimeOwner({ pid: 5 })).toBeNull();
    expect(normalizeChatRuntimeOwner({ brainId: "b", pid: 0 })).toBeNull();
    expect(normalizeChatRuntimeOwner({ brainId: "   ", pid: 5 })).toBeNull();
  });

  it("keeps the identity fields and tolerates a missing claimedAt", () => {
    const normalized = normalizeChatRuntimeOwner({
      brainId: "brain-a",
      pid: 42765,
      startedAt: " 2026-09-18T10:00:00.000Z ",
      adeHome: "/Users/x/.ade",
      socketPath: "/tmp/ade.sock",
    });
    expect(normalized).toMatchObject({
      brainId: "brain-a",
      pid: 42765,
      startedAt: "2026-09-18T10:00:00.000Z",
      adeHome: "/Users/x/.ade",
      socketPath: "/tmp/ade.sock",
    });
    expect(typeof normalized?.claimedAt).toBe("string");
  });
});

describe("resolveAdeHomeForOwnership", () => {
  it("prefers ADE_HOME and returns an absolute path", () => {
    expect(resolveAdeHomeForOwnership({ ADE_HOME: "/tmp/ade-home" } as NodeJS.ProcessEnv))
      .toBe("/tmp/ade-home");
    expect(resolveAdeHomeForOwnership({} as NodeJS.ProcessEnv).endsWith(".ade")).toBe(true);
  });
});

describe("nextBrainInstanceId", () => {
  it("is unique per call and never draws from the crypto RNG the chat suite stubs", () => {
    const first = nextBrainInstanceId(() => 1_000_000, () => 10);
    const second = nextBrainInstanceId(() => 1_000_000, () => 10);
    expect(first).not.toBe(second);
    // Pid + process start instant, so a reused pid from a later start differs.
    expect(first.startsWith(`brain-${process.pid}-990000-`)).toBe(true);
  });
});
