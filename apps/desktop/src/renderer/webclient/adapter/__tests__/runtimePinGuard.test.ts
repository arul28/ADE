import { describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AdeSyncClient } from "../../sync";
import type { CommandCaller } from "../infra/commandCaller";
import { EventBus } from "../infra/eventBus";
import { TerminalRegistry } from "../infra/registries";
import type { AdapterEvents, AdapterInfra } from "../types";
import { assertWebRuntimePinRoutable } from "../runtimePinGuard";
import { createGitNamespaces } from "../git";
import { createLanesNamespace } from "../lanes";
import { createSessionsPtyNamespaces } from "../sessionsPty";

const OWN_ENV = "env-1";
const OWN_PROJECT = "project-1";

function scopeFixture(envId: string | null = OWN_ENV, projectId: string | null = OWN_PROJECT) {
  const call = vi.fn(async (_action: string, ..._rest: unknown[]) => null);
  const infra = {
    client: { getStatus: () => ({ selectedEnvId: envId }) } as unknown as AdeSyncClient,
    state: { getProjectId: () => projectId },
    commands: { call } as unknown as CommandCaller,
  } as unknown as AdapterInfra;
  return { infra, call };
}

/**
 * A fixture complete enough to construct the real `lanes` and `sessions`
 * namespaces. The transport is deliberately healthy — connected socket, every
 * action advertised — so a test that observes no command proves the runtime pin
 * refused the call, not that the host was unavailable.
 */
function namespaceFixture(envId: string | null = OWN_ENV, projectId: string | null = OWN_PROJECT) {
  const call = vi.fn(async (_action: string, ..._rest: unknown[]) => null);
  const infra = {
    client: {
      getStatus: () => ({ selectedEnvId: envId, state: "connected" }),
      subscribeTerminal: () => () => {},
      subscribeChat: () => () => {},
      onChatEvent: () => () => {},
      onTablesChanged: () => () => {},
    } as unknown as AdeSyncClient,
    state: { getProjectId: () => projectId, getProject: () => null },
    commands: { call, hasAction: () => true, invalidateCache: () => {} } as unknown as CommandCaller,
    events: new EventBus<AdapterEvents>(),
    localState: {} as AdapterInfra["localState"],
    terminalRegistry: new TerminalRegistry(),
    addDispose: () => {},
  } as unknown as AdapterInfra;
  return { infra, call };
}

function remotePin(targetId: string, projectId: string): OpenProjectBinding {
  return {
    kind: "remote",
    key: `remote:${targetId}:${projectId}`,
    targetId,
    projectId,
    runtimeName: targetId,
    rootPath: "/repo",
    displayName: targetId,
  };
}

function localPin(): OpenProjectBinding {
  return { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "Repo" };
}

describe("assertWebRuntimePinRoutable", () => {
  it("passes an absent pin and a pin restating this adapter's own binding", () => {
    const { infra } = scopeFixture();
    expect(() => assertWebRuntimePinRoutable("git.commit", null, infra)).not.toThrow();
    expect(() => assertWebRuntimePinRoutable("git.commit", undefined, infra)).not.toThrow();
    expect(() => assertWebRuntimePinRoutable(
      "git.commit",
      remotePin(OWN_ENV, OWN_PROJECT),
      infra,
    )).not.toThrow();
  });

  it("refuses another machine's pin and names the binding", () => {
    const { infra } = scopeFixture();
    expect(() => assertWebRuntimePinRoutable(
      "git.commit",
      remotePin("env-2", "project-2"),
      infra,
    )).toThrow(/git\.commit.*remote:env-2:project-2/s);
  });

  it("refuses a same-machine pin naming a different project", () => {
    const { infra } = scopeFixture();
    expect(() => assertWebRuntimePinRoutable(
      "diff.getChanges",
      remotePin(OWN_ENV, "project-other"),
      infra,
    )).toThrow(/diff\.getChanges/);
  });

  it("explains a desktop-local pin instead of reporting an unknown binding", () => {
    const { infra } = scopeFixture();
    expect(() => assertWebRuntimePinRoutable("terminal.write", localPin(), infra))
      .toThrow("This chat runs on a machine ADE Web can't reach directly.");
  });
});

describe("git namespace pin guard", () => {
  it("sends no command for a foreign pin on a generated mutation", async () => {
    const { infra, call } = scopeFixture();
    const { git } = createGitNamespaces(infra);
    await expect(git.stageFile!(
      { laneId: "lane-1", path: "a.ts" },
      remotePin("env-2", "project-2"),
    )).rejects.toThrow(/git\.stageFile/);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no command for a local pin on a diff read", async () => {
    const { infra, call } = scopeFixture();
    const { diff } = createGitNamespaces(infra);
    await expect(diff.getChanges!({ laneId: "lane-1" }, localPin()))
      .rejects.toThrow("This chat runs on a machine ADE Web can't reach directly.");
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards a pin that restates this adapter's own binding", async () => {
    const { infra, call } = scopeFixture();
    const { git, diff } = createGitNamespaces(infra);
    await git.commit!({ laneId: "lane-1", message: "x" }, remotePin(OWN_ENV, OWN_PROJECT));
    await diff.getFile!(
      { laneId: "lane-1", path: "a.ts", mode: "unstaged" },
      remotePin(OWN_ENV, OWN_PROJECT),
    );
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(["git.commit", "git.getFile"]);
  });
});

describe("sessions namespace pin guard", () => {
  it("sends no work.deleteSession for a foreign pin", async () => {
    const { infra, call } = namespaceFixture();
    const { sessions } = createSessionsPtyNamespaces(infra);
    await expect(sessions.delete!({ sessionId: "session-1" }, remotePin("env-2", "project-2")))
      .rejects.toThrow(/sessions\.delete.*remote:env-2:project-2/s);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no work.updateSessionMeta for a same-machine pin on another project", async () => {
    const { infra, call } = namespaceFixture();
    const { sessions } = createSessionsPtyNamespaces(infra);
    await expect(sessions.updateMeta!(
      { sessionId: "session-1", title: "Renamed" },
      remotePin(OWN_ENV, "project-other"),
    )).rejects.toThrow(/sessions\.updateMeta/);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no lifecycle command for a foreign pin on settle", async () => {
    const { infra, call } = namespaceFixture();
    const { sessions } = createSessionsPtyNamespaces(infra);
    await expect(sessions.settle!("session-1", undefined, remotePin("env-2", "project-2")))
      .rejects.toThrow(/sessions\.settle/);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no lifecycle command for a desktop-local pin on snoozeSession", async () => {
    const { infra, call } = namespaceFixture();
    const { sessions } = createSessionsPtyNamespaces(infra);
    await expect(sessions.snoozeSession!("session-1", new Date().toISOString(), localPin()))
      .rejects.toThrow("This chat runs on a machine ADE Web can't reach directly.");
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards session mutations pinned to this adapter's own binding", async () => {
    const { infra, call } = namespaceFixture();
    const { sessions } = createSessionsPtyNamespaces(infra);
    const ownPin = remotePin(OWN_ENV, OWN_PROJECT);
    await sessions.delete!({ sessionId: "session-1" }, ownPin);
    await sessions.updateMeta!({ sessionId: "session-1", title: "Renamed" }, ownPin);
    await sessions.unsettle!("session-1", ownPin);
    expect(call.mock.calls.map((entry) => entry[0])).toEqual([
      "work.deleteSession",
      "work.updateSessionMeta",
      "session.unsettleSession",
    ]);
  });
});

describe("lanes namespace pin guard", () => {
  it("sends no lanes.delete for a foreign pin", async () => {
    const { infra, call } = namespaceFixture();
    const lanes = createLanesNamespace(infra);
    await expect(lanes.delete!({ laneId: "lane-1" }, remotePin("env-2", "project-2")))
      .rejects.toThrow(/lanes\.delete.*remote:env-2:project-2/s);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no lanes.create for a desktop-local pin", async () => {
    const { infra, call } = namespaceFixture();
    const lanes = createLanesNamespace(infra);
    await expect(lanes.create!({ name: "lane" }, localPin()))
      .rejects.toThrow("This chat runs on a machine ADE Web can't reach directly.");
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no lanes.archive or lanes.rename for a same-machine pin on another project", async () => {
    const { infra, call } = namespaceFixture();
    const lanes = createLanesNamespace(infra);
    const foreignProjectPin = remotePin(OWN_ENV, "project-other");
    await expect(lanes.archive!({ laneId: "lane-1" }, foreignProjectPin))
      .rejects.toThrow(/lanes\.archive/);
    await expect(lanes.rename!({ laneId: "lane-1", name: "next" }, foreignProjectPin))
      .rejects.toThrow(/lanes\.rename/);
    expect(call).not.toHaveBeenCalled();
  });

  it("emits no lane lifecycle event when a pinned delete is refused", async () => {
    const { infra } = namespaceFixture();
    const lanes = createLanesNamespace(infra);
    const seen: unknown[] = [];
    infra.events.on("lanesLifecycle", (event) => seen.push(event));
    await expect(lanes.delete!({ laneId: "lane-1" }, remotePin("env-2", "project-2")))
      .rejects.toThrow(/lanes\.delete/);
    expect(seen).toEqual([]);
  });

  it("forwards lane mutations pinned to this adapter's own binding", async () => {
    const { infra, call } = namespaceFixture();
    const lanes = createLanesNamespace(infra);
    const ownPin = remotePin(OWN_ENV, OWN_PROJECT);
    await lanes.delete!({ laneId: "lane-1" }, ownPin);
    await lanes.getDeleteRisk!({ laneId: "lane-1" }, ownPin);
    expect(call.mock.calls.map((entry) => entry[0])).toEqual([
      "lanes.delete",
      "lanes.getDeleteRisk",
    ]);
  });
});
