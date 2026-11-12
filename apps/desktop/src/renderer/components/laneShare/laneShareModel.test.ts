import { describe, expect, it } from "vitest";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { agentSharesToNotice } from "./laneShareModel";

const LAST_READ = 1_800_000_000_000;

function share(patch: Partial<LaneShareGivenEntry>): LaneShareGivenEntry {
  return {
    grantId: "grant-1",
    laneId: "lane-1",
    receiverEmail: "pat@example.com",
    state: "pending",
    endsAt: null,
    createdAt: LAST_READ + 1_000,
    acceptedAt: null,
    inviteExpiresAt: null,
    link: null,
    repoKey: null,
    projectLabel: null,
    laneLabel: "login",
    preset: null,
    directoryRisk: null,
    machineKey: null,
    local: true,
    rights: null,
    needsRights: false,
    risk: null,
    usage: null,
    connectedDevices: 0,
    laneState: "active",
    createdBy: "agent",
    ...patch,
  } as LaneShareGivenEntry;
}

describe("agentSharesToNotice", () => {
  // The owner's "An agent shared the lane" notice: once per share, only for
  // a live share an agent made on that machine after the list was last read,
  // or in the last day when this computer reads that list for the first time.
  it.each<[string, Partial<LaneShareGivenEntry>, { seen?: string[]; lastListAt?: number | null }, boolean]>([
    ["a new pending share an agent made", {}, {}, true],
    ["a new active share an agent made", { state: "active" }, {}, true],
    ["a share a person made", { createdBy: "person" }, {}, false],
    ["a share with no maker record (another machine's row)", { createdBy: null, local: false }, {}, false],
    ["a share already noticed on this computer", {}, { seen: ["grant-1"] }, false],
    ["a share that ended", { state: "revoked" }, {}, false],
    ["a share made long before the last read", { createdAt: LAST_READ - 60 * 60_000 }, {}, false],
    ["a recent share on the first read of the list", {}, { lastListAt: null }, true],
    ["a share over a day old on the first read of the list", { createdAt: LAST_READ - 25 * 60 * 60_000 }, { lastListAt: null }, false],
  ])("%s", (_label, patch, seen, shown) => {
    const result = agentSharesToNotice([share(patch)], {
      grantIds: new Set(seen.seen ?? []),
      lastListAt: seen.lastListAt === undefined ? LAST_READ : seen.lastListAt,
    }, LAST_READ + 2_000);
    expect(result.map((entry) => entry.grantId)).toEqual(shown ? ["grant-1"] : []);
  });
});
