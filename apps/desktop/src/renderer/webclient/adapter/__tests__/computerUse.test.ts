import { describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { AdeSyncClient } from "../../sync";
import type { CommandCaller } from "../infra/commandCaller";
import { requestDataUrl } from "../infra/fileBlob";
import { createComputerUseNamespace } from "../computerUse";
import { WebRuntimePinUnroutableError } from "../runtimePinGuard";
import type { AdapterInfra } from "../types";

vi.mock("../infra/fileBlob", () => ({
  requestDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
}));

const OWN_ENV = "env-1";
const OWN_PROJECT = "project-1";

/**
 * A command caller shaped like the real one for an action the host serves: the
 * fallback is only reached when the host has no such descriptor, so `served`
 * decides which path a test takes.
 */
function fixture({ served, rows = [] }: { served: boolean; rows?: unknown[] }) {
  const call = vi.fn(async (_action: string, _args: Record<string, unknown>, options: { fallback: unknown }) => {
    if (served) return rows;
    const fallback = options.fallback;
    return typeof fallback === "function" ? (fallback as () => unknown)() : fallback;
  });
  const infra = {
    client: { getStatus: () => ({ selectedEnvId: OWN_ENV }) } as unknown as AdeSyncClient,
    state: { getProjectId: () => OWN_PROJECT },
    commands: { call } as unknown as CommandCaller,
  } as unknown as AdapterInfra;
  const ns = createComputerUseNamespace(infra) as unknown as {
    listArtifacts: (args?: Record<string, unknown>, pin?: OpenProjectBinding | null) => Promise<unknown[]>;
    readArtifactPreview: (args: { uri: string }, pin?: OpenProjectBinding | null) => Promise<string | null>;
    getStatus: () => Promise<{ supported: boolean }>;
  };
  return { ns, call };
}

function pin(targetId: string, projectId: string): OpenProjectBinding {
  return {
    kind: "remote",
    key: `remote:${targetId}:${projectId}`,
    targetId,
    projectId,
    runtimeName: targetId,
    rootPath: "/repo",
    displayName: targetId,
  } as OpenProjectBinding;
}

describe("web computerUse.listArtifacts", () => {
  it("asks the host for the cited artifact and forwards only the list filters", async () => {
    const { ns, call } = fixture({ served: true, rows: [{ id: "art-1" }] });

    const rows = await ns.listArtifacts({ artifactId: "art-1", limit: 1, uri: "/etc/passwd" } as Record<string, unknown>);

    expect(rows).toEqual([{ id: "art-1" }]);
    expect(call).toHaveBeenCalledTimes(1);
    const [action, args, options] = call.mock.calls[0]!;
    expect(action).toBe("computerUse.listArtifacts");
    expect(args).toEqual({
      artifactId: "art-1",
      ownerKind: undefined,
      ownerId: undefined,
      kind: undefined,
      metadataKind: undefined,
      excludeMetadataKind: undefined,
      limit: 1,
    });
    expect(options).toMatchObject({ idempotent: true, authoritative: true });
  });

  it("routes a pin naming this machine and project through the same host", async () => {
    const { ns, call } = fixture({ served: true, rows: [] });

    await expect(ns.listArtifacts({ artifactId: "art-1" }, pin(OWN_ENV, OWN_PROJECT))).resolves.toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refuses a pin naming another machine without sending anything", async () => {
    const { ns, call } = fixture({ served: true });

    await expect(ns.listArtifacts({ artifactId: "art-1" }, pin("env-2", OWN_PROJECT)))
      .rejects.toBeInstanceOf(WebRuntimePinUnroutableError);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects when the host does not serve the action; it never answers an empty list", async () => {
    const { ns } = fixture({ served: false });

    await expect(ns.listArtifacts({ artifactId: "art-1" })).rejects.toThrow(/did not answer/);
  });

  it("leaves the rest of the native computer-use surface unsupported on web", async () => {
    const { ns } = fixture({ served: true });

    await expect(ns.getStatus()).resolves.toMatchObject({ supported: false });
  });
});

describe("web computerUse.readArtifactPreview", () => {
  it("reads the bytes through the host's jailed readArtifact file request", async () => {
    const { ns } = fixture({ served: true });

    await expect(ns.readArtifactPreview({ uri: ".ade/artifacts/computer-use/shot.png" }))
      .resolves.toBe("data:image/png;base64,AAAA");
    expect(requestDataUrl).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "readArtifact",
      { uri: ".ade/artifacts/computer-use/shot.png" },
    );
  });

  it("refuses a foreign pin before reading any bytes", async () => {
    const { ns } = fixture({ served: true });
    const before = vi.mocked(requestDataUrl).mock.calls.length;

    await expect(ns.readArtifactPreview({ uri: "x.png" }, pin("env-2", OWN_PROJECT)))
      .rejects.toBeInstanceOf(WebRuntimePinUnroutableError);
    expect(vi.mocked(requestDataUrl).mock.calls.length).toBe(before);
  });
});
