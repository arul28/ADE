import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type * as CursorSdkModuleTypes from "@cursor/sdk";
import type { AgentOptions } from "@cursor/sdk";
import type {
  CursorSdkCloudArtifactDescriptor,
  CursorSdkCloudArtifactDownloadResult,
  CursorSdkCloudFollowupPayload,
  CursorSdkCloudRunStartedResult,
  CursorSdkCloudSendStreamPayload,
  CursorSdkHookDecision,
  CursorSdkHookRequest,
  CursorSdkPermissionPolicy,
  CursorSdkWorkerInit,
  CursorSdkWorkerRequest,
  CursorSdkWorkerResponse,
} from "./cursorSdkProtocol";
import {
  allowCursorHook,
  denyCursorHook,
  evaluateCursorSdkHook,
  summarizeCursorHook,
} from "./cursorSdkPolicy";
import { ensureCursorSdkUserHook } from "./cursorSdkHooks";

type CursorSdkModule = typeof CursorSdkModuleTypes;
type SdkAgent = Awaited<ReturnType<CursorSdkModule["Agent"]["create"]>>;
type SdkRun = Awaited<ReturnType<SdkAgent["send"]>>;

let sdkModule: CursorSdkModule | null = null;
let initState: CursorSdkWorkerInit | null = null;
let agent: SdkAgent | null = null;
let currentRun: SdkRun | null = null;
let hookServer: net.Server | null = null;
const hookWaiters = new Map<string, (decision: CursorSdkHookDecision) => void>();
const cloudRuns = new Map<string, { run: SdkRun; agentId: string }>();

function post(message: CursorSdkWorkerResponse): void {
  if (process.send) {
    process.send(message);
  }
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.message.trim();
  const detailEntries: string[] = [];
  const record = error as Error & {
    code?: unknown;
    status?: unknown;
    operation?: unknown;
    endpoint?: unknown;
    requestId?: unknown;
    toJSON?: () => unknown;
  };
  let jsonRecord: Record<string, unknown> | null = null;
  if (typeof record.toJSON === "function") {
    try {
      const json = record.toJSON();
      if (json && typeof json === "object" && !Array.isArray(json)) {
        jsonRecord = json as Record<string, unknown>;
      }
    } catch {
      jsonRecord = null;
    }
  }
  for (const key of ["code", "status", "operation", "endpoint", "requestId"] as const) {
    const value = record[key] ?? jsonRecord?.[key];
    if (value !== undefined && value !== null && String(value).trim().length) {
      detailEntries.push(`${key}=${String(value)}`);
    }
  }
  const primary = message && message !== "Error"
    ? message
    : error.name && error.name !== "Error"
      ? error.name
      : "Unknown Cursor SDK error";
  return detailEntries.length ? `${primary} (${detailEntries.join(", ")})` : primary;
}

async function getSdk(): Promise<CursorSdkModule> {
  if (!sdkModule) {
    sdkModule = await import("@cursor/sdk");
  }
  return sdkModule;
}

function removeSocketIfNeeded(socketPath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // ignore
  }
}

function readJsonLine(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  });
}

async function startHookServer(init: CursorSdkWorkerInit): Promise<void> {
  if (hookServer) return;
  removeSocketIfNeeded(init.socketPath);
  hookServer = net.createServer((socket) => {
    readJsonLine(socket, (line) => {
      void handleHookSocketLine(init, socket, line);
    });
  });
  await new Promise<void>((resolve, reject) => {
    hookServer!.once("error", reject);
    hookServer!.listen(init.socketPath, () => {
      hookServer!.off("error", reject);
      resolve();
    });
  });
}

async function handleHookSocketLine(init: CursorSdkWorkerInit, socket: net.Socket, line: string): Promise<void> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(line);
    parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    parsed = { payload: { parseError: errorMessage(error), rawText: line } };
  }

  const raw = parsed?.payload ?? {};
  const request = summarizeCursorHook(raw, init.laneRoot);
  request.id = randomUUID();
  const localDecision = evaluateCursorSdkHook({
    request,
    policy: init.policy,
    laneRoot: init.laneRoot,
    userHomeDir: init.userHomeDir,
  });
  if (localDecision === "allow") {
    socket.end(`${JSON.stringify(allowCursorHook())}\n`);
    return;
  }
  if (localDecision === "deny") {
    socket.end(`${JSON.stringify(denyCursorHook(request.reason ?? "ADE denied this Cursor tool call."))}\n`);
    return;
  }

  const decision = await requestHookDecision(request);
  socket.end(`${JSON.stringify(decision)}\n`);
}

function requestHookDecision(request: CursorSdkHookRequest): Promise<CursorSdkHookDecision> {
  return new Promise((resolve) => {
    hookWaiters.set(request.id, resolve);
    post({ type: "hook_request", requestId: request.id, request });
  });
}

async function initWorker(init: CursorSdkWorkerInit): Promise<{ agentId: string; modelSdkId: string }> {
  initState = init;
  process.env.HOME = init.userHomeDir;
  process.env.USERPROFILE = init.userHomeDir;
  process.env.ADE_CURSOR_SDK_SOCKET = init.socketPath;
  process.env.ADE_CURSOR_SDK_LANE_ROOT = init.laneRoot;
  process.env.ADE_CURSOR_SDK_SESSION_ID = init.sessionId;
  process.env.ADE_CURSOR_SDK_STATE_ROOT = init.stateRoot;
  if (init.apiKey?.trim()) {
    process.env.CURSOR_API_KEY = init.apiKey.trim();
  } else {
    delete process.env.CURSOR_API_KEY;
  }
  fs.mkdirSync(init.userHomeDir, { recursive: true });
  fs.mkdirSync(init.stateRoot, { recursive: true });
  const hook = ensureCursorSdkUserHook({ userHomeDir: init.userHomeDir });
  await startHookServer(init);
  const { Agent } = await getSdk();
  // Keep these fields aligned with Cursor's TypeScript SDK docs:
  // local.cwd selects the workspace, platform.stateRoot isolates durable ADE
  // state, sandboxOptions is terminal policy, and hooks gate tool execution.
  const agentOptions: AgentOptions = {
    apiKey: init.apiKey?.trim() || undefined,
    model: { id: init.modelSdkId },
    name: init.agentName ?? undefined,
    local: {
      cwd: init.laneRoot,
      settingSources: ["project", "user"],
      sandboxOptions: { enabled: false },
    },
    platform: {
      workspaceRef: init.laneRoot,
      stateRoot: init.stateRoot,
    },
  };
  agent = init.agentId?.trim()
    ? await Agent.resume(init.agentId.trim(), agentOptions)
    : await Agent.create(agentOptions);
  post({
    type: "log",
    level: "debug",
    message: "Cursor SDK local runtime initialized.",
    detail: {
      laneRoot: init.laneRoot,
      userHomeDir: init.userHomeDir,
      stateRoot: init.stateRoot,
      hookPath: hook.hooksPath,
      hookChanged: hook.changed,
    },
  });
  post({ type: "ready", agentId: agent.agentId, modelSdkId: init.modelSdkId, transport: "sdk" });
  return { agentId: agent.agentId, modelSdkId: init.modelSdkId };
}

async function sendPrompt(payload: { promptText: string; images?: Array<{ data: string; mimeType: string }>; modelSdkId?: string | null; force?: boolean }): Promise<unknown> {
  if (!agent || !initState) throw new Error("Cursor SDK worker is not initialized.");
  const message = payload.images?.length
    ? { text: payload.promptText, images: payload.images }
    : payload.promptText;
  currentRun = await agent.send(message, {
    model: payload.modelSdkId?.trim() ? { id: payload.modelSdkId.trim() } : undefined,
    local: { force: payload.force === true },
  });
  post({
    type: "run_started",
    agentId: currentRun.agentId,
    runId: currentRun.id,
    modelSdkId: payload.modelSdkId ?? initState.modelSdkId,
    runtime: "local",
  });
  for await (const event of currentRun.stream()) {
    post({ type: "sdk_event", event, runtime: "local", runId: currentRun.id, agentId: currentRun.agentId });
  }
  const result = await currentRun.wait();
  post({ type: "run_result", result, runtime: "local", runId: currentRun.id, agentId: currentRun.agentId });
  currentRun = null;
  return result;
}

async function cancelRun(): Promise<void> {
  for (const [, resolve] of hookWaiters) {
    resolve(denyCursorHook("Run cancelled."));
  }
  hookWaiters.clear();
  await currentRun?.cancel();
}

async function updatePolicy(policy: CursorSdkPermissionPolicy): Promise<void> {
  if (!initState) throw new Error("Cursor SDK worker is not initialized.");
  initState.policy = policy;
  ensureCursorSdkUserHook({ userHomeDir: initState.userHomeDir });
}

async function dispose(): Promise<void> {
  try {
    await currentRun?.cancel();
  } catch {
    // ignore
  }
  currentRun = null;
  for (const [, entry] of cloudRuns) {
    try {
      await entry.run.cancel();
    } catch {
      // ignore
    }
  }
  cloudRuns.clear();
  for (const [, resolve] of hookWaiters) {
    resolve(denyCursorHook("Cursor SDK worker disposed before tool approval completed."));
  }
  hookWaiters.clear();
  try {
    await agent?.[Symbol.asyncDispose]?.();
  } catch {
    try {
      agent?.close();
    } catch {
      // ignore
    }
  }
  agent = null;
  if (hookServer) {
    await new Promise<void>((resolve) => hookServer!.close(() => resolve())).catch(() => {});
    hookServer = null;
  }
  if (initState) removeSocketIfNeeded(initState.socketPath);
}

async function handleCatalogModels(apiKey?: string | null): Promise<unknown> {
  const { Cursor } = await getSdk();
  return Cursor.models.list({ apiKey: apiKey?.trim() || undefined });
}

async function handleCatalogRepositories(apiKey?: string | null): Promise<unknown> {
  const { Cursor } = await getSdk();
  return Cursor.repositories.list({ apiKey: apiKey?.trim() || undefined });
}

function buildCloudCreateOptions(payload: CursorSdkCloudSendStreamPayload): AgentOptions {
  const repo: { url: string; startingRef?: string; prUrl?: string } = { url: payload.repoUrl };
  if (payload.startingRef?.trim()) repo.startingRef = payload.startingRef.trim();
  if (payload.prUrl?.trim()) repo.prUrl = payload.prUrl.trim();

  const cloud: NonNullable<AgentOptions["cloud"]> = {
    repos: [repo],
    workOnCurrentBranch: payload.workOnCurrentBranch,
    autoCreatePR: payload.autoCreatePR === true,
    skipReviewerRequest: payload.skipReviewerRequest !== false,
  };
  if (payload.envType) {
    cloud.env = payload.envName?.trim()
      ? ({ type: payload.envType, name: payload.envName.trim() } as NonNullable<AgentOptions["cloud"]>["env"])
      : ({ type: payload.envType } as NonNullable<AgentOptions["cloud"]>["env"]);
  }

  const options: AgentOptions = {
    apiKey: payload.apiKey?.trim() || undefined,
    name: payload.agentName?.trim() || undefined,
    cloud,
  };
  if (payload.modelSdkId?.trim()) options.model = { id: payload.modelSdkId.trim() };
  return options;
}

function buildCloudResumeOptions(payload: CursorSdkCloudFollowupPayload): Partial<AgentOptions> {
  const options: Partial<AgentOptions> = {
    apiKey: payload.apiKey?.trim() || undefined,
  };
  if (payload.modelSdkId?.trim()) options.model = { id: payload.modelSdkId.trim() };
  return options;
}

function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".js": case ".mjs": case ".cjs": return "application/javascript";
    case ".ts": case ".tsx": return "application/typescript";
    case ".html": case ".htm": return "text/html";
    case ".css": return "text/css";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".webp": return "image/webp";
    case ".pdf": return "application/pdf";
    case ".zip": return "application/zip";
    case ".tar": return "application/x-tar";
    case ".gz": case ".tgz": return "application/gzip";
    case ".csv": return "text/csv";
    case ".xml": return "application/xml";
    case ".yaml": case ".yml": return "application/yaml";
    case ".sh": return "application/x-sh";
    case ".py": return "text/x-python";
    default: return null;
  }
}

async function streamCloudRun(args: {
  requestId: string;
  agentId: string;
  run: SdkRun;
  modelSdkId?: string | null;
}): Promise<unknown> {
  const { requestId, agentId, run } = args;
  const runId = run.id;
  cloudRuns.set(runId, { run, agentId });
  const statusOff = run.onDidChangeStatus((status) => {
    post({
      type: "run_status",
      runtime: "cloud",
      agentId,
      runId,
      status,
      requestId,
    });
  });
  post({
    type: "run_started",
    agentId,
    runId,
    modelSdkId: args.modelSdkId ?? null,
    runtime: "cloud",
    requestId,
  });
  try {
    try {
      for await (const event of run.stream()) {
        post({
          type: "sdk_event",
          event,
          runtime: "cloud",
          runId,
          agentId,
          requestId,
        });
      }
    } catch (streamError) {
      post({
        type: "log",
        level: "warn",
        message: "Cursor SDK cloud stream errored mid-iteration",
        detail: { runId, agentId, error: errorMessage(streamError) },
      });
    }
    const result = await run.wait();
    post({
      type: "run_result",
      result,
      runtime: "cloud",
      runId,
      agentId,
      requestId,
    });
    return { agentId, runId, status: result.status, result } satisfies CursorSdkCloudRunStartedResult & { result: unknown };
  } finally {
    statusOff();
    cloudRuns.delete(runId);
  }
}

async function handleCloudRequest(req: CursorSdkWorkerRequest): Promise<unknown> {
  const { Agent } = await getSdk();
  if (req.type === "cloud.agents.list") {
    return Agent.list({
      runtime: "cloud",
      apiKey: req.payload.apiKey?.trim() || undefined,
      includeArchived: req.payload.includeArchived,
      limit: req.payload.limit,
      cursor: req.payload.cursor ?? undefined,
    });
  }
  if (req.type === "cloud.runs.list") {
    return Agent.listRuns(req.payload.agentId, {
      runtime: "cloud",
      apiKey: req.payload.apiKey?.trim() || undefined,
      limit: req.payload.limit,
      cursor: req.payload.cursor ?? undefined,
    });
  }
  if (req.type === "cloud.run.get") {
    return Agent.getRun(req.payload.runId, {
      runtime: "cloud",
      agentId: req.payload.agentId,
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
  }
  if (req.type === "cloud.agent.get") {
    return Agent.get(req.payload.agentId, {
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
  }
  if (req.type === "cloud.agent.archive") {
    await Agent.archive(req.payload.agentId, { apiKey: req.payload.apiKey?.trim() || undefined });
    return {};
  }
  if (req.type === "cloud.agent.unarchive") {
    await Agent.unarchive(req.payload.agentId, { apiKey: req.payload.apiKey?.trim() || undefined });
    return {};
  }
  if (req.type === "cloud.agent.delete") {
    await Agent.delete(req.payload.agentId, { apiKey: req.payload.apiKey?.trim() || undefined });
    return {};
  }
  if (req.type === "cloud.send.stream") {
    const cloudAgent = await Agent.create(buildCloudCreateOptions(req.payload));
    const sendOpts = req.payload.modelSdkId?.trim() ? { model: { id: req.payload.modelSdkId.trim() } } : undefined;
    const run = await cloudAgent.send(req.payload.promptText, sendOpts);
    const result = await streamCloudRun({
      requestId: req.requestId,
      agentId: cloudAgent.agentId,
      run,
      modelSdkId: req.payload.modelSdkId,
    });
    try {
      const info = await Agent.get(cloudAgent.agentId, { apiKey: req.payload.apiKey?.trim() || undefined });
      return {
        ...(result && typeof result === "object" ? result as Record<string, unknown> : {}),
        agentName: typeof info.name === "string" ? info.name : null,
      };
    } catch {
      return result;
    }
  }
  if (req.type === "cloud.followup") {
    const cloudAgent = await Agent.resume(req.payload.agentId, buildCloudResumeOptions(req.payload));
    const sendOpts = req.payload.modelSdkId?.trim() ? { model: { id: req.payload.modelSdkId.trim() } } : undefined;
    const run = await cloudAgent.send(req.payload.promptText, sendOpts);
    const result = await streamCloudRun({
      requestId: req.requestId,
      agentId: cloudAgent.agentId,
      run,
      modelSdkId: req.payload.modelSdkId,
    });
    try {
      const info = await Agent.get(cloudAgent.agentId, { apiKey: req.payload.apiKey?.trim() || undefined });
      return {
        ...(result && typeof result === "object" ? result as Record<string, unknown> : {}),
        agentName: typeof info.name === "string" ? info.name : null,
      };
    } catch {
      return result;
    }
  }
  if (req.type === "cloud.run.cancel") {
    const entry = cloudRuns.get(req.payload.runId);
    if (entry) {
      await entry.run.cancel();
      return { ok: true };
    }
    const run = await Agent.getRun(req.payload.runId, {
      runtime: "cloud",
      agentId: req.payload.agentId,
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
    await run.cancel();
    return { ok: true, viaGetRun: true };
  }
  if (req.type === "cloud.run.attach") {
    const run = await Agent.getRun(req.payload.runId, {
      runtime: "cloud",
      agentId: req.payload.agentId,
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
    return streamCloudRun({
      requestId: req.requestId,
      agentId: req.payload.agentId,
      run,
      modelSdkId: null,
    });
  }
  if (req.type === "cloud.run.conversation") {
    const run = await Agent.getRun(req.payload.runId, {
      runtime: "cloud",
      agentId: req.payload.agentId,
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
    return run.conversation();
  }
  if (req.type === "cloud.artifacts.list") {
    const cloudAgent = await Agent.resume(req.payload.agentId, {
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
    try {
      const artifacts = await cloudAgent.listArtifacts();
      const out: CursorSdkCloudArtifactDescriptor[] = artifacts.map((entry) => ({
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        updatedAt: entry.updatedAt,
      }));
      return out;
    } finally {
      try {
        await cloudAgent[Symbol.asyncDispose]?.();
      } catch {
        try { cloudAgent.close(); } catch { /* ignore */ }
      }
    }
  }
  if (req.type === "cloud.artifacts.download") {
    const cloudAgent = await Agent.resume(req.payload.agentId, {
      apiKey: req.payload.apiKey?.trim() || undefined,
    });
    try {
      const buffer = await cloudAgent.downloadArtifact(req.payload.path);
      const body: CursorSdkCloudArtifactDownloadResult = {
        path: req.payload.path,
        contents: Buffer.from(buffer).toString("base64"),
        mimeType: inferMimeType(req.payload.path),
        sizeBytes: buffer.byteLength,
      };
      return body;
    } finally {
      try {
        await cloudAgent[Symbol.asyncDispose]?.();
      } catch {
        try { cloudAgent.close(); } catch { /* ignore */ }
      }
    }
  }
  throw new Error(`Unsupported cloud request ${(req as { type: string }).type}`);
}

async function dispatch(req: CursorSdkWorkerRequest): Promise<unknown> {
  switch (req.type) {
    case "init":
      return initWorker(req.payload);
    case "send":
      return sendPrompt(req.payload);
    case "policy_update":
      await updatePolicy(req.payload);
      return {};
    case "cancel":
      await cancelRun();
      return {};
    case "dispose":
      await dispose();
      return {};
    case "catalog.models":
      return handleCatalogModels(req.payload.apiKey);
    case "catalog.repositories":
      return handleCatalogRepositories(req.payload.apiKey);
    case "cloud.agents.list":
    case "cloud.runs.list":
    case "cloud.run.get":
    case "cloud.agent.get":
    case "cloud.agent.archive":
    case "cloud.agent.unarchive":
    case "cloud.agent.delete":
    case "cloud.send.stream":
    case "cloud.followup":
    case "cloud.run.cancel":
    case "cloud.run.attach":
    case "cloud.run.conversation":
    case "cloud.artifacts.list":
    case "cloud.artifacts.download":
      return handleCloudRequest(req);
    case "hook_response": {
      const resolve = hookWaiters.get(req.requestId);
      hookWaiters.delete(req.requestId);
      resolve?.(req.payload);
      return {};
    }
  }
}

process.on("message", (raw: unknown) => {
  const req = raw as CursorSdkWorkerRequest;
  if (!req || typeof req !== "object" || !("type" in req)) return;
  void (async () => {
    if (req.type === "hook_response") {
      await dispatch(req);
      return;
    }
    try {
      const result = await dispatch(req);
      post({ type: "response", requestId: req.requestId, ok: true, result });
    } catch (error) {
      post({ type: "response", requestId: req.requestId, ok: false, error: errorMessage(error) });
    }
  })();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void dispose().finally(() => process.exit(0));
  });
}

process.on("disconnect", () => {
  void dispose().finally(() => process.exit(0));
});

post({
  type: "log",
  level: "debug",
  message: `Cursor SDK worker booted in ${process.cwd()} (${os.platform()})`,
});
