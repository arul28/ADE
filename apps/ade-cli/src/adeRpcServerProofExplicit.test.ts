import { createHash } from "node:crypto";
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

const { createAdeRpcRequestHandler, isExplicitProofCall, resolveIngestProvenance } = await import("./adeRpcServer");
const { createAdeCaptureRegistry } = await import("./services/proof/adeCaptureRegistry");

let projectRoot = "";
const createdRoots: string[] = [];
const sha256Of = (filePath: string) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

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
        ingestAsync: ingest,
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
    expect(fixture.ingest.mock.calls[0]).toEqual([expect.objectContaining({ provenance: { source: "ade-capture" } })]);
    expect(result.structuredContent.proof).toBe(true);
    const capturePath: string = result.structuredContent.artifact.path;
    expect(capturePath.startsWith(path.join(projectRoot, ".ade", "artifacts", "computer-use"))).toBe(true);
  });

  it("an unbound caller's proof capture is owned by the lane it stands in", async () => {
    // `ade proof capture` and `ade proof record` file through a door that had
    // no lane inference of its own, so a caller with no chat session produced
    // an artifact with an EMPTY owner list — stored, and reachable by no
    // drawer. Seven such records existed on the owner's machine, alongside 36
    // from `proof attach`.
    const fixture = createRuntime();
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-7");
    fs.mkdirSync(laneRoot, { recursive: true });
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-7", worktreePath: laneRoot, attachedRootPath: null },
    ]);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      // No chatSessionId: the shape of every OpenCode agent's shell.
      params: { identity: { callerId: "ade-cli:4242", role: "agent" } },
    });

    const result = await callTool(handler, "screenshot_environment", {
      proof: true,
      name: "capture from a lane worktree",
      callerRoot: laneRoot,
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.ingest).toHaveBeenCalledTimes(1);
    const [firstCall] = fixture.ingest.mock.calls as unknown as Array<[{ owners?: Array<{ kind: string; id: string }> }]>;
    const owners = firstCall?.[0]?.owners ?? [];
    expect(owners).toEqual([expect.objectContaining({ kind: "lane", id: "lane-7" })]);
    // And never a process id masquerading as a chat.
    expect(owners.some((owner) => owner.id.includes(":"))).toBe(false);
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
    // ADE ran the recorder, so the drawer can say when.
    const [[request]] = proof.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(request?.provenance).toMatchObject({
      source: "ade-recorder",
      recordedFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      recordedTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("files `ade proof attach` as an attach, never trusting provenance from the arguments", async () => {
    const fixture = createRuntime();
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-7");
    fs.mkdirSync(laneRoot, { recursive: true });
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-7", worktreePath: laneRoot, attachedRootPath: null },
    ]);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { identity: { callerId: "ade-cli:4242", role: "agent" } },
    });
    const file = path.join(laneRoot, "clip.mp4");
    fs.writeFileSync(file, "bytes");

    const result = await callTool(handler, "ingest_computer_use_artifacts", {
      backendStyle: "manual",
      backendName: "ade-cli",
      toolName: "proof attach",
      callerRoot: laneRoot,
      provenance: { source: "ade-recorder" },
      inputs: [{ kind: "video_recording", title: "Clip", path: file }],
    });

    expect(JSON.stringify(result.error ?? null)).toBe("null");
    const [[request]] = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(request?.provenance).toEqual({ source: "attached" });
  });

  async function laneAgentHandler(fixture: ReturnType<typeof createRuntime>) {
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-7");
    fs.mkdirSync(laneRoot, { recursive: true });
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-7", worktreePath: laneRoot, attachedRootPath: null },
    ]);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { identity: { callerId: "ade-cli:4242", role: "agent" } },
    });
    return { handler, laneRoot };
  }

  it("an ADE capture label on an old file does not make it ADE's", async () => {
    const fixture = createRuntime();
    const { handler, laneRoot } = await laneAgentHandler(fixture);
    const clip = path.join(laneRoot, "old.mp4");
    const still = path.join(laneRoot, "old.png");
    fs.writeFileSync(clip, "old video");
    fs.writeFileSync(still, "old still");

    for (const [backendName, toolName, input] of [
      ["ade-browser", "browser record", { kind: "video_recording", title: "Clip", path: clip }],
      ["ade-ios-simulator", "ios-sim proof", { kind: "screenshot", title: "Still", path: still }],
    ] as const) {
      const result = await callTool(handler, "ingest_computer_use_artifacts", {
        backendStyle: "manual",
        backendName,
        toolName,
        callerRoot: laneRoot,
        inputs: [input],
      });
      expect(JSON.stringify(result.error ?? null)).toBe("null");
    }
    const requests = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(requests.map(([request]) => request?.provenance)).toEqual([
      { source: "attached" },
      { source: "attached" },
    ]);
  });

  it("files a capture this server wrote, unchanged, as ADE's own", async () => {
    const fixture = createRuntime();
    const { handler, laneRoot } = await laneAgentHandler(fixture);
    const capture = await callTool(handler, "screenshot_environment", { name: "scratch look" });
    const capturePath: string = capture.structuredContent.artifact.path;

    const result = await callTool(handler, "ingest_computer_use_artifacts", {
      backendStyle: "manual",
      backendName: "ade-cli",
      toolName: "proof attach",
      callerRoot: laneRoot,
      inputs: [{ kind: "screenshot", title: "Look", path: capturePath }],
    });

    expect(JSON.stringify(result.error ?? null)).toBe("null");
    const [[request]] = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(request?.provenance).toEqual({
      source: "ade-capture",
      refuseDuplicates: false,
      flagOlderMedia: true,
      capturedSha256: [sha256Of(capturePath)],
    });
  });

  it("files `ade apple proof` as ADE's capture: the screenshot action's file, unchanged", async () => {
    const fixture = createRuntime();
    const { handler, laneRoot } = await laneAgentHandler(fixture);
    const shotPath = path.join(laneRoot, "screen.png");
    fixture.runtime.iosSimulatorService = {
      screenshot: vi.fn(async () => {
        fs.writeFileSync(shotPath, "device pixels");
        return { filePath: shotPath, deviceUdid: "SIM-1" };
      }),
    };
    const ingestShot = () => callTool(handler, "ingest_computer_use_artifacts", {
      backendStyle: "manual",
      backendName: "ade-ios-simulator",
      toolName: "ios-sim proof",
      callerRoot: laneRoot,
      inputs: [{ kind: "screenshot", title: "Screen", path: shotPath }],
    });

    await callTool(handler, "run_ade_action", { domain: "ios_simulator", action: "screenshot", args: {} });
    await ingestShot();
    const capturedSha = sha256Of(shotPath);
    // Same path, other bytes: no longer the capture.
    await callTool(handler, "run_ade_action", { domain: "ios_simulator", action: "screenshot", args: {} });
    fs.writeFileSync(shotPath, "an older screenshot");
    await ingestShot();

    const requests = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(requests.map(([request]) => request?.provenance)).toEqual([
      { source: "ade-capture", refuseDuplicates: false, flagOlderMedia: true, capturedSha256: [capturedSha] },
      { source: "attached" },
    ]);
  });

  it("a capture files as ADE's once; attaching it again is an attach", async () => {
    const fixture = createRuntime();
    const { handler, laneRoot } = await laneAgentHandler(fixture);
    const shotPath = path.join(laneRoot, "screen.png");
    fixture.runtime.iosSimulatorService = {
      screenshot: vi.fn(async () => {
        fs.writeFileSync(shotPath, "device pixels");
        return { filePath: shotPath, deviceUdid: "SIM-1" };
      }),
    };
    await callTool(handler, "run_ade_action", { domain: "ios_simulator", action: "screenshot", args: {} });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await callTool(handler, "ingest_computer_use_artifacts", {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        callerRoot: laneRoot,
        inputs: [{ kind: "screenshot", title: "Screen", path: shotPath }],
      });
    }

    const requests = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(requests.map(([request]) => request?.provenance?.source)).toEqual(["ade-capture", "attached"]);
  });

  it("a failed ingest leaves the capture ADE's for the retry, once", async () => {
    const fixture = createRuntime();
    const { handler, laneRoot } = await laneAgentHandler(fixture);
    const shotPath = path.join(laneRoot, "screen.png");
    fixture.runtime.iosSimulatorService = {
      screenshot: vi.fn(async () => {
        fs.writeFileSync(shotPath, "device pixels");
        return { filePath: shotPath, deviceUdid: "SIM-1" };
      }),
    };
    fixture.ingest.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await callTool(handler, "run_ade_action", { domain: "ios_simulator", action: "screenshot", args: {} });
    const outcomes: boolean[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await callTool(handler, "ingest_computer_use_artifacts", {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        callerRoot: laneRoot,
        inputs: [{ kind: "screenshot", title: "Screen", path: shotPath }],
      });
      outcomes.push(result.isError === true);
    }

    expect(outcomes).toEqual([true, false, false]);
    const requests = fixture.ingest.mock.calls as unknown as Array<[{ provenance?: Record<string, unknown> }]>;
    expect(requests.map(([request]) => request?.provenance?.source)).toEqual(["ade-capture", "ade-capture", "attached"]);
  });

  it("refuses an ownerless ingest before storing it, so a retry with an owner is not a duplicate", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    // A CTO user client standing outside every lane.
    process.env.ADE_DEFAULT_ROLE = "cto";
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { identity: { callerId: "ade-cli:4243", role: "cto" } },
    });
    const file = path.join(projectRoot, "clip.png");
    fs.writeFileSync(file, "bytes");

    const result = await callTool(handler, "ingest_computer_use_artifacts", {
      backendStyle: "manual",
      backendName: "ade-cli",
      toolName: "proof attach",
      callerRoot: projectRoot,
      inputs: [{ kind: "screenshot", title: "Clip", path: file }],
    });

    expect(JSON.stringify(result.error ?? "")).toMatch(/no lane, chat session, automation run, PR or issue/);
    expect(fixture.ingest).not.toHaveBeenCalled();
  });

  it("stores an ingest whose only owner is a PR, an issue or an automation run", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    // A CTO user client standing outside every lane, so no lane or chat owner is implied.
    process.env.ADE_DEFAULT_ROLE = "cto";
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: { identity: { callerId: "ade-cli:4243", role: "cto" } },
    });

    for (const [ownerKind, ownerId] of [["pr", "pr-7"], ["linear_issue", "ADE-42"], ["automation_run", "run-3"]] as const) {
      const file = path.join(projectRoot, `clip-${ownerKind}.png`);
      fs.writeFileSync(file, `bytes-${ownerKind}`);
      fixture.ingest.mockClear();
      const result = await callTool(handler, "ingest_computer_use_artifacts", {
        backendStyle: "manual",
        backendName: "ade-cli",
        toolName: "proof attach",
        callerRoot: projectRoot,
        ownerKind,
        ownerId,
        inputs: [{ kind: "screenshot", title: "Clip", path: file }],
      });
      expect(result.isError, `${ownerKind}: ${JSON.stringify(result.error ?? "")}`).not.toBe(true);
      const [[request]] = fixture.ingest.mock.calls as unknown as Array<[{ owners?: Array<{ kind: string; id: string }> }]>;
      const expectedKind = ownerKind === "pr" ? "github_pr" : ownerKind;
      expect(request?.owners).toEqual(expect.arrayContaining([expect.objectContaining({ kind: expectedKind, id: ownerId })]));
    }
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

describe("resolveIngestProvenance", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-capture-registry-"));
    createdRoots.push(dir);
  });

  it("files a file no capture action wrote as an attach, whatever it is called", async () => {
    const registry = createAdeCaptureRegistry();
    fs.writeFileSync(path.join(dir, "old.png"), "old");
    expect((await resolveIngestProvenance(registry, [{ kind: "screenshot", path: "old.png" }], dir)).provenance)
      .toEqual({ source: "attached" });
  });

  it("files ADE's own unchanged capture as ADE's, and lifts the duplicate check only for stills", async () => {
    const registry = createAdeCaptureRegistry();
    const still = path.join(dir, "shot.png");
    const trace = path.join(dir, "net.har");
    const video = path.join(dir, "clip.webm");
    fs.writeFileSync(still, "png");
    fs.writeFileSync(trace, "har");
    fs.writeFileSync(video, "webm");
    await registry.remember(still, "ade-capture");
    await registry.remember(trace, "ade-capture");
    await registry.remember(video, "ade-recorder");

    expect((await resolveIngestProvenance(registry, [
      { kind: "screenshot", path: still },
      { kind: "browser_trace", path: "net.har" },
    ], dir)).provenance).toEqual({
      source: "ade-capture",
      refuseDuplicates: false,
      flagOlderMedia: true,
      capturedSha256: [sha256Of(still), sha256Of(trace)],
    });
    expect((await resolveIngestProvenance(registry, [{ kind: "video_recording", path: video }], dir)).provenance)
      .toEqual({ source: "ade-recorder", refuseDuplicates: true, flagOlderMedia: true, capturedSha256: [sha256Of(video)] });
    // One input ADE did not write makes the whole call an attach.
    const other = path.join(dir, "other.png");
    fs.writeFileSync(other, "other");
    await registry.remember(still, "ade-capture");
    expect((await resolveIngestProvenance(registry, [
      { kind: "screenshot", path: still },
      { kind: "screenshot", path: other },
    ], dir)).provenance).toEqual({ source: "attached" });
  });

  it("bytes swapped in after the capture are an attach", async () => {
    const registry = createAdeCaptureRegistry();
    const still = path.join(dir, "shot.png");
    fs.writeFileSync(still, "fresh");
    await registry.remember(still, "ade-capture");
    fs.writeFileSync(still, "stale proof from last week");
    expect((await resolveIngestProvenance(registry, [{ kind: "screenshot", path: still }], dir)).provenance)
      .toEqual({ source: "attached" });
  });

  it("forgets a capture after its time to live", async () => {
    let now = 1_000;
    const registry = createAdeCaptureRegistry({ ttlMs: 100, now: () => now });
    const still = path.join(dir, "shot.png");
    fs.writeFileSync(still, "png");
    await registry.remember(still, "ade-capture");
    now += 101;
    expect(await registry.match(still)).toBeNull();
  });

  it("matches a capture once, then forgets it", async () => {
    const registry = createAdeCaptureRegistry();
    const still = path.join(dir, "shot.png");
    fs.writeFileSync(still, "png");
    await registry.remember(still, "ade-capture");
    const match = await registry.match(still);
    expect(match).toMatchObject({ source: "ade-capture", sha256: sha256Of(still) });
    expect(await registry.match(still)).toBeNull();

    // A copy of the match still hands the claim back, and only once.
    const copy = { ...match! };
    copy.release();
    copy.release();
    expect(await registry.match(still)).toMatchObject({ source: "ade-capture" });
    expect(await registry.match(still)).toBeNull();
  });

  it("a failed or mixed filing leaves the capture matchable once", async () => {
    const registry = createAdeCaptureRegistry();
    const still = path.join(dir, "shot.png");
    const other = path.join(dir, "other.png");
    fs.writeFileSync(still, "png");
    fs.writeFileSync(other, "other");
    await registry.remember(still, "ade-capture");

    // The ingest threw: its claim goes back.
    const failed = await resolveIngestProvenance(registry, [{ kind: "screenshot", path: still }], dir);
    expect(failed.provenance.source).toBe("ade-capture");
    failed.release();

    // Filed next to a file ADE did not write: an attach, and the claim goes back.
    const mixed = await resolveIngestProvenance(registry, [
      { kind: "screenshot", path: still },
      { kind: "screenshot", path: other },
    ], dir);
    expect(mixed.provenance).toEqual({ source: "attached" });

    // Still ADE's own capture, once.
    const kept = await resolveIngestProvenance(registry, [{ kind: "screenshot", path: still }], dir);
    expect(kept.provenance).toMatchObject({ source: "ade-capture", capturedSha256: [sha256Of(still)] });
    expect((await resolveIngestProvenance(registry, [{ kind: "screenshot", path: still }], dir)).provenance)
      .toEqual({ source: "attached" });
  });
});
