import { describe, expect, it, vi } from "vitest";
import { createDevinCloudFleetService } from "./devinCloudFleetService";
import type { DevinCloudSessionSummary } from "../../../shared/types/config";

const mockGit = vi.hoisted(() => ({ runGit: vi.fn() }));
vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Parameters<typeof createDevinCloudFleetService>[0]["logger"];

function session(overrides: Partial<DevinCloudSessionSummary> & { sessionId: string }): DevinCloudSessionSummary {
  return {
    title: `Session ${overrides.sessionId}`,
    status: "running",
    statusDetail: "working",
    isArchived: false,
    url: `https://app.devin.ai/sessions/${overrides.sessionId}`,
    pullRequests: [],
    tags: [],
    repos: [],
    createdAt: null,
    updatedAt: null,
    devinMode: null,
    acusConsumed: null,
    userId: null,
    parentSessionId: null,
    origin: null,
    ...overrides,
  };
}

function buildHarness(opts: {
  sessions: DevinCloudSessionSummary[];
  callerUserId?: string | null;
  withCallerDep?: boolean;
  personalScope?: boolean;
}) {
  const service = createDevinCloudFleetService({
    projectRoot: "/repo",
    logger,
    listDevinCloudSessions: async () => ({ items: opts.sessions, endCursor: null }),
    ...(opts.withCallerDep === false
      ? {}
      : {
          getDevinCloudCallerUserId: async () => opts.callerUserId ?? null,
        }),
    ...(opts.personalScope ? { callerIsListingOwner: () => true } : {}),
    laneService: {
      list: async () => [],
      importBranch: async () => { throw new Error("not used"); },
    },
    listDevinCloudSessionLinks: async () => [],
    openDevinCloudChat: async () => { throw new Error("not used"); },
  });
  return service;
}

describe("devinCloudFleetService isMine", () => {
  it("marks sessions whose userId matches the credential principal", async () => {
    const service = buildHarness({
      callerUserId: "user-abc",
      sessions: [
        session({ sessionId: "s-mine", userId: "user-abc" }),
        session({ sessionId: "s-theirs", userId: "user-xyz" }),
        session({ sessionId: "s-nouser", userId: null }),
      ],
    });
    const fleet = await service.getFleet({ force: true });
    const byId = new Map(fleet.items.map((e) => [e.session.sessionId, e]));
    expect(byId.get("s-mine")?.isMine).toBe(true);
    expect(byId.get("s-theirs")?.isMine).toBe(false);
    expect(byId.get("s-nouser")?.isMine).toBe(false);
  });

  it("reports isMine false when identity and listing scope are both unknown", async () => {
    const service = buildHarness({
      callerUserId: null,
      sessions: [session({ sessionId: "s1", userId: "user-abc" })],
    });
    const fleet = await service.getFleet({ force: true });
    expect(fleet.items[0]?.isMine).toBe(false);
  });

  it("marks every session Mine on a v1 personal-key (owner-scoped) listing", async () => {
    const service = buildHarness({
      callerUserId: null,
      personalScope: true,
      sessions: [
        session({ sessionId: "s1", userId: "user-abc" }),
        session({ sessionId: "s2", userId: null }),
      ],
    });
    const fleet = await service.getFleet({ force: true });
    expect(fleet.items.every((e) => e.isMine)).toBe(true);
  });
});
