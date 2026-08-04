#!/usr/bin/env node

import cp from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const VALID_PROVIDERS = ["claude", "codex", "opencode", "cursor", "droid"];
const DEFAULT_CODEX_REASONING_EFFORT = "medium";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");

function usage() {
  return `
Usage:
  node ./scripts/audit-chat-model-runtime.mjs [options]

Modes:
  --mode=list        Print advertised models and reasoning options.
  --mode=dry-run    Build launch payloads and verify expected model/reasoning fields. Default.
  --mode=smoke      Use the ADE preload over CDP to create, verify, and clean up chat sessions.

Catalog sources:
  --source=registry     Read src/shared/modelRegistry.ts. Default for list/dry-run.
  --source=chat-models  Read window.ade.agentChat.models via an Electron renderer.
  --source=auto         registry for list/dry-run, chat-models for smoke.

Filters and limits:
  --providers=claude,codex,opencode,cursor,droid
  --provider=claude                 May be repeated.
  --max-per-provider=2              Limit models per provider.
  --max-reasoning-per-model=1       Limit reasoning efforts per model.
  --max-cases=20                    Limit total launch cases.

Smoke options:
  --cdp-port=9222        Existing ADE Electron CDP port.
  --start-dev            Start npm run dev and stop it before exit.
  --project-root=<path>  Project to open before creating sessions. Default: repository root.
  --lane-id=<id>         Lane to use. Default: primary/current project lane.
  --send                 Also send a tiny prompt. This can spend provider quota.
  --send-text=<text>     Prompt used with --send.
  --timeout-ms=30000     Per-operation timeout inside the renderer.

Other:
  --activate-runtime     Pass activateRuntime to chat.models endpoint.
  --json                 Print machine-readable JSON.
  --verbose              Print per-case details.
  --help                 Show this help.
`.trim();
}

function parseArgs(argv) {
  const options = {
    mode: "dry-run",
    source: "auto",
    providerValues: [],
    maxPerProvider: Number.POSITIVE_INFINITY,
    maxReasoningPerModel: Number.POSITIVE_INFINITY,
    maxCases: Number.POSITIVE_INFINITY,
    cdpPort: parseFirstValidPort([
      process.env.ADE_MODEL_AUDIT_CDP_PORT,
      process.env.ADE_ELECTRON_REMOTE_DEBUGGING_PORT,
      process.env.ADE_APP_CONTROL_CDP_PORT,
    ]),
    startDev: false,
    projectRoot: repoRoot,
    laneId: null,
    send: false,
    sendText: "ADE model runtime smoke. Reply with OK only.",
    timeoutMs: 30_000,
    activateRuntime: false,
    json: false,
    verbose: false,
    help: false,
  };

  const readValue = (arg, index) => {
    const eq = arg.indexOf("=");
    if (eq >= 0) return { value: arg.slice(eq + 1), consumed: 0 };
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    return { value: argv[index + 1], consumed: 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--list") {
      options.mode = "list";
      continue;
    }
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--smoke" || arg === "--launch") {
      options.mode = "smoke";
      continue;
    }
    if (arg === "--start-dev") {
      options.startDev = true;
      continue;
    }
    if (arg === "--send") {
      options.send = true;
      continue;
    }
    if (arg === "--activate-runtime") {
      options.activateRuntime = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }

    const key = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (key === "--mode") {
      const read = readValue(arg, index);
      options.mode = read.value;
      index += read.consumed;
      continue;
    }
    if (key === "--source") {
      const read = readValue(arg, index);
      options.source = read.value;
      index += read.consumed;
      continue;
    }
    if (key === "--providers" || key === "--provider") {
      const read = readValue(arg, index);
      options.providerValues.push(read.value);
      index += read.consumed;
      continue;
    }
    if (key === "--max-per-provider") {
      const read = readValue(arg, index);
      options.maxPerProvider = parsePositiveInteger(read.value, key);
      index += read.consumed;
      continue;
    }
    if (key === "--max-reasoning-per-model") {
      const read = readValue(arg, index);
      options.maxReasoningPerModel = parsePositiveInteger(read.value, key);
      index += read.consumed;
      continue;
    }
    if (key === "--max-cases") {
      const read = readValue(arg, index);
      options.maxCases = parsePositiveInteger(read.value, key);
      index += read.consumed;
      continue;
    }
    if (key === "--cdp-port") {
      const read = readValue(arg, index);
      options.cdpPort = parsePort(read.value, key);
      index += read.consumed;
      continue;
    }
    if (key === "--project-root") {
      const read = readValue(arg, index);
      options.projectRoot = path.resolve(read.value);
      index += read.consumed;
      continue;
    }
    if (key === "--lane-id") {
      const read = readValue(arg, index);
      options.laneId = read.value.trim() || null;
      index += read.consumed;
      continue;
    }
    if (key === "--send-text") {
      const read = readValue(arg, index);
      options.sendText = read.value;
      index += read.consumed;
      continue;
    }
    if (key === "--timeout-ms") {
      const read = readValue(arg, index);
      options.timeoutMs = parsePositiveInteger(read.value, key);
      index += read.consumed;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!["list", "dry-run", "smoke"].includes(options.mode)) {
    throw new Error(`Unsupported --mode '${options.mode}'.`);
  }
  if (!["auto", "registry", "chat-models"].includes(options.source)) {
    throw new Error(`Unsupported --source '${options.source}'.`);
  }
  options.providers = parseProviders(options.providerValues);
  options.resolvedSource = options.source === "auto"
    ? options.mode === "smoke" ? "chat-models" : "registry"
    : options.source;
  if ((options.mode === "smoke" || options.resolvedSource === "chat-models") && !Number.isFinite(options.cdpPort)) {
    throw new Error("A valid CDP port is required for smoke mode or chat-models source.");
  }
  if (options.send && options.mode !== "smoke") {
    throw new Error("--send is only valid with --mode=smoke.");
  }
  return options;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parsePort(value, label) {
  const parsed = parsePositiveInteger(value, label);
  if (parsed > 65535) throw new Error(`${label} must be <= 65535.`);
  return parsed;
}

function parseFirstValidPort(values, fallback = 9222) {
  for (const value of values) {
    if (value == null || String(value).trim() === "") continue;
    try {
      return parsePort(value, "CDP port");
    } catch {
      // Try the next configured source.
    }
  }
  return fallback;
}

function parseProviders(values) {
  const raw = values.length ? values.join(",") : VALID_PROVIDERS.join(",");
  const providers = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const provider of providers) {
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`Unsupported provider '${provider}'. Expected one of: ${VALID_PROVIDERS.join(", ")}.`);
    }
  }
  return [...new Set(providers)];
}

function info(options, message) {
  if (!options.json) process.stderr.write(`${message}\n`);
}

async function loadModelRegistry() {
  const tsImport = await import("typescript");
  const ts = tsImport.default ?? tsImport;
  const filePath = path.join(desktopRoot, "src", "shared", "modelRegistry.ts");
  const source = await fs.readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  const blocking = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (blocking.length) {
    const text = ts.formatDiagnosticsWithColorAndContext(blocking, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => desktopRoot,
      getNewLine: () => "\n",
    });
    throw new Error(`Unable to load model registry:\n${text}`);
  }

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console,
  };
  vm.runInNewContext(transpiled.outputText, sandbox, { filename: filePath });
  return module.exports;
}

function buildDescriptorIndexes(registry) {
  const byId = new Map();
  const byProviderModelId = new Map();
  for (const descriptor of registry.MODEL_REGISTRY ?? []) {
    const provider = registry.resolveProviderGroupForModel(descriptor);
    byId.set(descriptor.id, descriptor);
    byId.set(`${provider}:${descriptor.id}`, descriptor);
    if (descriptor.shortId) byId.set(`${provider}:${descriptor.shortId}`, descriptor);
    for (const alias of descriptor.aliases ?? []) {
      byId.set(`${provider}:${alias}`, descriptor);
    }
    byProviderModelId.set(`${provider}:${descriptor.providerModelId}`, descriptor);
    byProviderModelId.set(`${provider}:${descriptor.id}`, descriptor);
  }
  return { byId, byProviderModelId };
}

function modelFromDescriptor(registry, descriptor, advertisedProvider, source) {
  const provider = registry.resolveProviderGroupForModel(descriptor);
  return {
    source,
    advertisedProvider,
    provider,
    id: descriptor.id,
    modelId: descriptor.id,
    runtimeModel: registry.getRuntimeModelRefForDescriptor(descriptor, provider),
    sessionModel: descriptor.isCliWrapped ? descriptor.providerModelId : descriptor.id,
    displayName: descriptor.displayName,
    family: descriptor.family,
    supportsReasoning: descriptor.capabilities?.reasoning === true,
    supportsTools: descriptor.capabilities?.tools === true,
    reasoningEfforts: descriptor.capabilities?.reasoning === true
      ? normalizeEfforts(descriptor.reasoningTiers)
      : [],
    color: descriptor.color ?? null,
    descriptorFound: true,
  };
}

function matchDescriptor(registry, indexes, provider, row) {
  const belongsToProvider = (descriptor) =>
    registry.resolveProviderGroupForModel(descriptor) === provider;

  const candidates = [
    row?.modelId,
    row?.id,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    const scoped = indexes.byId.get(`${provider}:${normalized}`);
    if (scoped && belongsToProvider(scoped)) return scoped;

    const providerScoped = registry.resolveModelDescriptorForProvider?.(normalized, provider);
    if (providerScoped && belongsToProvider(providerScoped)) return providerScoped;

    const byId = indexes.byId.get(normalized) ?? registry.getModelById?.(normalized);
    if (byId && belongsToProvider(byId)) return byId;
  }
  if (typeof row?.id === "string") {
    const descriptor = indexes.byProviderModelId.get(`${provider}:${row.id.trim()}`);
    if (descriptor) return descriptor;
  }
  return null;
}

function modelFromEndpointRow(registry, indexes, row, provider) {
  const descriptor = matchDescriptor(registry, indexes, provider, row);
  if (descriptor) {
    const model = modelFromDescriptor(registry, descriptor, provider, "chat-models");
    const endpointEfforts = normalizeEfforts((row.reasoningEfforts ?? []).map((entry) => entry?.effort));
    return {
      ...model,
      id: typeof row.id === "string" && row.id.trim() ? row.id.trim() : model.id,
      displayName: typeof row.displayName === "string" && row.displayName.trim()
        ? row.displayName.trim()
        : model.displayName,
      reasoningEfforts: endpointEfforts.length ? endpointEfforts : model.reasoningEfforts,
      supportsReasoning: row.supportsReasoning === false ? false : model.supportsReasoning,
      supportsTools: row.supportsTools === false ? false : model.supportsTools,
    };
  }

  const id = typeof row?.id === "string" ? row.id.trim() : "";
  const modelId = typeof row?.modelId === "string" && row.modelId.trim().length
    ? row.modelId.trim()
    : id.includes("/") ? id : null;
  const runtimeModel = provider === "claude" || provider === "codex"
    ? id
    : modelId ?? id;
  return {
    source: "chat-models",
    advertisedProvider: provider,
    provider,
    id,
    modelId,
      runtimeModel,
      sessionModel: runtimeModel,
      displayName: typeof row?.displayName === "string" && row.displayName.trim() ? row.displayName.trim() : id,
    family: typeof row?.family === "string" ? row.family : null,
    supportsReasoning: row?.supportsReasoning === true || Array.isArray(row?.reasoningEfforts),
    supportsTools: row?.supportsTools === true,
    reasoningEfforts: normalizeEfforts((row?.reasoningEfforts ?? []).map((entry) => entry?.effort)),
    color: typeof row?.color === "string" ? row.color : null,
    descriptorFound: false,
  };
}

function normalizeEfforts(values) {
  const efforts = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const effort = value.trim().toLowerCase();
    if (!effort || efforts.includes(effort)) continue;
    efforts.push(effort);
  }
  return efforts;
}

function collectRegistryModels(registry, providers) {
  return providers.flatMap((provider) =>
    registry
      .listModelDescriptorsForProvider(provider)
      .filter((descriptor) => !descriptor.deprecated)
      .map((descriptor) => modelFromDescriptor(registry, descriptor, provider, "registry"))
  );
}

async function collectEndpointModels(client, registry, providers, activateRuntime) {
  const indexes = buildDescriptorIndexes(registry);
  const all = [];
  for (const provider of providers) {
    const rows = await evaluateAde(client, async (args) => {
      return await window.ade.agentChat.models({
        provider: args.provider,
        activateRuntime: args.activateRuntime,
      });
    }, { provider, activateRuntime });
    for (const row of rows ?? []) {
      all.push(modelFromEndpointRow(registry, indexes, row, provider));
    }
  }
  return all;
}

function limitModelsByProvider(models, maxPerProvider) {
  if (!Number.isFinite(maxPerProvider)) return models;
  const counts = new Map();
  return models.filter((model) => {
    const count = counts.get(model.advertisedProvider) ?? 0;
    if (count >= maxPerProvider) return false;
    counts.set(model.advertisedProvider, count + 1);
    return true;
  });
}

function buildCases(models, options) {
  const cases = [];
  for (const model of models) {
    if (!model.runtimeModel) continue;
    const efforts = model.reasoningEfforts.length
      ? model.reasoningEfforts
      : [null];
    const limitedEfforts = Number.isFinite(options.maxReasoningPerModel)
      ? efforts.slice(0, options.maxReasoningPerModel)
      : efforts;
    for (const effort of limitedEfforts) {
      if (cases.length >= options.maxCases) return cases;
      const payload = {
        provider: model.provider,
        model: model.runtimeModel,
        sessionProfile: "light",
        permissionMode: "plan",
        ...(model.modelId ? { modelId: model.modelId } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      };
      const expectedReasoningEffort = effort
        ?? (model.provider === "codex" && model.supportsReasoning ? DEFAULT_CODEX_REASONING_EFFORT : null);
      const expectedSessionModel = model.sessionModel ?? model.runtimeModel;
      cases.push({
        provider: model.provider,
        advertisedProvider: model.advertisedProvider,
        displayName: model.displayName,
        source: model.source,
        modelId: model.modelId,
        descriptorFound: model.descriptorFound,
        runtimeModel: model.runtimeModel,
        requestedReasoningEffort: effort,
        expected: {
          provider: model.provider,
          model: expectedSessionModel,
          modelId: model.modelId,
          reasoningEffort: expectedReasoningEffort,
        },
        payload,
      });
    }
  }
  return cases;
}

function verifyDryRunCases(cases) {
  const results = [];
  for (const testCase of cases) {
    const issues = [];
    if (testCase.payload.provider !== testCase.expected.provider) {
      issues.push(`provider payload ${testCase.payload.provider} != expected ${testCase.expected.provider}`);
    }
    if (testCase.payload.model !== testCase.runtimeModel) {
      issues.push(`model payload ${testCase.payload.model} != runtime ${testCase.runtimeModel}`);
    }
    if ((testCase.payload.modelId ?? null) !== (testCase.expected.modelId ?? null)) {
      issues.push(`modelId payload ${testCase.payload.modelId ?? "null"} != expected ${testCase.expected.modelId ?? "null"}`);
    }
    if ((testCase.payload.reasoningEffort ?? null) !== (testCase.requestedReasoningEffort ?? null)) {
      issues.push("reasoning payload does not match requested reasoning");
    }
    results.push({
      ok: issues.length === 0,
      case: testCase,
      issues,
    });
  }
  return results;
}

async function evaluateAde(client, fn, arg) {
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description
      || response.exceptionDetails.text
      || "Runtime.evaluate failed.";
    throw new Error(text);
  }
  return response.result?.value;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(options = {}) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out opening CDP websocket.")), 10_000);
      this.ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    this.ws.on("message", (data) => this.onMessage(data));
    this.ws.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP websocket closed."));
      }
      this.pending.clear();
    });
    if (options.enableRuntime !== false) {
      await this.send("Runtime.enable");
    }
  }

  onMessage(data) {
    const message = JSON.parse(String(data));
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP command failed."));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP websocket is not open.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

async function fetchJson(url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function findAdeTarget(cdpPort, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`, 2_000);
      const pages = Array.isArray(targets) ? targets : [];
      const target = pages.find((entry) => {
        const title = String(entry.title ?? "").toLowerCase();
        const url = String(entry.url ?? "");
        return entry.type === "page"
          && entry.webSocketDebuggerUrl
          && !title.includes("devtools")
          && !title.includes("developer tools")
          && (url.includes("localhost:") || url.includes("127.0.0.1:") || url.startsWith("file://"));
      }) ?? pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return target;

      const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`, 2_000);
      if (typeof version?.webSocketDebuggerUrl === "string") {
        const browserClient = new CdpClient(version.webSocketDebuggerUrl);
        try {
          await browserClient.connect({ enableRuntime: false });
          const targetList = await browserClient.send("Target.getTargets");
          const infos = Array.isArray(targetList.targetInfos) ? targetList.targetInfos : [];
          const browserTarget = infos.find((entry) => {
            const title = String(entry.title ?? "").toLowerCase();
            const url = String(entry.url ?? "");
            return entry.type === "page"
              && !title.includes("devtools")
              && !title.includes("developer tools")
              && (url.includes("localhost:") || url.includes("127.0.0.1:") || url.startsWith("file://"));
          }) ?? infos.find((entry) => entry.type === "page");
          if (browserTarget?.targetId) {
            const webSocketDebuggerUrl = version.webSocketDebuggerUrl.replace(
              /\/devtools\/browser\/[^/]+$/,
              `/devtools/page/${browserTarget.targetId}`,
            );
            return { ...browserTarget, webSocketDebuggerUrl };
          }
        } finally {
          browserClient.close();
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`No ADE renderer CDP target found on port ${cdpPort}.${suffix}`);
}

async function waitForAdePreload(client, timeoutMs) {
  const result = await evaluateAde(client, async (args) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < args.timeoutMs) {
      if (window.ade?.agentChat?.models && window.ade?.agentChat?.create) {
        return {
          ok: true,
          href: window.location.href,
          title: document.title,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      ok: false,
      href: window.location.href,
      title: document.title,
    };
  }, { timeoutMs });
  if (!result?.ok) {
    throw new Error(`ADE preload did not become ready in renderer ${result?.title ?? ""} ${result?.href ?? ""}`.trim());
  }
  return result;
}

async function ensureProjectAndLane(client, options) {
  const project = await evaluateAde(client, async (args) => {
    const current = await window.ade.app.getProject();
    if (current?.rootPath !== args.projectRoot) {
      await window.ade.project.switchToPath(args.projectRoot);
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < args.timeoutMs) {
      const next = await window.ade.app.getProject();
      if (next?.rootPath === args.projectRoot) return next;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await window.ade.app.getProject();
  }, {
    projectRoot: options.projectRoot,
    timeoutMs: options.timeoutMs,
  });
  if (project?.rootPath !== options.projectRoot) {
    throw new Error(`Unable to open project root '${options.projectRoot}'. Current project: ${project?.rootPath ?? "none"}`);
  }

  const lane = await evaluateAde(client, async (args) => {
    const startedAt = Date.now();
    let lanes = [];
    let lastError = null;
    while (Date.now() - startedAt < args.timeoutMs) {
      try {
        lanes = await window.ade.lanes.list({ includeArchived: false, includeStatus: false });
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (lastError) throw new Error(`Unable to list lanes after project open: ${lastError}`);
    if (args.laneId) return lanes.find((entry) => entry.id === args.laneId) ?? null;
    return lanes.find((entry) => entry.worktreePath === args.projectRoot)
      ?? lanes.find((entry) => entry.laneType === "primary")
      ?? lanes[0]
      ?? null;
  }, {
    projectRoot: options.projectRoot,
    laneId: options.laneId,
    timeoutMs: options.timeoutMs,
  });
  if (!lane?.id) {
    throw new Error(`No lane found for project '${options.projectRoot}'.`);
  }
  return { project, lane };
}

async function runSmokeCase(client, testCase, laneId, options) {
  const payload = { ...testCase.payload, laneId };
  const result = await evaluateAde(client, async (args) => {
    const cleanup = [];
    const out = {
      ok: false,
      created: null,
      summaryAfterCreate: null,
      summaryAfterSend: null,
      cleanup,
      error: null,
    };
    const serializeError = (error) => ({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    });
    const withTimeout = (promise, label) => {
      let timeout = null;
      const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${args.timeoutMs}ms`)), args.timeoutMs);
      });
      return Promise.race([promise, timer]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
    };
    try {
      out.created = await withTimeout(window.ade.agentChat.create(args.payload), "agentChat.create");
      out.summaryAfterCreate = await withTimeout(
        window.ade.agentChat.getSummary({ sessionId: out.created.id }),
        "agentChat.getSummary",
      );
      if (args.send) {
        await withTimeout(
          window.ade.agentChat.send({
            sessionId: out.created.id,
            text: args.sendText,
            ...(args.payload.reasoningEffort ? { reasoningEffort: args.payload.reasoningEffort } : {}),
          }),
          "agentChat.send",
        );
        out.summaryAfterSend = await withTimeout(
          window.ade.agentChat.getSummary({ sessionId: out.created.id }),
          "agentChat.getSummary after send",
        );
      }
      out.ok = true;
    } catch (error) {
      out.error = serializeError(error);
    } finally {
      if (out.created?.id) {
        try {
          await withTimeout(window.ade.agentChat.delete({ sessionId: out.created.id }), "agentChat.delete");
          cleanup.push({ action: "delete", ok: true });
        } catch (error) {
          cleanup.push({ action: "delete", ok: false, error: serializeError(error) });
        }
      }
    }
    return out;
  }, {
    payload,
    send: options.send,
    sendText: options.sendText,
    timeoutMs: options.timeoutMs,
  });

  const issues = [];
  if (!result?.ok) {
    issues.push(result?.error?.message ?? "Smoke case failed before verification.");
  }
  verifySessionFields("created", result?.created, testCase.expected, issues);
  verifySessionFields("summary", result?.summaryAfterCreate, testCase.expected, issues);
  if (options.send && result?.summaryAfterSend) {
    verifySessionFields("summaryAfterSend", result.summaryAfterSend, testCase.expected, issues);
  }

  return {
    ok: result?.ok === true && issues.length === 0,
    case: { ...testCase, payload },
    issues,
    created: summarizeSessionForOutput(result?.created),
    summaryAfterCreate: summarizeSessionForOutput(result?.summaryAfterCreate),
    summaryAfterSend: summarizeSessionForOutput(result?.summaryAfterSend),
    cleanup: result?.cleanup ?? [],
    error: result?.error ?? null,
  };
}

function verifySessionFields(label, session, expected, issues) {
  if (!session) {
    issues.push(`${label} missing`);
    return;
  }
  const actualProvider = session.provider ?? null;
  const actualModel = session.model ?? null;
  const actualModelId = session.modelId ?? null;
  const actualReasoning = session.reasoningEffort ?? null;
  if (actualProvider !== expected.provider) {
    issues.push(`${label}.provider ${actualProvider ?? "null"} != ${expected.provider}`);
  }
  if (actualModel !== expected.model) {
    issues.push(`${label}.model ${actualModel ?? "null"} != ${expected.model}`);
  }
  if (actualModelId !== (expected.modelId ?? null)) {
    issues.push(`${label}.modelId ${actualModelId ?? "null"} != ${expected.modelId ?? "null"}`);
  }
  if (actualReasoning !== (expected.reasoningEffort ?? null)) {
    issues.push(`${label}.reasoningEffort ${actualReasoning ?? "null"} != ${expected.reasoningEffort ?? "null"}`);
  }
}

function summarizeSessionForOutput(session) {
  if (!session) return null;
  return {
    sessionId: session.id ?? session.sessionId ?? null,
    provider: session.provider ?? null,
    model: session.model ?? null,
    modelId: session.modelId ?? null,
    reasoningEffort: session.reasoningEffort ?? null,
    status: session.status ?? null,
  };
}

async function runSmokeCases(client, cases, laneId, options) {
  const results = [];
  for (const testCase of cases) {
    info(options, `smoke ${testCase.provider} ${testCase.modelId ?? testCase.runtimeModel} ${testCase.requestedReasoningEffort ?? "no-reasoning"}`);
    const result = await runSmokeCase(client, testCase, laneId, options);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

async function isPortListening(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function chooseCdpPort(preferred) {
  if (!await isPortListening(preferred)) return preferred;
  for (let port = 9322; port < 9422; port += 1) {
    if (!await isPortListening(port)) return port;
  }
  throw new Error("No free CDP port found in 9322-9421.");
}

function spawnDevApp(options) {
  const env = {
    ...process.env,
    ADE_ELECTRON_REMOTE_DEBUGGING_PORT: String(options.cdpPort),
    ADE_PROJECT_ROOT: options.projectRoot,
    NO_DEVTOOLS: "1",
  };
  // Windows npm is a `.cmd` shim: Node cannot spawn it by bare name (ENOENT)
  // and refuses `.cmd` outright without a shell (EINVAL, CVE-2024-27980). The
  // arguments here are fixed literals, so nothing needs quoting.
  const isWindows = process.platform === "win32";
  const child = cp.spawn(isWindows ? "npm.cmd" : "npm", ["run", "dev"], {
    cwd: desktopRoot,
    env,
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
    ...(isWindows ? { shell: true, windowsHide: true } : {}),
  });
  const logs = [];
  const append = (chunk) => {
    const text = chunk.toString("utf8");
    logs.push(...text.split(/\r?\n/).filter(Boolean));
    while (logs.length > 80) logs.shift();
    if (options.verbose) process.stderr.write(text);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (code, signal) => {
    if (options.verbose) {
      process.stderr.write(`[audit] dev app exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    }
  });
  return { child, logs };
}

async function stopDevApp(handle) {
  if (!handle?.child || handle.child.exitCode != null || handle.child.signalCode != null) return;
  if (process.platform === "win32") {
    cp.spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(handle.child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-handle.child.pid, "SIGTERM");
  } catch {
    try {
      handle.child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!exited) {
    try {
      process.kill(-handle.child.pid, "SIGKILL");
    } catch {
      try {
        handle.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}

function summarizeModels(models) {
  const byProvider = new Map();
  for (const model of models) {
    const entry = byProvider.get(model.advertisedProvider) ?? { models: 0, reasoningCases: 0 };
    entry.models += 1;
    entry.reasoningCases += model.reasoningEfforts.length || 1;
    byProvider.set(model.advertisedProvider, entry);
  }
  return Object.fromEntries(byProvider.entries());
}

function printHumanSummary({ options, models, cases, results, ok }) {
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`chat model runtime audit: ${ok ? "ok" : "failed"}\n`);
  process.stdout.write(`mode=${options.mode} source=${options.resolvedSource} providers=${options.providers.join(",")}\n`);
  process.stdout.write(`models=${models.length} cases=${cases.length}\n`);
  for (const [provider, summary] of Object.entries(summarizeModels(models))) {
    process.stdout.write(`  ${provider}: ${summary.models} models, ${summary.reasoningCases} model/reasoning cases\n`);
  }
  if (options.mode === "list" || options.verbose) {
    for (const model of models) {
      process.stdout.write(
        `  ${model.advertisedProvider} ${model.modelId ?? model.id} runtime=${model.runtimeModel} reasoning=${model.reasoningEfforts.join("|") || "none"}\n`,
      );
    }
  }
  if (options.verbose && cases.length) {
    for (const testCase of cases) {
      process.stdout.write(
        `  case ${testCase.provider} ${testCase.modelId ?? testCase.runtimeModel} reasoning=${testCase.requestedReasoningEffort ?? "none"}\n`,
      );
    }
  }
  for (const result of failed) {
    process.stdout.write(`FAILED ${result.case.provider} ${result.case.modelId ?? result.case.runtimeModel} ${result.case.requestedReasoningEffort ?? "none"}\n`);
    for (const issue of result.issues) {
      process.stdout.write(`  - ${issue}\n`);
    }
    if (result.error?.message) process.stdout.write(`  error: ${result.error.message}\n`);
  }
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const registry = await loadModelRegistry();
  let devHandle = null;
  let client = null;
  try {
    const needsCdp = options.resolvedSource === "chat-models" || options.mode === "smoke";
    if (needsCdp) {
      if (options.startDev) {
        options.cdpPort = await chooseCdpPort(options.cdpPort);
        info(options, `starting ADE dev app on CDP port ${options.cdpPort}`);
        devHandle = spawnDevApp(options);
      }
      const target = await findAdeTarget(options.cdpPort, options.startDev ? 90_000 : 10_000);
      client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      const preload = await waitForAdePreload(client, options.timeoutMs);
      info(options, `connected to ${preload.title || "ADE"} ${preload.href}`);
    }

    const rawModels = options.resolvedSource === "chat-models"
      ? await collectEndpointModels(client, registry, options.providers, options.activateRuntime)
      : collectRegistryModels(registry, options.providers);
    const models = limitModelsByProvider(rawModels, options.maxPerProvider);
    const cases = buildCases(models, options);
    let results = [];

    if (options.mode === "list") {
      results = [];
    } else if (options.mode === "dry-run") {
      results = verifyDryRunCases(cases);
    } else {
      const { lane } = await ensureProjectAndLane(client, options);
      info(options, `using lane ${lane.id} (${lane.name ?? lane.worktreePath})`);
      results = await runSmokeCases(client, cases, lane.id, options);
    }

    const ok = options.mode === "list"
      ? true
      : models.length > 0 && cases.length > 0 && results.length > 0 && results.every((result) => result.ok);
    const payload = {
      ok,
      mode: options.mode,
      source: options.resolvedSource,
      providers: options.providers,
      projectRoot: options.projectRoot,
      modelSummary: summarizeModels(models),
      modelCount: models.length,
      caseCount: cases.length,
      models: options.mode === "list" || options.verbose ? models : undefined,
      cases: options.verbose ? cases : undefined,
      results: options.mode === "list" ? undefined : results,
    };
    if (options.json) {
      printJson(payload);
    } else {
      printHumanSummary({ options, models, cases, results, ok });
    }
    if (!ok) process.exitCode = 1;
  } finally {
    if (client) client.close();
    await stopDevApp(devHandle);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
