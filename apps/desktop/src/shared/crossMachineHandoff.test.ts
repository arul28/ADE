import { describe, expect, it } from "vitest";
import {
  decodeAcceptCrossMachineHandoffResult,
  decodeCrossMachineDestinationPreflightResult,
  decodeRemoteRuntimeHandoffStoragePreflightResult,
  normalizeGitRemoteIdentity,
  pickLiveCheckout,
  sanitizePortableGitRemote,
} from "./crossMachineHandoff";

describe("cross-machine handoff boundaries", () => {
  it("normalizes equivalent Git remotes and removes every URL credential surface", () => {
    expect(normalizeGitRemoteIdentity("git@github.com:Example/ADE.git")).toBe("github.com/example/ade");
    expect(normalizeGitRemoteIdentity("https://github.com/example/ade.git?token=secret#fragment"))
      .toBe("github.com/example/ade");
    expect(sanitizePortableGitRemote(
      "https://user:password@github.com/example/ade.git?token=secret#fragment",
    )).toBe("https://github.com/example/ade.git");
    expect(sanitizePortableGitRemote(
      "ssh://git:password@github.com/example/ade.git?token=secret#fragment",
    )).toBe("ssh://git@github.com/example/ade.git");
    expect(normalizeGitRemoteIdentity("ssh://git@github.com/example/ade.git"))
      .toBe("github.com/example/ade");
  });

  it("rejects malformed remote preflight and acceptance payloads at the boundary", () => {
    expect(() => decodeRemoteRuntimeHandoffStoragePreflightResult({
      parentDir: "/repo",
      targetPath: "/repo/ade",
      freeBytes: "lots",
      requiredBytes: 1,
      hasEnoughSpace: true,
      targetExists: false,
      blockingErrors: [],
      warnings: [],
    })).toThrow(/free space is invalid/i);

    expect(() => decodeCrossMachineDestinationPreflightResult({
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: null,
      existingLaneId: null,
      blockingErrors: "none",
      warnings: [],
    })).toThrow(/handoff errors is invalid/i);

    expect(() => decodeAcceptCrossMachineHandoffResult({
      handoffId: "handoff-1",
      laneId: "lane-1",
      session: { id: "chat-1" },
      reusedLane: false,
      reusedSession: false,
    })).toThrow(/destination chat lane is missing/i);
  });

  it("passes fork handoff support through the preflight decoder and treats absence as absent", () => {
    const base = {
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: null,
      existingLaneId: null,
      blockingErrors: [],
      warnings: [],
    };
    // Older ADE destinations omit the field entirely — it must stay absent so
    // callers treat the machine as fork-unsupported.
    expect(decodeCrossMachineDestinationPreflightResult(base)).not.toHaveProperty("forkHandoffSupport");
    expect(decodeCrossMachineDestinationPreflightResult({
      ...base,
      forkHandoffSupport: { supported: true },
    }).forkHandoffSupport).toEqual({ supported: true });
    expect(decodeCrossMachineDestinationPreflightResult({
      ...base,
      forkHandoffSupport: { supported: false, reason: "Droid sessions aren't portable between machines yet" },
    }).forkHandoffSupport).toEqual({
      supported: false,
      reason: "Droid sessions aren't portable between machines yet",
    });
    expect(() => decodeCrossMachineDestinationPreflightResult({
      ...base,
      forkHandoffSupport: { supported: "yes" },
    })).toThrow(/fork handoff supported flag is invalid/i);
  });

  it.each([
    {
      label: "a moved project: the folder still on disk beats a newer stale copy",
      checkouts: [
        { id: "old", lastOpenedAt: 900, exists: false },
        { id: "moved", lastOpenedAt: 100, exists: true },
      ],
      picked: "moved",
    },
    {
      label: "a folder the person opened beats one something ran ADE in",
      checkouts: [
        { id: "ran-in", lastOpenedAt: 900, catalogVisibility: "system" as const },
        { id: "opened", lastOpenedAt: 100, catalogVisibility: "recent" as const },
      ],
      picked: "opened",
    },
    {
      label: "an older brain that sends no folder check: the most recent wins",
      checkouts: [{ id: "a", lastOpenedAt: 100 }, { id: "b", lastOpenedAt: 900 }],
      picked: "b",
    },
  ])("works on the live checkout of a project another machine has — $label", ({ checkouts, picked }) => {
    expect(pickLiveCheckout(checkouts)?.id).toBe(picked);
    expect(pickLiveCheckout([...checkouts].reverse())?.id).toBe(picked);
    expect(pickLiveCheckout([])).toBeNull();
  });
});
