import { describe, expect, it, vi } from "vitest";
import type { AdeSyncClient } from "../../sync";
import type { CommandCaller } from "../infra/commandCaller";
import type { AdapterInfra } from "../types";
import { assertWebRuntimePinRoutable } from "../runtimePinGuard";
import { createGitNamespaces } from "../git";

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

function remotePin(targetId: string, projectId: string) {
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

function localPin() {
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
      remotePin("env-2", "project-2") as never,
    )).rejects.toThrow(/git\.stageFile/);
    expect(call).not.toHaveBeenCalled();
  });

  it("sends no command for a local pin on a diff read", async () => {
    const { infra, call } = scopeFixture();
    const { diff } = createGitNamespaces(infra);
    await expect(diff.getChanges!({ laneId: "lane-1" }, localPin() as never))
      .rejects.toThrow("This chat runs on a machine ADE Web can't reach directly.");
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards a pin that restates this adapter's own binding", async () => {
    const { infra, call } = scopeFixture();
    const { git, diff } = createGitNamespaces(infra);
    await git.commit!({ laneId: "lane-1", message: "x" }, remotePin(OWN_ENV, OWN_PROJECT) as never);
    await diff.getFile!({ laneId: "lane-1", path: "a.ts" } as never, remotePin(OWN_ENV, OWN_PROJECT) as never);
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(["git.commit", "git.getFile"]);
  });
});
