import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../desktop/src/main/services/computerUse/localComputerUse", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../desktop/src/main/services/computerUse/localComputerUse")
  >();
  const present = { state: "present" as const, available: true, command: "fake-screencapture", detail: "stubbed" };
  return {
    ...actual,
    getLocalComputerUseCapabilities: () => ({
      platform: "darwin" as const,
      overallState: "present" as const,
      screenshot: present,
      videoRecording: present,
      appLaunch: present,
      guiInteraction: present,
      environmentInfo: present,
      proofRequirements: {
        screenshot: present,
        browser_verification: present,
        browser_trace: present,
        video_recording: present,
        console_logs: present,
      },
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const nodeFs = await import("node:fs");
  return {
    ...actual,
    default: actual,
    // Stand in for `screencapture`: write the bytes the real binary would to the
    // output path (always the last argument) without touching the display.
    spawnSync: (_command: string, args: string[]) => {
      const target = args[args.length - 1]!;
      nodeFs.default.writeFileSync(target, "fake-capture-bytes");
      return { status: 0, stdout: "", stderr: "" };
    },
  };
});

const { createAdeRpcRequestHandler, isExplicitProofCall } = await import("./adeRpcServer");

let projectRoot = "";
const createdRoots: string[] = [];

function createRuntime() {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-explicit-"));
  createdRoots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, ".ade"), { recursive: true });
  const ingest = vi.fn(() => ({ artifacts: [{ id: "artifact-1", uri: "x", title: "t" }], links: [] }));
  return {
    ingest,
    runtime: {
      projectRoot,
      workspaceRoot: projectRoot,
      projectId: "project-1",
      project: { rootPath: projectRoot, displayName: "project", baseRef: "main" },
      paths: { adeDir: path.join(projectRoot, ".ade") },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      db: { getJson: vi.fn(() => null), setJson: vi.fn(), get: vi.fn(() => null), all: vi.fn(() => []), run: vi.fn() },
      operationService: { start: vi.fn(() => ({ operationId: "op-1" })), finish: vi.fn() },
      laneService: { list: vi.fn(async () => []), ensurePrimaryLane: vi.fn(async () => null) },
      sessionService: { get: vi.fn(() => ({ id: "chat-1", laneId: "lane-1" })) },
      computerUseArtifactBrokerService: {
        ingest,
        getBackendStatus: vi.fn(() => ({ backends: [], localFallback: { available: true } })),
        listArtifacts: vi.fn(() => []),
      },
    } as any,
  };
}

async function callTool(handler: any, name: string, argumentsPayload: Record<string, unknown>) {
  const result = (await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "ade/actions/call",
    params: { name, arguments: argumentsPayload },
  })) as any;
  if (result && typeof result === "object" && result.ok === false) {
    return { isError: true, structuredContent: result, error: result.error };
  }
  return { structuredContent: result };
}

const previousRole = process.env.ADE_DEFAULT_ROLE;

beforeEach(() => {
  process.env.ADE_DEFAULT_ROLE = "agent";
});

afterEach(() => {
  if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
  else process.env.ADE_DEFAULT_ROLE = previousRole;
  while (createdRoots.length) fs.rmSync(createdRoots.pop()!, { recursive: true, force: true });
});

describe("explicit proof capture", () => {
  async function handlerFor(fixture: ReturnType<typeof createRuntime>) {
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { identity: { callerId: "chat-1", role: "agent", chatSessionId: "chat-1" } },
    });
    return handler;
  }

  it("files no proof-drawer record for a bare screenshot_environment call", async () => {
    const fixture = createRuntime();
    const handler = await handlerFor(fixture);

    const result = await callTool(handler, "screenshot_environment", { name: "Look at the screen" });

    expect(result.isError).toBeFalsy();
    expect(fixture.ingest).not.toHaveBeenCalled();
    expect(result.structuredContent.proof).toBe(false);
    expect(result.structuredContent.artifacts).toEqual([]);
    // The bytes land in scratch, not the artifact store the drawer reads, and
    // they survive so `ade proof attach` can still promote them.
    const capturePath: string = result.structuredContent.artifact.path;
    expect(capturePath.startsWith(path.join(projectRoot, ".ade", "cache", "tmp", "computer-use"))).toBe(true);
    expect(fs.existsSync(capturePath)).toBe(true);
    expect(result.structuredContent.note).toContain("ade proof");
  });

  it("files a record for the explicit proof call `ade proof capture --caption` makes", async () => {
    const fixture = createRuntime();
    const handler = await handlerFor(fixture);

    // Exactly the arguments buildCliPlan emits for
    // `ade proof capture --caption "logged in as admin"`.
    const result = await callTool(handler, "screenshot_environment", {
      proof: true,
      name: "logged in as admin",
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.ingest).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.proof).toBe(true);
    const capturePath: string = result.structuredContent.artifact.path;
    expect(capturePath.startsWith(path.join(projectRoot, ".ade", "artifacts", "computer-use"))).toBe(true);
  });

  it("keeps record_environment scratch unless the call asks for proof", async () => {
    const bare = createRuntime();
    const bareHandler = await handlerFor(bare);
    const bareResult = await callTool(bareHandler, "record_environment", { durationSec: 1 });
    expect(bareResult.isError).toBeFalsy();
    expect(bare.ingest).not.toHaveBeenCalled();
    expect(bareResult.structuredContent.proof).toBe(false);

    const proof = createRuntime();
    const proofHandler = await handlerFor(proof);
    const proofResult = await callTool(proofHandler, "record_environment", { durationSec: 1, proof: true });
    expect(proofResult.isError).toBeFalsy();
    expect(proof.ingest).toHaveBeenCalledTimes(1);
    expect(proofResult.structuredContent.proof).toBe(true);
  });

  it("advertises the proof flag on both capture tools so the model can tell them apart", async () => {
    const fixture = createRuntime();
    const handler = await handlerFor(fixture);

    const listed = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;
    const byName = new Map<string, any>((listed.actions ?? []).map((tool: any) => [tool.name, tool]));

    for (const name of ["screenshot_environment", "record_environment"]) {
      const spec = byName.get(name);
      expect(spec, name).toBeTruthy();
      expect(spec.inputSchema.properties.proof).toMatchObject({ type: "boolean", default: false });
      expect(spec.description).toContain("proof drawer");
    }
  });
});

describe("isExplicitProofCall", () => {
  it("treats only an explicit `proof: true` as a proof call", () => {
    expect(isExplicitProofCall({})).toBe(false);
    expect(isExplicitProofCall({ proof: false })).toBe(false);
    expect(isExplicitProofCall({ proof: "true" })).toBe(false);
    expect(isExplicitProofCall({ name: "screenshot" })).toBe(false);
    expect(isExplicitProofCall({ proof: true })).toBe(true);
  });
});
