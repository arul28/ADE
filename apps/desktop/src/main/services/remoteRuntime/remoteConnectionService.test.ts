import { describe, expect, it, vi } from "vitest";
import type {
  RemoteRuntimeConnectResult,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import type { RemoteConnectionPool } from "./remoteConnectionPool";
import { RemoteConnectionService } from "./remoteConnectionService";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

function target(
  id: string,
  lastConnectedAt: number | null,
): RemoteRuntimeTarget {
  return {
    id,
    name: id,
    hostname: `${id}.example.test`,
    sshUser: "ade",
    port: 22,
    sshKeyPath: null,
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt,
  };
}

function connectResult(target: RemoteRuntimeTarget): RemoteRuntimeConnectResult {
  return {
    target,
    arch: "darwin-arm64",
    version: "1.0.0",
    projects: [],
    capabilities: {
      projects: true,
      machineProjects: {
        browseDirectories: true,
        getDetail: true,
        getWorkSummary: true,
        getDefaultParentDir: true,
        create: true,
        clone: true,
        listMyGitHubRepos: true,
      },
    },
  };
}

describe("RemoteConnectionService", () => {
  it("only autoconnects targets that have connected successfully before", async () => {
    const neverConnected = target("never-connected", null);
    const previouslyConnected = target("previously-connected", 1_700_000_000);
    const registry = {
      list: vi.fn(() => [neverConnected, previouslyConnected]),
      get: vi.fn((id: string) =>
        id === neverConnected.id
          ? neverConnected
          : id === previouslyConnected.id
            ? previouslyConnected
            : null,
      ),
    } as unknown as RemoteTargetRegistry;
    const pool = {
      connect: vi.fn(async (target: RemoteRuntimeTarget) => connectResult(target)),
      disconnect: vi.fn(),
      onEntryEvicted: vi.fn(() => () => {}),
    } as unknown as RemoteConnectionPool;

    const service = new RemoteConnectionService(registry, pool);
    service.startAutoconnect();
    await Promise.resolve();
    service.stopAutoconnect();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.connect).toHaveBeenCalledWith(previouslyConnected);
  });
});
