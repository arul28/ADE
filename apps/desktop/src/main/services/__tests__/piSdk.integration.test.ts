import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { piModelDescriptorsFromInventory, probePiProfileInventory, resolvePiInstallation } from "../ai/piInstallation";
import {
  acquirePiSdkConnection,
  releasePiSdkConnection,
  type PiSdkPooled,
} from "../chat/piSdkPool";

const runInstalledPi = process.env.ADE_TEST_PI_SDK_INTEGRATION === "1";
const describeInstalledPi = runInstalledPi ? describe : describe.skip;
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PI_PACKAGE_ROOT = process.env.ADE_PI_PACKAGE_ROOT?.trim() || undefined;

type CompletionRequest = {
  body: Record<string, unknown>;
  response: http.ServerResponse;
};

type Fixture = {
  root: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  modelPath: string;
};

const tempRoots: string[] = [];
const activeConnections: Array<{ poolKey: string; generation: number; pooled: PiSdkPooled }> = [];
let server: http.Server;
let serverBaseUrl = "";
let requestQueue: CompletionRequest[] = [];
let requestWaiters: Array<(request: CompletionRequest) => void> = [];
let rejectRequests = false;

function writeCompletion(response: http.ServerResponse, model: string, text = "Pi says hello"): void {
  if (response.writableEnded) return;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const emit = (payload: Record<string, unknown>) => {
    response.write(`data: ${JSON.stringify({
      id: "ade-pi-test-completion",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      ...payload,
    })}\n\n`);
  };
  emit({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
  emit({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
  response.end("data: [DONE]\n\n");
}

function queueRequest(request: CompletionRequest): void {
  const waiter = requestWaiters.shift();
  if (waiter) waiter(request);
  else requestQueue.push(request);
}

async function nextRequest(): Promise<CompletionRequest> {
  const queued = requestQueue.shift();
  if (queued) return queued;
  return await new Promise<CompletionRequest>((resolve) => requestWaiters.push(resolve));
}

function textFromMessages(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latestUser = [...messages].reverse().find((message) => {
    return message && typeof message === "object" && (message as Record<string, unknown>).role === "user";
  });
  return JSON.stringify(latestUser ?? "");
}

function createFixture(options?: { configured?: boolean; modelId?: string }): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-sdk-integration-"));
  tempRoots.push(root);
  const cwd = path.join(root, "worktree");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const modelId = options?.modelId ?? "test-model";
  const provider: Record<string, unknown> = {
    baseUrl: `${serverBaseUrl}/v1`,
    api: "openai-completions",
    models: [{
      id: modelId,
      name: "ADE Pi Integration Model",
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    }],
  };
  if (options?.configured !== false) provider.apiKey = "ade-local-test-key";
  const modelPath = path.join(agentDir, "models.json");
  fs.writeFileSync(modelPath, JSON.stringify({ providers: { "ade-local": provider } }));
  return { root, cwd, agentDir, sessionDir, modelPath };
}

function installedPiArgs(fixture: Fixture, poolKey: string, options?: {
  modelId?: string;
  tools?: string[];
  session?: { sessionFile?: string; sessionId?: string };
}): {
  poolKey: string;
  packageRoot: string;
  packageEntry: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  modelRef: { provider: string; id: string };
  thinkingLevel: string;
  systemPrompt: string;
  tools?: string[];
  session?: { sessionFile?: string; sessionId?: string };
  baseEnv: NodeJS.ProcessEnv;
} {
  const installation = resolvePiInstallation({
    ...process.env,
    ...(PI_PACKAGE_ROOT ? { ADE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT } : {}),
    PI_CODING_AGENT_DIR: fixture.agentDir,
  });
  if (!installation.packageRoot || !installation.packageEntry) {
    throw new Error(installation.blocker ?? "Installed Pi SDK package was not found.");
  }
  const args = {
    poolKey,
    packageRoot: installation.packageRoot,
    packageEntry: installation.packageEntry,
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    sessionDir: fixture.sessionDir,
    modelRef: { provider: "ade-local", id: options?.modelId ?? "test-model" },
    thinkingLevel: "off",
    systemPrompt: "You are the isolated ADE Pi integration test model.",
    ...(options?.tools ? { tools: options.tools } : {}),
    ...(options?.session ? { session: options.session } : {}),
    baseEnv: {
      PATH: process.env.PATH ?? "",
      HOME: fixture.root,
      USERPROFILE: fixture.root,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      PI_OFFLINE: "1",
    },
  };
  return args;
}

async function acquireTracked(fixture: Fixture, poolKey: string, options?: Parameters<typeof installedPiArgs>[2]) {
  const connection = await acquirePiSdkConnection(installedPiArgs(fixture, poolKey, options));
  const tracked = { ...connection, poolKey };
  activeConnections.push(tracked);
  return tracked;
}

function sessionFiles(fixture: Fixture): string[] {
  return fs.readdirSync(fixture.sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(fixture.sessionDir, name))
    .filter((filePath) => fs.lstatSync(filePath).isFile());
}

async function disposeConnection(connection: { poolKey: string; generation: number; pooled: PiSdkPooled }): Promise<void> {
  releasePiSdkConnection(connection.poolKey, connection.generation);
  await connection.pooled.waitForExit();
}

describeInstalledPi("installed Pi SDK worker", () => {
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const entry = { body, response };
        queueRequest(entry);
        if (rejectRequests || textFromMessages(body).includes("auth-failure")) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "invalid local test credential" } }));
          return;
        }
        if (!textFromMessages(body).includes("abort-me")) {
          writeCompletion(response, typeof body.model === "string" ? body.model : "test-model");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pi integration server did not expose a TCP port.");
    serverBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    requestQueue = [];
    requestWaiters = [];
    rejectRequests = false;
  });

  afterEach(async () => {
    for (const connection of activeConnections.splice(0).reverse()) {
      try {
        releasePiSdkConnection(connection.poolKey, connection.generation);
        await connection.pooled.waitForExit();
      } catch {
        // The worker may already have invalidated its pool generation.
      }
    }
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("inventories the installed Pi SDK in an isolated worker without creating a session", async () => {
    const fixture = createFixture();
    const installation = resolvePiInstallation({
      ...process.env,
      ...(PI_PACKAGE_ROOT ? { ADE_PI_PACKAGE_ROOT: PI_PACKAGE_ROOT } : {}),
      PI_CODING_AGENT_DIR: fixture.agentDir,
    });
    const inventory = await probePiProfileInventory(installation);
    expect(inventory.stale).toBe(false);
    expect(inventory.availableModelIds).toContain("pi/default/ade-local/test-model");
    expect(piModelDescriptorsFromInventory(inventory)[0]).toMatchObject({
      providerRoute: "pi-sdk",
      piProviderId: "ade-local",
      piModelId: "test-model",
    });
    expect(sessionFiles(fixture)).toEqual([]);
  });

  it("initializes an isolated profile, prompts with an image, reports auth, and preserves thinking levels", async () => {
    const fixture = createFixture();
    const connection = await acquireTracked(fixture, `integration:${Date.now()}`);
    expect(connection.pooled.ready?.version).toBeTruthy();
    expect(connection.pooled.availableModels.some((model) => JSON.stringify(model).includes("ade-local"))).toBe(true);

    const auth = await connection.pooled.requestAuth();
    expect(JSON.stringify(auth)).toContain("ade-local");
    expect(JSON.stringify(auth)).toContain("configured");
    expect(JSON.stringify(auth)).toContain("models_json_key");

    await connection.pooled.sendPrompt({
      prompt: "hello with an image",
      images: [{ data: ONE_PIXEL_PNG, mimeType: "image/png" }],
    });
    const request = await nextRequest();
    expect(JSON.stringify(request.body.messages)).toContain(ONE_PIXEL_PNG);
    const toolNames = ((request.body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name));
    expect(toolNames).toEqual(["read"]);

    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const ready = await connection.pooled.setThinking(level);
      expect(ready.thinkingLevel).toBe(level);
    }

    const sessionFile = connection.pooled.sessionFile;
    const sessionId = connection.pooled.sessionId;
    expect(sessionFile && fs.existsSync(sessionFile)).toBe(true);
    expect(sessionId).toBeTruthy();
    const header = JSON.parse(fs.readFileSync(sessionFile!, "utf8").split(/\r?\n/u, 1)[0]!) as { type: string; id: string };
    expect(header).toMatchObject({ type: "session", id: sessionId });
  });

  it("resumes by header-authoritative id and explicit file, including a stale file pointer", async () => {
    const fixture = createFixture();
    const firstKey = `resume:first:${Date.now()}`;
    const first = await acquireTracked(fixture, firstKey);
    await first.pooled.sendPrompt({ prompt: "persist this native session" });
    await nextRequest();
    const original = { sessionFile: first.pooled.sessionFile!, sessionId: first.pooled.sessionId! };
    expect(fs.existsSync(original.sessionFile)).toBe(true);
    await disposeConnection(first);
    expect(fs.existsSync(original.sessionFile)).toBe(true);

    const byFile = await acquireTracked(fixture, `resume:file:${Date.now()}`, { session: original });
    expect(fs.realpathSync(byFile.pooled.sessionFile!)).toBe(fs.realpathSync(original.sessionFile));
    expect(byFile.pooled.sessionId).toBe(original.sessionId);
    await disposeConnection(byFile);

    const stalePointer = await acquireTracked(fixture, `resume:stale:${Date.now()}`, {
      session: { sessionFile: path.join(fixture.sessionDir, "missing.jsonl"), sessionId: original.sessionId },
    });
    expect(fs.realpathSync(stalePointer.pooled.sessionFile!)).toBe(fs.realpathSync(original.sessionFile));
    expect(stalePointer.pooled.sessionId).toBe(original.sessionId);
  });

  it("rejects invalid and unauthorized resume pointers without silently creating a new session", async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, "outside.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify({ type: "session", id: "outside-id", cwd: fixture.cwd })}\n`);
    const before = sessionFiles(fixture);
    await expect(acquirePiSdkConnection(installedPiArgs(fixture, `invalid:outside:${Date.now()}`, {
      session: { sessionFile: outside },
    }))).rejects.toThrow(/missing|outside|invalid/iu);
    await expect(acquirePiSdkConnection(installedPiArgs(fixture, `invalid:relative:${Date.now()}`, {
      session: { sessionFile: "relative.jsonl" },
    }))).rejects.toThrow(/absolute/iu);
    expect(sessionFiles(fixture)).toEqual(before);

    if (process.platform !== "win32") {
      const symlink = path.join(fixture.sessionDir, "linked.jsonl");
      fs.symlinkSync(outside, symlink);
      await expect(acquirePiSdkConnection(installedPiArgs(fixture, `invalid:symlink:${Date.now()}`, {
        session: { sessionFile: symlink },
      }))).rejects.toThrow(/missing|outside|invalid/iu);
      expect(sessionFiles(fixture)).toEqual(before);
    }
  });

  it("allows explicit tools while keeping the default worker read-only", async () => {
    const fixture = createFixture();
    const readOnly = await acquireTracked(fixture, `tools:read:${Date.now()}`);
    await readOnly.pooled.sendPrompt({ prompt: "read-only" });
    const readOnlyRequest = await nextRequest();
    const defaultTools = ((readOnlyRequest.body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name));
    expect(defaultTools).toEqual(["read"]);
    await disposeConnection(readOnly);

    const explicit = await acquireTracked(fixture, `tools:all:${Date.now()}`, {
      tools: ["read", "bash", "edit", "write"],
    });
    await explicit.pooled.sendPrompt({ prompt: "explicit tools" });
    const explicitRequest = await nextRequest();
    const explicitTools = ((explicitRequest.body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name));
    expect(explicitTools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
  });

  it("reports provider auth failures, aborts a hanging prompt, and cleans up the worker", async () => {
    const fixture = createFixture();
    const connection = await acquireTracked(fixture, `failure:${Date.now()}`);
    rejectRequests = true;
    await expect(connection.pooled.sendPrompt({ prompt: "auth-failure" })).rejects.toThrow(/invalid local test credential|401|unauthorized/iu);
    await nextRequest();
    rejectRequests = false;

    const hangingPrompt = connection.pooled.sendPrompt({ prompt: "abort-me" });
    const hangingRequest = await nextRequest();
    expect(hangingRequest.body).toBeTruthy();
    await connection.pooled.abort();
    await expect(hangingPrompt).resolves.toMatchObject({ sessionFile: expect.any(String), sessionId: expect.any(String) });
    await connection.pooled.sendPrompt({ prompt: "after abort" });
    await nextRequest();
  });
});
