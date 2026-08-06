import { describe, expect, it, vi } from "vitest";

import type { AppNavigationRequest, AppNavigationTarget } from "../../../shared/types";
import { describeAttentionOpenFailure } from "../attention/attentionOpenErrors";
import { matchRemoteProjectByRootPath } from "../attention/remoteProjectIdentity";
import {
  appNavigationOwnership,
  dispatchOwnerAwareNavigation,
  ownerNavigationFailureCopy,
} from "./ownerAwareNavigation";

/** A canonical, machine-independent project id — what links carry today. */
const CANONICAL_ID = "project_9f2c1b7a4e";
/** The publishing machine's private `ade.db` uuid — what old links carry. */
const LEGACY_UUID = "0b3d2f61-9a44-4a1c-9c65-6a4e0a3f9a11";
const PROJECT_ROOT = "/Users/arul/Projects/ADE";

function ownedRequest(
  accountMachineKey = "machine-b",
  projectRoot?: string,
  projectId = "project-1",
): AppNavigationRequest {
  return {
    source: "deeplink:open-url",
    target: {
      kind: "work",
      sessionId: "session-1",
      ownership: {
        accountMachineKey,
        projectId,
        ...(projectRoot ? { projectRoot } : {}),
      },
    },
  };
}

function ownerNavigationDependencies() {
  return {
    getLocalMachineKey: vi.fn(() => "machine-a"),
    resolveLocalProjectRoot: vi.fn(
      (_projectId: string, _projectRoot: string | null): string | null => "/projects/one",
    ),
    deliverLocal: vi.fn(async () => undefined),
    findRemote: vi.fn((): unknown | null => null),
    openRemote: vi.fn(async (
      _machineKey: string,
      _projectId: string,
      _projectRoot: string | null,
    ) => ({ windowId: 2 })),
    deliverRemote: vi.fn(async () => undefined),
  };
}

describe("appNavigationOwnership", () => {
  it("reads ownership off the target kinds that can be machine-scoped", () => {
    for (const kind of ["work", "chat"] as const) {
      expect(appNavigationOwnership({
        kind,
        sessionId: "session-1",
        ownership: { accountMachineKey: "machine-b", projectId: CANONICAL_ID },
      })).toEqual({ accountMachineKey: "machine-b", projectId: CANONICAL_ID });
    }
    expect(appNavigationOwnership({
      kind: "pr",
      prNumber: 42,
      ownership: { accountMachineKey: "machine-b", projectId: CANONICAL_ID },
    })).toEqual({ accountMachineKey: "machine-b", projectId: CANONICAL_ID });
  });

  it("carries the deeplink's project root when a legacy link minted one", () => {
    expect(appNavigationOwnership({
      kind: "work",
      sessionId: "session-1",
      ownership: {
        accountMachineKey: "machine-b",
        projectId: CANONICAL_ID,
        projectRoot: `  ${PROJECT_ROOT}  `,
      },
    })).toEqual({
      accountMachineKey: "machine-b",
      projectId: CANONICAL_ID,
      projectRoot: PROJECT_ROOT,
    });
  });

  it("omits a blank or non-string project root instead of forwarding junk", () => {
    // The parser only ever produces a non-empty string, but ownership also
    // arrives over IPC, where the field is whatever the sender put there.
    for (const projectRoot of ["", "   ", 42, null]) {
      const target = {
        kind: "work",
        sessionId: "session-1",
        ownership: {
          accountMachineKey: "machine-b",
          projectId: CANONICAL_ID,
          projectRoot,
        },
      } as unknown as AppNavigationTarget;
      expect(appNavigationOwnership(target))
        .toEqual({ accountMachineKey: "machine-b", projectId: CANONICAL_ID });
    }
  });

  it("returns null for target kinds that are never machine-scoped", () => {
    const targets: AppNavigationTarget[] = [
      { kind: "lane", laneId: "lane-1" },
      { kind: "file", path: "src/app.ts" },
      { kind: "commit", sha: "abc1234" },
      { kind: "artifact", artifactId: "artifact-1" },
      { kind: "branch", repoOwner: "a", repoName: "b", branch: "feat" },
      { kind: "settings", tab: "connections" },
      { kind: "route", route: "/work" },
    ];
    for (const target of targets) expect(appNavigationOwnership(target)).toBeNull();
  });

  it("returns null when either half of the identity is missing", () => {
    expect(appNavigationOwnership({ kind: "work", sessionId: "s" })).toBeNull();
    expect(appNavigationOwnership({ kind: "work", sessionId: "s", ownership: null })).toBeNull();
    expect(appNavigationOwnership({
      kind: "work",
      sessionId: "s",
      ownership: { accountMachineKey: "   ", projectId: CANONICAL_ID },
    })).toBeNull();
    expect(appNavigationOwnership({
      kind: "work",
      sessionId: "s",
      ownership: { accountMachineKey: "machine-b", projectId: "   " },
    })).toBeNull();
  });
});

describe("dispatchOwnerAwareNavigation", () => {
  it("routes a local owner to its exact project instead of the focused window", async () => {
    const deps = ownerNavigationDependencies();
    await expect(dispatchOwnerAwareNavigation(ownedRequest("machine-a"), deps))
      .resolves.toBe(true);
    expect(deps.resolveLocalProjectRoot).toHaveBeenCalledWith("project-1", null);
    expect(deps.deliverLocal).toHaveBeenCalledWith(
      "/projects/one",
      ownedRequest("machine-a"),
    );
    expect(deps.openRemote).not.toHaveBeenCalled();
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });

  it("treats the local machine key as local even when it arrives padded", async () => {
    const deps = ownerNavigationDependencies();
    deps.getLocalMachineKey.mockReturnValue("  machine-a  ");
    await dispatchOwnerAwareNavigation(ownedRequest("machine-a"), deps);
    expect(deps.deliverLocal).toHaveBeenCalled();
    expect(deps.findRemote).not.toHaveBeenCalled();
  });

  it("does not mistake an unknown local identity for a match", async () => {
    // The attention bridge answers "" before it is ready; every deeplink would
    // otherwise be treated as local and resolved against the wrong catalog.
    const deps = ownerNavigationDependencies();
    deps.getLocalMachineKey.mockReturnValue("");
    await dispatchOwnerAwareNavigation(ownedRequest("machine-b"), deps);
    expect(deps.deliverLocal).not.toHaveBeenCalled();
    expect(deps.findRemote).toHaveBeenCalled();
  });

  it("reuses a window already showing the remote project before opening one", async () => {
    const deps = ownerNavigationDependencies();
    const existing = { windowId: 7 };
    deps.findRemote.mockReturnValueOnce(existing);
    await expect(dispatchOwnerAwareNavigation(ownedRequest(), deps)).resolves.toBe(true);
    expect(deps.deliverRemote).toHaveBeenCalledWith(existing, ownedRequest());
    expect(deps.openRemote).not.toHaveBeenCalled();
  });

  it("opens the owning machine and project when no window is showing it", async () => {
    const deps = ownerNavigationDependencies();
    deps.findRemote.mockReturnValueOnce(null);
    await dispatchOwnerAwareNavigation(ownedRequest(), deps);
    expect(deps.openRemote).toHaveBeenCalledWith("machine-b", "project-1", null);
    expect(deps.deliverRemote).toHaveBeenCalledWith({ windowId: 2 }, ownedRequest());
  });

  it("threads the deeplink's project root to every resolver", async () => {
    // The project id in a deeplink means nothing on a machine that did not mint
    // it, so the root path has to reach the resolvers or the open fails.
    const deps = ownerNavigationDependencies();
    await dispatchOwnerAwareNavigation(ownedRequest("machine-b", PROJECT_ROOT), deps);
    expect(deps.findRemote).toHaveBeenCalledWith("machine-b", "project-1", PROJECT_ROOT);
    expect(deps.openRemote).toHaveBeenCalledWith("machine-b", "project-1", PROJECT_ROOT);

    const localDeps = ownerNavigationDependencies();
    await dispatchOwnerAwareNavigation(
      ownedRequest("machine-a", PROJECT_ROOT),
      localDeps,
    );
    expect(localDeps.resolveLocalProjectRoot)
      .toHaveBeenCalledWith("project-1", PROJECT_ROOT);
  });

  it("does not intercept ordinary machine-unscoped navigation", async () => {
    const deps = ownerNavigationDependencies();
    await expect(dispatchOwnerAwareNavigation({
      source: "deeplink:open-url",
      target: { kind: "pr", repoOwner: "openai", repoName: "ade", prNumber: 42 },
    }, deps)).resolves.toBe(false);
    expect(deps.getLocalMachineKey).not.toHaveBeenCalled();
    expect(deps.deliverLocal).not.toHaveBeenCalled();
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });

  it("fails closed when the exact owning local project is unavailable", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockReturnValue(null);
    await expect(dispatchOwnerAwareNavigation(ownedRequest("machine-a"), deps))
      .rejects.toThrow("Project project-1 is no longer available on this ADE machine.");
    expect(deps.deliverLocal).not.toHaveBeenCalled();
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });

  it("surfaces an open failure instead of silently falling through", async () => {
    // Returning `false` here would drop the navigation into the focused-window
    // fallback and rebind the user's window to nothing useful.
    const deps = ownerNavigationDependencies();
    deps.openRemote.mockRejectedValueOnce(
      describeAttentionOpenFailure(new Error("ECONNREFUSED"), "connect", "Studio Mac"),
    );
    await expect(dispatchOwnerAwareNavigation(ownedRequest(), deps))
      .rejects.toThrow("Studio Mac is not reachable right now.");
    expect(deps.deliverRemote).not.toHaveBeenCalled();
  });
});

/**
 * The three id spaces a click-through crosses. A link minted today carries the
 * machine-independent `project_<hash>`; an older one carries the publishing
 * machine's private uuid, which no other runtime can look up; and the root path
 * is the only identity every producer agrees on. `dispatchOwnerAwareNavigation`
 * hands its resolvers both halves so all three strategies stay reachable.
 */
describe("cross-machine project resolution", () => {
  const catalog = [
    { projectId: CANONICAL_ID, rootPath: PROJECT_ROOT },
    { projectId: "project_11223344", rootPath: "/Users/arul/Projects/Other" },
  ];

  /** The documented order: registry id → root path → legacy uuid. */
  const resolve = (
    projectId: string,
    projectRoot: string | null,
    legacyUuids: Record<string, string> = {},
  ): string | null =>
    catalog.find((entry) => entry.projectId === projectId)?.rootPath
    ?? matchRemoteProjectByRootPath(catalog, projectRoot)?.rootPath
    ?? catalog.find((entry) => entry.rootPath === legacyUuids[projectId])?.rootPath
    ?? null;

  it("resolves a canonical id directly", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockImplementation(resolve);
    await dispatchOwnerAwareNavigation(
      ownedRequest("machine-a", undefined, CANONICAL_ID),
      deps,
    );
    expect(deps.deliverLocal).toHaveBeenCalledWith(PROJECT_ROOT, expect.anything());
  });

  it("falls back to the root path when the id matches nothing", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockImplementation(resolve);
    await dispatchOwnerAwareNavigation(
      // A pre-canonical link: the uuid resolves nowhere, the root still does.
      ownedRequest("machine-a", PROJECT_ROOT, LEGACY_UUID),
      deps,
    );
    expect(deps.deliverLocal).toHaveBeenCalledWith(PROJECT_ROOT, expect.anything());
  });

  it("falls back to a legacy uuid mapping when there is no root path either", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockImplementation((projectId, projectRoot) =>
      resolve(projectId, projectRoot, { [LEGACY_UUID]: PROJECT_ROOT }));
    await dispatchOwnerAwareNavigation(
      ownedRequest("machine-a", undefined, LEGACY_UUID),
      deps,
    );
    expect(deps.deliverLocal).toHaveBeenCalledWith(PROJECT_ROOT, expect.anything());
  });

  it("refuses an id and root that both resolve nowhere", async () => {
    const deps = ownerNavigationDependencies();
    deps.resolveLocalProjectRoot.mockImplementation(resolve);
    await expect(dispatchOwnerAwareNavigation(
      ownedRequest("machine-a", "/Users/arul/Projects/Deleted", LEGACY_UUID),
      deps,
    )).rejects.toThrow("is no longer available on this ADE machine");
  });

  it("matches an owning machine's Windows and UNC roots regardless of this host", () => {
    // The root belongs to the REMOTE machine, so the comparison rules come from
    // the path's own shape rather than `process.platform`.
    const windowsCatalog = [
      { projectId: "project_win", rootPath: "C:\\Users\\arul\\Projects\\ADE" },
      { projectId: "project_unc", rootPath: "\\\\build-01\\share\\ADE" },
    ];
    expect(matchRemoteProjectByRootPath(windowsCatalog, "c:/users/arul/projects/ade"))
      .toMatchObject({ projectId: "project_win" });
    expect(matchRemoteProjectByRootPath(windowsCatalog, "C:\\Users\\arul\\Projects\\ADE\\"))
      .toMatchObject({ projectId: "project_win" });
    expect(matchRemoteProjectByRootPath(windowsCatalog, "\\\\build-01\\share\\ADE\\"))
      .toMatchObject({ projectId: "project_unc" });
    // A POSIX spelling of the same tail is a different machine's project.
    expect(matchRemoteProjectByRootPath(windowsCatalog, "/Users/arul/Projects/ADE")).toBeNull();
  });

  it("refuses to guess between sibling repos that differ only by case", () => {
    const ambiguous = [
      { projectId: "project_upper", rootPath: "/srv/ADE" },
      { projectId: "project_lower", rootPath: "/srv/ade" },
    ];
    expect(matchRemoteProjectByRootPath(ambiguous, "/srv/AdE")).toBeNull();
    // An exact spelling is still unambiguous and wins outright.
    expect(matchRemoteProjectByRootPath(ambiguous, "/srv/ADE"))
      .toMatchObject({ projectId: "project_upper" });
  });
});

describe("ownerNavigationFailureCopy", () => {
  it.each([
    {
      error: "Remote ADE service 1.2.41 does not support machine projects.",
      title: "Update the owning ADE machine",
      recovery: "Update and restart ADE on that host",
    },
    {
      error: "Connection timed out.",
      title: "Owning machine unavailable",
      recovery: "Reconnect that machine from Connections",
    },
    {
      error: "Project project-1 is no longer available on this ADE machine.",
      title: "Project no longer available",
      recovery: "Open or restore the project on that machine",
    },
  ])("provides actionable recovery copy for $title", ({ error, title, recovery }) => {
    const copy = ownerNavigationFailureCopy(new Error(error));
    expect(copy.title).toBe(title);
    expect(copy.message).not.toBe("");
    expect(copy.detail).toContain(error);
    expect(copy.detail).toContain(recovery);
  });

  it("passes an unreachable machine through as plain language, not an RPC string", () => {
    // End to end: the open path wraps the raw failure, and this dialog copy must
    // not undo that by re-surfacing the transport error.
    const copy = ownerNavigationFailureCopy(describeAttentionOpenFailure(
      new Error("connect ECONNREFUSED 127.0.0.1:52401"),
      "connect",
      "Studio Mac",
    ));
    expect(copy.title).toBe("Owning machine unavailable");
    expect(copy.detail).toContain("Studio Mac is not reachable right now.");
    expect(copy.detail).not.toContain("ECONNREFUSED");
  });

  it("falls back to a usable sentence for an empty or non-Error failure", () => {
    for (const error of [undefined, new Error("   "), "boom"]) {
      const copy = ownerNavigationFailureCopy(error);
      expect(copy.title).toBe("Owning machine unavailable");
      expect(copy.detail.trim()).not.toBe("");
    }
    expect(ownerNavigationFailureCopy(new Error("")).detail)
      .toContain("The owning ADE machine did not accept the destination.");
  });
});
