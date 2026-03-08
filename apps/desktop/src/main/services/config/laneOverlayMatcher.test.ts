import { describe, expect, it } from "vitest";
import { matchLaneOverlayPolicies } from "./laneOverlayMatcher";
import type { LaneOverlayPolicy, LaneSummary } from "../../../shared/types";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature-auth",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/auth",
    worktreePath: "/tmp/worktree/feature-auth",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides
  };
}

describe("matchLaneOverlayPolicies", () => {
  it("returns empty overrides when no policies match", () => {
    const lane = makeLane();
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Other lanes",
        enabled: true,
        match: { namePattern: "bugfix/*" },
        overrides: { env: { DEBUG: "true" } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result).toEqual({});
  });

  it("matches by lane name pattern", () => {
    const lane = makeLane({ name: "feature-auth" });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Features",
        enabled: true,
        match: { namePattern: "feature*" },
        overrides: { env: { NODE_ENV: "development" } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.env).toEqual({ NODE_ENV: "development" });
  });

  it("matches by lane type", () => {
    const lane = makeLane({ laneType: "worktree" });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Worktrees",
        enabled: true,
        match: { laneTypes: ["worktree"] },
        overrides: { env: { IS_WORKTREE: "1" } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.env).toEqual({ IS_WORKTREE: "1" });
  });

  it("merges env vars from multiple matching policies", () => {
    const lane = makeLane({ name: "feature-auth", tags: ["backend"] });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Features",
        enabled: true,
        match: { namePattern: "feature*" },
        overrides: { env: { NODE_ENV: "development", PORT: "3000" } }
      },
      {
        id: "p2",
        name: "Backend",
        enabled: true,
        match: { tags: ["backend"] },
        overrides: { env: { PORT: "4000", DB_HOST: "localhost" } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.env).toEqual({ NODE_ENV: "development", PORT: "4000", DB_HOST: "localhost" });
  });

  it("skips disabled policies", () => {
    const lane = makeLane();
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Disabled",
        enabled: false,
        match: {},
        overrides: { env: { SHOULD_NOT: "appear" } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result).toEqual({});
  });

  // --- New Phase 5 W1 overlay fields ---

  it("merges portRange (last wins)", () => {
    const lane = makeLane({ name: "feature-auth" });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Default ports",
        enabled: true,
        match: {},
        overrides: { portRange: { start: 3000, end: 3099 } }
      },
      {
        id: "p2",
        name: "Feature ports",
        enabled: true,
        match: { namePattern: "feature*" },
        overrides: { portRange: { start: 4000, end: 4099 } }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.portRange).toEqual({ start: 4000, end: 4099 });
  });

  it("merges proxyHostname (last wins)", () => {
    const lane = makeLane({ name: "feature-auth" });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Default proxy",
        enabled: true,
        match: {},
        overrides: { proxyHostname: "default.localhost" }
      },
      {
        id: "p2",
        name: "Feature proxy",
        enabled: true,
        match: { namePattern: "feature*" },
        overrides: { proxyHostname: "feature-auth.localhost" }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.proxyHostname).toBe("feature-auth.localhost");
  });

  it("merges computeBackend (last wins)", () => {
    const lane = makeLane();
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "VPS",
        enabled: true,
        match: {},
        overrides: { computeBackend: "vps" }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.computeBackend).toBe("vps");
  });

  it("deep merges envInit configs", () => {
    const lane = makeLane({ name: "feature-auth", tags: ["backend"] });
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "Base init",
        enabled: true,
        match: {},
        overrides: {
          envInit: {
            envFiles: [{ source: ".env.template", dest: ".env" }],
            dependencies: [{ command: ["npm", "install"] }]
          }
        }
      },
      {
        id: "p2",
        name: "Backend init",
        enabled: true,
        match: { tags: ["backend"] },
        overrides: {
          envInit: {
            envFiles: [{ source: ".env.backend", dest: ".env.local" }],
            docker: { composePath: "docker-compose.yml" },
            dependencies: [{ command: ["pip", "install", "-r", "requirements.txt"] }]
          }
        }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.envInit).toBeDefined();
    expect(result.envInit!.envFiles).toHaveLength(2);
    expect(result.envInit!.envFiles![0].source).toBe(".env.template");
    expect(result.envInit!.envFiles![1].source).toBe(".env.backend");
    expect(result.envInit!.docker).toEqual({ composePath: "docker-compose.yml" });
    expect(result.envInit!.dependencies).toHaveLength(2);
  });

  it("handles envInit when only second policy has it", () => {
    const lane = makeLane();
    const policies: LaneOverlayPolicy[] = [
      {
        id: "p1",
        name: "No init",
        enabled: true,
        match: {},
        overrides: { env: { FOO: "bar" } }
      },
      {
        id: "p2",
        name: "With init",
        enabled: true,
        match: {},
        overrides: {
          envInit: {
            dependencies: [{ command: ["npm", "install"] }]
          }
        }
      }
    ];
    const result = matchLaneOverlayPolicies(lane, policies);
    expect(result.envInit).toBeDefined();
    expect(result.envInit!.dependencies).toHaveLength(1);
  });
});
