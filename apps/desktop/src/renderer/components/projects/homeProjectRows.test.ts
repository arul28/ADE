import { describe, expect, it } from "vitest";
import type { AccountProjectView } from "../../../shared/accountProject";
import type { RecentProjectSummary } from "../../../shared/types";
import { buildHomeProjectList } from "./homeProjectRows";

const THIS_MACHINE = "machine-this";

const appProject: AccountProjectView = {
  id: "ap_app",
  host: "github.com",
  repoId: null,
  repoKey: "repo:github.com/acme/app",
  owner: "acme",
  name: "app",
  defaultBranch: "main",
  addedAt: 1_700_000_000_000,
  removedAt: null,
  mergedInto: null,
  aliases: ["repo:github.com/acme/app"],
  copies: [{
    projectId: "ap_app",
    machineKey: THIS_MACHINE,
    checkoutId: "project_app",
    rootPath: "/Users/me/code/app",
    isMain: true,
    lastSeenAt: 1_700_000_000_000,
  }],
};

function folder(rootPath: string, gitOriginUrl: string | null): RecentProjectSummary {
  return {
    rootPath,
    displayName: rootPath.split("/").pop() ?? rootPath,
    lastOpenedAt: "2026-11-01T00:00:00.000Z",
    exists: true,
    gitOriginUrl,
  } as RecentProjectSummary;
}

describe("buildHomeProjectList", () => {
  it.each([
    ["its origin matches the account project", folder("/Users/me/elsewhere/app", "https://github.com/acme/app.git"), "account"],
    ["its origin is not known yet and the account lists its path", folder("/Users/me/code/app", null), "account"],
    ["it holds another repository now at the path the account lists", folder("/Users/me/code/app", "https://github.com/acme/other.git"), "local"],
  ] as const)("a folder on this computer whose %s goes to the %s row", (_label, recent, expected) => {
    const list = buildHomeProjectList({
      projects: [appProject],
      sources: { connections: [], thisMachine: { machineKey: THIS_MACHINE, localProjects: [recent] } },
      recents: [recent],
      remoteSnapshot: null,
      webMode: false,
      hidden: new Map(),
      foreignPaths: new Set(),
      thisMachineName: "This Mac",
      rememberedIcons: new Map(),
    });
    const joined = list.accountRows[0]!.group.recentKeys.length > 0;
    const localPaths = list.localGroups.flatMap((group) => group.rows.map((row) => row.rp.rootPath));
    expect(list.accountRows.map((row) => row.key)).toEqual(["ap_app"]);
    expect({ joined, localPaths }).toEqual(
      expected === "account"
        ? { joined: true, localPaths: [] }
        : { joined: false, localPaths: [recent.rootPath] },
    );
  });
});
