import { describe, expect, it, beforeEach } from "vitest";
import {
  canCreateLaneOnMachine,
  cachedGitRemoteIdentity,
  defaultLaneMachineId,
  deriveLaneMachineOptions,
  isLowLaneMachineDisk,
  resetGitRemoteIdentityCache,
  THIS_MACHINE_ID,
} from "./laneMachines";
import type {
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";

function project(
  overrides: Partial<RemoteRuntimeProjectRecord> & { projectId: string },
): RemoteRuntimeProjectRecord {
  return {
    rootPath: `/Users/x/${overrides.projectId}`,
    displayName: overrides.projectId,
    addedAt: 0,
    lastOpenedAt: 0,
    gitOriginUrl: null,
    ...overrides,
  };
}

function connection(
  overrides: {
    id: string;
    name?: string;
    state?: RemoteRuntimeConnectionStatus["state"];
    projects?: RemoteRuntimeProjectRecord[];
    version?: string | null;
    storage?: { freeBytes: number };
  },
): RemoteRuntimeConnectionStatus {
  const status: RemoteRuntimeConnectionStatus = {
    target: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      hostname: `${overrides.id}.local`,
      sshUser: null,
      port: null,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    },
    state: overrides.state ?? "connected",
    arch: "arm64",
    version: overrides.version ?? "1.2.37",
    projects: overrides.projects ?? [],
    lastError: null,
    lastAttemptedAt: null,
    connectedAt: 1,
  };
  return overrides.storage
    ? ({ ...status, storage: overrides.storage } as RemoteRuntimeConnectionStatus)
    : status;
}

beforeEach(() => {
  resetGitRemoteIdentityCache();
});

describe("deriveLaneMachineOptions", () => {
  it("lists this computer alone when nothing else is connected", () => {
    const options = deriveLaneMachineOptions({ connections: [], boundTargetId: null });

    expect(options).toHaveLength(1);
    expect(options[0]?.id).toBe(THIS_MACHINE_ID);
    expect(options[0]?.name).toBe("This computer");
    expect(options[0]?.isBound).toBe(true);
  });

  it("omits machines that are not connected right now", () => {
    const options = deriveLaneMachineOptions({
      connections: [
        connection({ id: "studio", state: "connected" }),
        connection({ id: "mini", state: "connecting" }),
        connection({ id: "air", state: "error" }),
        connection({ id: "idle-box", state: "idle" }),
      ],
      boundTargetId: null,
    });

    expect(options.map((option) => option.id)).toEqual([THIS_MACHINE_ID, "studio"]);
  });

  it("matches the repo across remote URL formats", () => {
    const options = deriveLaneMachineOptions({
      connections: [
        connection({
          id: "studio",
          projects: [
            project({ projectId: "other", gitOriginUrl: "https://github.com/acme/other.git" }),
            project({
              projectId: "ade",
              rootPath: "/Users/x/code/ADE",
              displayName: "ADE",
              gitOriginUrl: "git@github.com:Acme/ADE.git",
            }),
          ],
        }),
      ],
      boundTargetId: null,
      repoOriginUrl: "https://github.com/acme/ade",
    });

    const studio = options.find((option) => option.id === "studio");
    expect(studio?.repoMatch).toBe("matched");
    expect(studio?.project?.rootPath).toBe("/Users/x/code/ADE");
    expect(canCreateLaneOnMachine(studio!)).toBe(true);
  });

  it("marks a connected machine without the repo as unavailable", () => {
    const options = deriveLaneMachineOptions({
      connections: [
        connection({
          id: "studio",
          projects: [project({ projectId: "other", gitOriginUrl: "https://github.com/acme/other" })],
        }),
      ],
      boundTargetId: null,
      repoOriginUrl: "https://github.com/acme/ade",
      repoDisplayName: "ADE",
    });

    const studio = options.find((option) => option.id === "studio");
    expect(studio?.repoMatch).toBe("missing");
    expect(canCreateLaneOnMachine(studio!)).toBe(false);
  });

  it("keeps a machine selectable when the repo identity is unknown", () => {
    const options = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: null,
    });

    const studio = options.find((option) => option.id === "studio");
    expect(studio?.repoMatch).toBe("unknown");
    expect(canCreateLaneOnMachine(studio!)).toBe(true);
  });

  it("treats the bound machine as the default and as holding the repo", () => {
    const options = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      boundProject: { projectId: "ade", rootPath: "/Users/x/ADE", displayName: "ADE", matchedBy: "origin" },
    });

    const studio = options.find((option) => option.id === "studio");
    expect(studio?.isBound).toBe(true);
    expect(studio?.repoMatch).toBe("matched");
    expect(studio?.project?.rootPath).toBe("/Users/x/ADE");
    expect(defaultLaneMachineId(options)).toBe("studio");
    // This computer is no longer the bound machine, and nothing proves the repo is here.
    expect(options[0]?.repoMatch).toBe("unknown");
  });

  it("resolves this computer's checkout from open local project tabs", () => {
    const options = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      boundProject: { projectId: "ade", rootPath: "/Users/x/remote/ADE", displayName: "ADE", matchedBy: "origin" },
      repoDisplayName: "ADE",
      localProjectRoots: ["/Users/x/code/notes", "/Users/x/code/ADE"],
    });

    // The folder name lined up, which is a useful hint and worth surfacing as a
    // candidate — but a name is not an identity, so it must not read as proven.
    // Two unrelated repos both called "ADE" would look identical here, and
    // selecting the machine rebinds the whole app tab to that checkout.
    expect(options[0]?.repoMatch).toBe("unknown");
    expect(options[0]?.project?.rootPath).toBe("/Users/x/code/ADE");
    expect(options[0]?.project?.matchedBy).toBe("name");
  });

  it("resolves an unopened local recent by git origin", () => {
    const options = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      boundProject: {
        projectId: "ade",
        rootPath: "/Users/studio/ADE",
        displayName: "ADE",
        matchedBy: "origin",
      },
      repoOriginUrl: "git@github.com:acme/ADE.git",
      repoDisplayName: "ADE",
      localProjects: [{
        rootPath: "/Users/me/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T12:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "https://github.com/acme/ade",
      }],
    });

    expect(options[0]?.repoMatch).toBe("matched");
    expect(options[0]?.project).toEqual({
      projectId: null,
      rootPath: "/Users/me/ADE",
      displayName: "ADE",
      matchedBy: "origin",
    });
  });

  it("does not fall back to a same-named local root when the origin catalog disproves it", () => {
    const options = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      boundProject: {
        projectId: "ade",
        rootPath: "/Users/studio/ADE",
        displayName: "ADE",
        matchedBy: "origin",
      },
      repoOriginUrl: "git@github.com:acme/ADE.git",
      repoDisplayName: "ADE",
      localProjectRoots: ["/Users/me/ADE"],
      localProjects: [{
        rootPath: "/Users/me/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T12:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "git@github.com:other/ADE.git",
      }],
    });

    expect(options[0]?.project).toBeNull();
    expect(options[0]?.repoMatch).toBe("missing");
  });

  it("does not offer a same-named checkout whose origin proves it is a different repo", () => {
    const options = deriveLaneMachineOptions({
      connections: [
        connection({
          id: "studio",
          projects: [
            project({
              projectId: "other-api",
              rootPath: "/Users/x/src/api",
              displayName: "api",
              gitOriginUrl: "git@github.com:other/api.git",
            }),
          ],
        }),
      ],
      boundTargetId: null,
      repoOriginUrl: "git@github.com:acme/api.git",
      repoDisplayName: "api",
    });

    const studio = options.find((option) => option.id === "studio");
    // Same folder name, different origin — that is proof they are NOT the same
    // repository, so the machine must not present a checkout to rebind to.
    expect(studio?.project).toBeNull();
    expect(studio?.repoMatch).not.toBe("matched");
  });

  it("says the repo is missing from this computer only when the local tabs are known", () => {
    const withTabs = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      repoDisplayName: "ADE",
      localProjectRoots: ["/Users/x/code/notes"],
    });
    expect(withTabs[0]?.repoMatch).toBe("missing");

    const withoutTabs = deriveLaneMachineOptions({
      connections: [connection({ id: "studio" })],
      boundTargetId: "studio",
      repoDisplayName: "ADE",
    });
    expect(withoutTabs[0]?.repoMatch).toBe("unknown");
  });

  it("reports free disk headroom only when the snapshot carries it", () => {
    const options = deriveLaneMachineOptions({
      connections: [
        connection({ id: "studio", storage: { freeBytes: 412 * 1024 ** 3 } }),
        connection({ id: "mini" }),
      ],
      boundTargetId: null,
    });

    expect(options.find((option) => option.id === "studio")?.freeBytes).toBe(412 * 1024 ** 3);
    expect(options.find((option) => option.id === "mini")?.freeBytes).toBeNull();
    expect(options[0]?.freeBytes).toBeNull();
  });
});

describe("cachedGitRemoteIdentity", () => {
  it("normalizes scp-style and https remotes to the same identity", () => {
    expect(cachedGitRemoteIdentity("git@github.com:Acme/ADE.git")).toBe("github.com/acme/ade");
    expect(cachedGitRemoteIdentity("https://github.com/acme/ade")).toBe("github.com/acme/ade");
  });

  it("returns null for empty input without caching noise", () => {
    expect(cachedGitRemoteIdentity(null)).toBeNull();
    expect(cachedGitRemoteIdentity("   ")).toBeNull();
  });

  it("returns a stable value for a repeated URL", () => {
    const first = cachedGitRemoteIdentity("git@github.com:acme/ade.git");
    const second = cachedGitRemoteIdentity("git@github.com:acme/ade.git");
    expect(second).toBe(first);
  });
});

describe("isLowLaneMachineDisk", () => {
  it("warns at or below the disk-pressure warning threshold", () => {
    expect(isLowLaneMachineDisk(null)).toBe(false);
    expect(isLowLaneMachineDisk(412 * 1024 ** 3)).toBe(false);
    expect(isLowLaneMachineDisk(12 * 1024 ** 3)).toBe(true);
    expect(isLowLaneMachineDisk(3 * 1024 ** 3)).toBe(true);
  });
});
