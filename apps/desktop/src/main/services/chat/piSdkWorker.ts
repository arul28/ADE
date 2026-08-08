import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PI_SDK_MIN_NODE,
  PI_SDK_PROTOCOL_VERSION,
  normalizePiSdkModelRef,
  parsePiSdkWorkerRequest,
  toPiSdkJson,
  type JsonValue,
  type PiSdkModelRef,
  type PiSdkReady,
  type PiSdkSessionTarget,
  type PiSdkWorkerInit,
  type PiSdkWorkerRequest,
  type PiSdkWorkerResponse,
} from "./piSdkProtocol";
import {
  piSessionHeaderMatchesCwd,
  readPiSessionHeader,
} from "./piSessionLease";

// Deliberately no static import (or type import) from Pi. This process is
// started by ADE and loads the user's installation only after init validation.
type PiModule = Record<string, unknown>;
type Callable = (...args: unknown[]) => unknown;
type PiSession = Record<string, unknown>;
type PiRuntime = Record<string, unknown>;
type PiSessionManager = Record<string, unknown>;

let pi: PiModule | null = null;
let piRoot: string | null = null;
let piEntry: string | null = null;
let piVersion: string | null = null;
let initState: PiSdkWorkerInit | null = null;
let modelRuntime: PiRuntime | null = null;
let sessionManager: PiSessionManager | null = null;
let session: PiSession | null = null;
let modelInventory: JsonValue[] = [];
let lastAssistantError: string | null = null;
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PI_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write"]);
let unsubscribe: (() => void) | null = null;
let disposed = false;

function post(message: PiSdkWorkerResponse): void {
  if (!process.send) return;
  // SDK events are untrusted values. Normalize them before they reach the
  // desktop process so circular values, BigInts, and Error instances cannot
  // break Node's child-process serializer.
  try {
    process.send(toPiSdkJson(message) as unknown as PiSdkWorkerResponse);
  } catch (error) {
    try {
      process.send({
        protocolVersion: PI_SDK_PROTOCOL_VERSION,
        type: "error",
        operation: "ipc.send",
        error: errorMessage(error),
      });
    } catch {
      // The parent may have disconnected while an SDK event was being emitted.
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message && message !== "Error" ? message : error.name || "Unknown Pi SDK error";
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(toPiSdkJson(error));
  } catch {
    return String(error);
  }
}

function errorDetail(error: unknown): JsonValue {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; cause?: unknown };
    return toPiSdkJson({
      name: error.name,
      ...(record.code != null ? { code: record.code } : {}),
      ...(record.status != null ? { status: record.status } : {}),
      ...(record.cause != null ? { cause: errorMessage(record.cause) } : {}),
    });
  }
  return toPiSdkJson(error);
}

function callable(value: unknown, name: string): Callable {
  if (typeof value !== "function") throw new Error(`Pi SDK export ${name} is unavailable in ${piEntry ?? "the selected package"}.`);
  return value as Callable;
}

function method(target: unknown, name: string): Callable {
  if (!target || (typeof target !== "object" && typeof target !== "function")) {
    throw new Error(`Pi SDK object is missing ${name}().`);
  }
  return callable((target as Record<string, unknown>)[name], name);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseNodeVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function isNodeSupported(): boolean {
  const actual = parseNodeVersion(process.versions.node);
  const minimum = parseNodeVersion(PI_SDK_MIN_NODE);
  return actual[0] > minimum[0]
    || (actual[0] === minimum[0] && (actual[1] > minimum[1]
      || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
}

function assertAbsolute(label: string, value: string): void {
  if (!path.isAbsolute(value)) throw new Error(`Pi SDK ${label} must be an absolute path; received "${value}".`);
}

function findPackageRoot(start: string): string | null {
  let current = path.resolve(start);
  if (!fs.existsSync(current)) current = path.dirname(current);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePackageLocation(init: PiSdkPackageLocationLike): { root: string; entry: string; version: string | null } {
  const candidateRoot = init.packageRoot ?? init.packageDir;
  if (candidateRoot) assertAbsolute("packageRoot", candidateRoot);
  if (init.packageEntry) assertAbsolute("packageEntry", init.packageEntry);
  const root = candidateRoot ? path.resolve(candidateRoot) : findPackageRoot(path.resolve(init.packageEntry!));
  if (!root) {
    throw new Error("Pi SDK package is missing. Provide an absolute packageRoot/packageDir or packageEntry for the user's @earendil-works/pi-coding-agent installation.");
  }
  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) throw new Error(`Pi SDK package is missing package.json at ${packageJsonPath}.`);
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Pi SDK package.json at ${packageJsonPath} is unreadable: ${errorMessage(error)}`);
  }

  let entry = init.packageEntry ? path.resolve(init.packageEntry) : "";
  if (!entry) {
    const main = typeof packageJson.main === "string" ? packageJson.main : "dist/index.js";
    entry = path.resolve(root, main);
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`Pi SDK package entry is missing at ${entry}. Install @earendil-works/pi-coding-agent or provide its absolute dist/index.js path.`);
  }
  return {
    root,
    entry,
    version: typeof packageJson.version === "string" ? packageJson.version : null,
  };
}

type PiSdkPackageLocationLike = Pick<PiSdkWorkerInit, "packageDir" | "packageRoot" | "packageEntry">;

function modelDescriptor(value: unknown): JsonValue | null {
  const item = record(value);
  if (!item) return null;
  const provider = nonEmpty(item.provider);
  const id = nonEmpty(item.id);
  if (!provider || !id) return null;
  const out: Record<string, JsonValue> = { provider, id };
  for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost"] as const) {
    if (item[key] !== undefined) out[key] = toPiSdkJson(item[key]);
  }
  return out;
}

function currentModelDescriptor(): JsonValue | null {
  return modelDescriptor(session?.model);
}

async function availableModels(): Promise<JsonValue[]> {
  if (!modelRuntime) throw new Error("Pi SDK model runtime is not initialized.");
  const getAvailable = (modelRuntime as Record<string, unknown>).getAvailable;
  if (typeof getAvailable !== "function") return [];
  const values = await (getAvailable as Callable).call(modelRuntime);
  modelInventory = (Array.isArray(values) ? values : []).map(modelDescriptor).filter((value): value is JsonValue => value !== null);
  return modelInventory;
}

async function authInventory(): Promise<JsonValue> {
  if (!modelRuntime) throw new Error("Pi SDK model runtime is not initialized.");
  const runtime = modelRuntime as Record<string, unknown>;
  const providersValue = typeof runtime.getProviders === "function"
    ? await (runtime.getProviders as Callable).call(modelRuntime)
    : [];
  const providers = Array.isArray(providersValue) ? providersValue : [];
  const result: Record<string, JsonValue>[] = [];
  for (const providerValue of providers) {
    const provider = record(providerValue);
    const id = nonEmpty(provider?.id);
    if (!id) continue;
    const item: Record<string, JsonValue> = {
      id,
      ...(nonEmpty(provider?.name) ? { name: nonEmpty(provider?.name)! } : {}),
    };
    try {
      const status = typeof runtime.getProviderAuthStatus === "function"
        ? await (runtime.getProviderAuthStatus as Callable).call(modelRuntime, id)
        : typeof runtime.checkAuth === "function"
          ? await (runtime.checkAuth as Callable).call(modelRuntime, id)
          : undefined;
      const statusRecord = record(status);
      if (statusRecord) {
        // Pi 0.84 reports the authoritative auth state as `configured`, with
        // `source`/`label` describing how the provider was resolved. Keep the
        // older aliases too so ADE can read compatible Pi installations without
        // manufacturing an auth result from the presence of a provider row.
        for (const key of ["configured", "authenticated", "isAuthenticated", "type", "status", "source", "label", "expiresAt"] as const) {
          if (statusRecord[key] !== undefined) item[key] = toPiSdkJson(statusRecord[key]);
        }
      }
    } catch (error) {
      item.error = errorMessage(error);
    }
    result.push(item);
  }
  return result;
}

function modelText(ref: PiSdkModelRef): string {
  const normalized = normalizePiSdkModelRef(ref);
  return `${normalized.provider}/${normalized.id}`;
}

async function resolveModel(ref: PiSdkModelRef): Promise<unknown> {
  if (!pi || !modelRuntime) throw new Error("Pi SDK is not initialized.");
  const normalized = normalizePiSdkModelRef(ref);
  const resolver = pi.resolveCliModel;
  if (typeof resolver === "function") {
    const result = await Promise.resolve((resolver as Callable).call(null, {
      cliModel: `${normalized.provider}/${normalized.id}`,
      modelRuntime,
    }));
    const resolved = record(result);
    if (resolved?.error) throw new Error(`Pi model "${modelText(ref)}" is invalid: ${String(resolved.error)}`);
    if (resolved?.model) return resolved.model;
  }
  const getModel = method(modelRuntime, "getModel");
  const model = await Promise.resolve(getModel.call(modelRuntime, normalized.provider, normalized.id));
  if (!model) throw new Error(`Pi model "${modelText(ref)}" is unavailable. Check the provider/model id and credentials in the user's Pi profile.`);
  return model;
}

function sessionTarget(init: PiSdkWorkerInit): PiSdkSessionTarget {
  return init.session ?? {};
}

function sessionFileIsAuthorized(filePath: string, sessionDir: string | null): boolean {
  if (!sessionDir) return true;
  try {
    const resolvedFile = fs.realpathSync(filePath);
    const resolvedDir = fs.realpathSync(sessionDir);
    const relative = path.relative(resolvedDir, resolvedFile);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function validatedSessionFile(
  filePath: string,
  sessionDir: string | null,
  expectedId: string | null,
  expectedCwd: string,
): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(filePath));
  } catch {
    return null;
  }
  if (!sessionFileIsAuthorized(resolved, sessionDir)) return null;
  // A native file may be inside the authorized Pi root while belonging to a
  // different project. Require a non-empty, exact normalized header cwd at
  // this worker boundary; blank cwd must never act as a wildcard.
  const header = readPiSessionHeader(resolved);
  if (!header || !piSessionHeaderMatchesCwd(header, expectedCwd)) return null;
  if (expectedId && header.id !== expectedId) return null;
  return resolved;
}

async function openSessionManager(init: PiSdkWorkerInit, sdk: PiModule): Promise<PiSessionManager> {
  const SessionManager = sdk.SessionManager;
  if (!SessionManager || typeof SessionManager !== "function") throw new Error("Pi SDK export SessionManager is unavailable.");
  const manager = SessionManager as unknown as Record<string, unknown>;
  const target = sessionTarget(init);
  const sessionFile = nonEmpty(target.sessionFile);
  const requestedId = nonEmpty(target.sessionId);
  const resume = target.resume;
  const resumeRecord = record(resume);
  const resumeFile = sessionFile ?? nonEmpty(resumeRecord?.sessionFile);
  const resumeId = requestedId ?? nonEmpty(resumeRecord?.sessionId);
  const sessionDir = nonEmpty(init.sessionDir);

  try {
    if (resumeFile) {
      assertAbsolute("sessionFile", resumeFile);
      const authorizedFile = validatedSessionFile(resumeFile, sessionDir, resumeId, init.cwd);
      // A stale path can accompany a durable session id after a project move or
      // remote handoff. Prefer the id lookup in that case; never create a new
      // session while a persisted native pointer is present.
      if (authorizedFile) {
        return method(manager, "open").call(manager, authorizedFile, sessionDir ?? path.dirname(authorizedFile), init.cwd) as PiSessionManager;
      }
      if (!resumeId) {
        throw new Error(`Pi session file "${resumeFile}" is missing, outside the authorized session directory, or invalid.`);
      }
    }
    if (resumeId) {
      const list = await method(manager, "list").call(manager, init.cwd, sessionDir ?? undefined);
      const found = (Array.isArray(list) ? list : []).find((item) => record(item)?.id === resumeId);
      const foundPath = nonEmpty(record(found)?.path);
      const authorizedFoundPath = foundPath
        ? validatedSessionFile(foundPath, sessionDir, resumeId, init.cwd)
        : null;
      if (!authorizedFoundPath) {
        throw new Error(`Pi session "${resumeId}" was not found in the authorized session directory.`);
      }
      return method(manager, "open").call(manager, authorizedFoundPath, sessionDir ?? path.dirname(authorizedFoundPath), init.cwd) as PiSessionManager;
    }
    if (resume === true) {
      return method(manager, "continueRecent").call(manager, init.cwd, sessionDir ?? undefined) as PiSessionManager;
    }
    return method(manager, "create").call(manager, init.cwd, sessionDir ?? undefined) as PiSessionManager;
  } catch (error) {
    throw new Error(`Pi session could not be opened${resumeFile ? ` at ${resumeFile}` : ""}: ${errorMessage(error)}`);
  }
}

function makeResourceLoader(init: PiSdkWorkerInit, sdk: PiModule): unknown {
  const Loader = sdk.DefaultResourceLoader;
  if (typeof Loader !== "function") throw new Error("Pi SDK export DefaultResourceLoader is unavailable.");
  const rawSkillRoots = init.skillsEnv?.ADE_AGENT_SKILLS_DIRS ?? "";
  const additionalSkillPaths = rawSkillRoots
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new (Loader as new (options: Record<string, unknown>) => unknown)({
    cwd: init.cwd,
    agentDir: init.agentDir,
    // Pi extensions can execute arbitrary code and can install custom UI
    // handlers. Native ADE chat deliberately keeps them out of the worker;
    // the Pi CLI remains the escape hatch for extension-owned experiences.
    noExtensions: true,
    // Do not inherit project/user Pi skill settings. ADE passes only its
    // explicitly approved skill roots below; the CLI remains the escape hatch
    // for Pi-native skill discovery.
    noSkills: true,
    ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}),
    ...(init.systemPrompt != null ? { systemPromptOverride: () => init.systemPrompt ?? "" } : {}),
  });
}

function ready(): PiSdkReady {
  if (!initState || !piRoot || !piEntry || (!session && !initState.inventoryOnly)) {
    throw new Error("Pi SDK worker is not initialized.");
  }
  const manager = sessionManager as Record<string, unknown> | null;
  const sessionFileValue = session?.sessionFile
    ?? (manager && typeof manager.getSessionFile === "function" ? (manager.getSessionFile as Callable).call(manager) : undefined);
  const sessionIdValue = session?.sessionId
    ?? (manager && typeof manager.getSessionId === "function" ? (manager.getSessionId as Callable).call(manager) : undefined);
  return {
    protocolVersion: PI_SDK_PROTOCOL_VERSION,
    packageRoot: piRoot,
    packageEntry: piEntry,
    version: piVersion ?? (typeof pi?.VERSION === "string" ? pi.VERSION : null),
    sessionFile: typeof sessionFileValue === "string" ? sessionFileValue : null,
    sessionId: typeof sessionIdValue === "string" ? sessionIdValue : null,
    currentModel: currentModelDescriptor(),
    thinkingLevel: typeof session?.thinkingLevel === "string" ? session.thinkingLevel : null,
    availableModels: modelInventory,
  };
}

async function initWorker(init: PiSdkWorkerInit): Promise<PiSdkReady> {
  if (!isNodeSupported()) {
    throw new Error(`Pi SDK requires Node >= ${PI_SDK_MIN_NODE}; ADE worker is running Node ${process.versions.node}. Start ADE with a newer Node runtime.`);
  }
  assertAbsolute("cwd", init.cwd);
  assertAbsolute("agentDir", init.agentDir);
  if (init.thinkingLevel && !VALID_THINKING_LEVELS.has(init.thinkingLevel.trim())) {
    throw new Error(`Invalid Pi thinking level "${init.thinkingLevel}". Use off, minimal, low, medium, high, xhigh, or max.`);
  }
  const requestedTools = init.tools ?? ["read"];
  const invalidTools = requestedTools.filter((tool) => !PI_BUILTIN_TOOLS.has(tool));
  if (invalidTools.length) {
    throw new Error(`Pi SDK only permits the built-in tools read, bash, edit, and write; received ${invalidTools.join(", ")}.`);
  }
  if (init.sessionDir) assertAbsolute("sessionDir", init.sessionDir);
  const location = resolvePackageLocation(init);
  piRoot = location.root;
  piEntry = location.entry;
  piVersion = location.version;
  initState = init;
  process.env.PI_CODING_AGENT_DIR = init.agentDir;
  if (init.sessionDir) process.env.PI_CODING_AGENT_SESSION_DIR = init.sessionDir;
  for (const [key, value] of Object.entries(init.skillsEnv ?? {})) process.env[key] = value;
  fs.mkdirSync(init.agentDir, { recursive: true });
  if (init.sessionDir) fs.mkdirSync(init.sessionDir, { recursive: true });

  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "initializing" });
  try {
    const imported = await import(pathToFileURL(location.entry).href);
    pi = imported as PiModule;
  } catch (error) {
    throw new Error(`Unable to load Pi SDK from ${location.entry}: ${errorMessage(error)}`);
  }
  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "package_loaded", detail: toPiSdkJson({ version: piVersion, entry: location.entry }) });

  const Runtime = pi.ModelRuntime;
  if (!Runtime || typeof Runtime !== "function") throw new Error("The selected Pi package does not export ModelRuntime.");
  const createRuntime = method(Runtime, "create");
  modelRuntime = await createRuntime.call(Runtime, {
    authPath: path.join(init.agentDir, "auth.json"),
    modelsPath: path.join(init.agentDir, "models.json"),
    modelsStorePath: path.join(init.agentDir, "models-store.json"),
  }) as PiRuntime;

  if (init.inventoryOnly) {
    const result = ready();
    result.availableModels = await availableModels();
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "ready", ready: result });
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "ready" });
    return result;
  }

  sessionManager = await openSessionManager(init, pi);
  const selectedModel = init.modelRef == null ? undefined : await resolveModel(init.modelRef);
  const resourceLoader = makeResourceLoader(init, pi);
  if (resourceLoader && typeof (resourceLoader as Record<string, unknown>).reload === "function") {
    await method(resourceLoader, "reload").call(resourceLoader);
  }
  const createSession = callable(pi.createAgentSession, "createAgentSession");
  const options: Record<string, unknown> = {
    cwd: init.cwd,
    agentDir: init.agentDir,
    modelRuntime,
    sessionManager,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(init.thinkingLevel ? { thinkingLevel: init.thinkingLevel } : {}),
    ...(resourceLoader ? { resourceLoader } : {}),
    tools: init.tools ?? ["read"],
    ...(init.noTools ? { noTools: init.noTools } : {}),
  };
  const created = record(await createSession(options));
  session = record(created?.session);
  if (!session) throw new Error("Pi SDK createAgentSession returned no session.");
  const subscribe = method(session, "subscribe");
  const listener = (event: unknown): void => {
    const eventRecord = record(event);
    if (eventRecord?.type === "message_end") {
      const message = record(eventRecord.message);
      if (message?.role === "assistant") {
        if (message.stopReason === "error") {
          lastAssistantError = nonEmpty(message.errorMessage) ?? "Pi provider returned an assistant error.";
        } else {
          lastAssistantError = null;
        }
      }
    }
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "sdk_event", event: toPiSdkJson(event) });
  };
  unsubscribe = (subscribe.call(session, listener) as (() => void) | undefined) ?? null;
  const result = ready();
  result.availableModels = await availableModels();
  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "ready", ready: result });
  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "ready", detail: toPiSdkJson({ sessionId: result.sessionId, sessionFile: result.sessionFile }) });
  return result;
}

function requireSession(): PiSession {
  if (!session || !modelRuntime || disposed) throw new Error("Pi SDK worker is not initialized or has been disposed.");
  return session;
}

function imageContents(images: Array<{ data: string; mimeType: string }> | undefined): unknown[] | undefined {
  return images?.length
    ? images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))
    : undefined;
}

async function sendPrompt(request: Extract<PiSdkWorkerRequest, { type: "send" }>): Promise<JsonValue> {
  const active = requireSession();
  lastAssistantError = null;
  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "prompt_started", requestId: request.requestId });
  try {
    const promptOptions: Record<string, unknown> = {};
    const images = imageContents(request.payload.images);
    if (images) promptOptions.images = images;
    if (request.payload.streamingBehavior) promptOptions.streamingBehavior = request.payload.streamingBehavior;
    await method(active, "prompt").call(active, request.payload.prompt, promptOptions);
    if (lastAssistantError) throw new Error(lastAssistantError);
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "prompt_finished", requestId: request.requestId });
    return toPiSdkJson({ sessionFile: ready().sessionFile, sessionId: ready().sessionId });
  } catch (error) {
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "prompt_failed", requestId: request.requestId, detail: errorDetail(error) });
    throw error;
  }
}

async function setModel(ref: PiSdkModelRef): Promise<PiSdkReady> {
  const active = requireSession();
  const model = await resolveModel(ref);
  await method(active, "setModel").call(active, model);
  const result = ready();
  result.availableModels = await availableModels();
  return result;
}

async function setThinking(level: string): Promise<PiSdkReady> {
  const active = requireSession();
  const normalized = level.trim();
  if (!normalized || !VALID_THINKING_LEVELS.has(normalized)) {
    throw new Error(`Invalid Pi thinking level "${level}". Use off, minimal, low, medium, high, xhigh, or max.`);
  }
  await method(active, "setThinkingLevel").call(active, normalized);
  return ready();
}

async function compact(customInstructions?: string | null): Promise<JsonValue> {
  const active = requireSession();
  const compactMethod = (active as Record<string, unknown>).compact;
  if (typeof compactMethod !== "function") throw new Error("This Pi SDK build does not expose session.compact().");
  return toPiSdkJson(await (compactMethod as Callable).call(active, customInstructions ?? undefined));
}

async function disposeWorker(): Promise<void> {
  if (disposed) return;
  disposed = true;
  unsubscribe?.();
  unsubscribe = null;
  try {
    if (session && typeof session.abort === "function") await (session.abort as Callable).call(session);
  } catch {
    // Disposal must continue even if a provider is already gone.
  }
  try {
    if (session && typeof session.dispose === "function") {
      await Promise.resolve((session.dispose as Callable).call(session));
    }
  } catch {
    // ignore
  }
  session = null;
  sessionManager = null;
  modelRuntime = null;
  modelInventory = [];
}

async function dispatch(request: PiSdkWorkerRequest): Promise<JsonValue | undefined> {
  switch (request.type) {
    case "init": return toPiSdkJson(await initWorker(request.payload));
    case "send": return await sendPrompt(request);
    case "steer": {
      const active = requireSession();
      await method(active, "steer").call(active, request.payload.prompt, imageContents(request.payload.images));
      return null;
    }
    case "follow_up": {
      const active = requireSession();
      await method(active, "followUp").call(active, request.payload.prompt, imageContents(request.payload.images));
      return null;
    }
    case "abort": await method(requireSession(), "abort").call(requireSession()); post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "aborted", requestId: request.requestId }); return null;
    case "set_model": return toPiSdkJson(await setModel(request.payload.modelRef));
    case "set_thinking": return toPiSdkJson(await setThinking(request.payload.thinkingLevel));
    case "compact": return await compact(request.payload?.customInstructions);
    case "models": return toPiSdkJson(await availableModels());
    case "auth": return await authInventory();
    case "dispose": await disposeWorker(); post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "disposed", requestId: request.requestId }); return null;
  }
}

post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "worker_started" });
process.on("message", (raw: unknown) => {
  const validationError = raw && typeof raw === "object" && "type" in raw
    ? null
    : "Pi SDK worker received a malformed message.";
  const request = validationError ? null : parsePiSdkWorkerRequest(raw);
  if (!request) {
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "error", operation: "ipc.receive", error: validationError ?? "Invalid Pi SDK worker request." });
    return;
  }
  void dispatch(request)
    .then((result) => {
      post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "response", requestId: request.requestId, ok: true, ...(result === undefined ? {} : { result }) });
      if (request.type === "dispose") setImmediate(() => process.exit(0));
    })
    .catch((error) => {
      post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "error", operation: request.type, requestId: request.requestId, error: errorMessage(error), detail: errorDetail(error) });
      post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "response", requestId: request.requestId, ok: false, error: errorMessage(error), detail: errorDetail(error) });
    });
});

process.once("disconnect", () => {
  void disposeWorker().finally(() => process.exit(0));
});
