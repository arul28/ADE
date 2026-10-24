import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PI_SDK_MIN_NODE,
  PI_SDK_PROTOCOL_VERSION,
  PI_READ_ONLY_TOOLS,
  normalizePiSdkContextUsage,
  parsePiSdkWorkerRequest,
  piSupportedThinkingLevels,
  toPiSdkJson,
  type JsonValue,
  type PiSdkContextUsage,
  type PiSdkModelRef,
  type PiSdkReady,
  type PiSdkSessionTarget,
  type PiSdkImage,
  type PiSdkWorkerInit,
  type PiSdkWorkerRequest,
  type PiSdkWorkerResponse,
} from "./piSdkProtocol";
import { materializeWorkerImages, withOmittedImageHints } from "./workerAttachmentImages";
import { authorizedSessionFileForId, forkSession, validatedSessionFile } from "./piSdkWorkerFork";
import { createPiWorkerAuth } from "./piSdkWorkerAuth";
import {
  ADE_MCP_APPROVAL_EXTENSION,
  PI_MCP_DISCOVERY_TOOLS,
  PI_MCP_RESOURCE_TOOLS,
  buildMcpExtensions,
} from "./piSdkWorkerMcp";
import { createPiAccountReader, withPiTurnAccount } from "./piSdkAuth";
import {
  PI_FALLBACK_THINKING_LEVEL,
  createPiSettingsManager,
  isPiThinkingLevel,
  piDefaultThinkingLevel,
  resolvePiExactModel,
} from "./piSdkSelection";
import {
  PI_ASK_USER_TOOL_NAME,
  createPiApprovalGate,
  createPiAskUserTool,
  createPiExtensionUiContext,
  createPiUiBridge,
  withPiApproval,
  type PiApprovalGate,
  type PiToolDefinitionLike,
  type PiUiBridge,
} from "./piSdkUiBridge";

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
/**
 * The level a session runs on when ADE picked none: the user's Pi default as
 * it stood when this worker started. Captured before the session exists,
 * because the session's own level changes move the settings manager's
 * in-memory default even though nothing is written.
 */
let defaultThinkingLevel: string = PI_FALLBACK_THINKING_LEVEL;
/** Cap on the post-sign-in catalog refresh; the credential is already stored. */
/** Root-exported factory per gateable built-in tool, used to rebuild it behind an approval gate. */
const PI_TOOL_DEFINITION_FACTORIES: Record<string, string> = {
  read: "createReadToolDefinition",
  bash: "createBashToolDefinition",
  edit: "createEditToolDefinition",
  write: "createWriteToolDefinition",
  // Windows only (Pi runs it through pwsh or Windows PowerShell). Granted and
  // gated exactly like bash; ADE only asks for it on win32.
  powershell: "createPowerShellToolDefinition",
};
/** Derived so the gateable set and the factory map cannot drift apart. */
const PI_GATEABLE_TOOLS = new Set(Object.keys(PI_TOOL_DEFINITION_FACTORIES));
const PI_READ_ONLY_TOOL_SET = new Set<string>(PI_READ_ONLY_TOOLS);
/** The built-ins a caller may grant: the gateable ones, plus Pi's read-only search tools, which need no gate. */
const PI_GRANTABLE_TOOLS = new Set([...PI_GATEABLE_TOOLS, ...PI_READ_ONLY_TOOLS]);
/**
 * Every Pi built-in, so a session with extensions on can deny each one it was
 * not granted. That session runs on Pi's `defaultTools` setting minus
 * `excludeTools`, and the setting can name any built-in.
 */
const PI_ALL_BUILTIN_TOOLS = [...PI_GRANTABLE_TOOLS];
let unsubscribe: (() => void) | null = null;
let disposed = false;
let loadedExtensions: Array<{ id: string; name?: string | null }> = [];
let ungateableTools: string[] = [];
let extensionsError: string | null = null;
const uiBridge: PiUiBridge = createPiUiBridge(post, () => randomUUID());
const piAuth = createPiWorkerAuth({
  getModelRuntime: () => modelRuntime as Record<string, unknown> | null,
  getPi: () => pi,
  getInit: () => initState,
  uiBridge,
  forgetAccount: (providerId) => accountReader.forget(providerId),
  errorMessage,
});
/**
 * One approval gate per worker, shared by the gated built-ins and MCP tools,
 * so "allow for this chat" on a tool holds wherever the call comes from (a
 * direct call or a codemode script).
 */
let approvalGate: PiApprovalGate | null = null;
function sharedApprovalGate(): PiApprovalGate {
  approvalGate ??= createPiApprovalGate(uiBridge);
  return approvalGate;
}

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

/**
 * Per-turn account classification, by the `"turn"` rules, without returning
 * or logging credential values. Memoized per provider so repeated
 * message_end events do not reread the profile files.
 */
const accountReader = createPiAccountReader({
  agentDir: () => initState?.agentDir,
  // Pi's live registry entry for a provider (a built-in's default base URL).
  getProvider: (providerId) => (modelRuntime && typeof modelRuntime.getProvider === "function"
    ? record((modelRuntime.getProvider as Callable).call(modelRuntime, providerId))
    : null),
});

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
  // The levels Pi offers for this model: ADE's effort picker shows exactly these.
  out.thinkingLevels = piSupportedThinkingLevels(item);
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

async function resolveModel(ref: PiSdkModelRef): Promise<unknown> {
  if (!pi || !modelRuntime) throw new Error("Pi SDK is not initialized.");
  // Exact provider + id only; never Pi's fuzzy CLI resolver. See piSdkSelection.
  return await resolvePiExactModel(modelRuntime, ref);
}

function sessionTarget(init: PiSdkWorkerInit): PiSdkSessionTarget {
  return init.session ?? {};
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
  // The authorization root and the directory Pi writes into are different
  // things. Pi only nests per cwd when told nothing; handing it the root would
  // scatter files flat into `<agentDir>/sessions`, which Pi's own discovery
  // (subdirectories only) can never read back.
  const sessionRoot = nonEmpty(init.sessionRoot);
  const storageDir = nonEmpty(init.sessionStorageDir) ?? undefined;

  try {
    if (resumeFile) {
      assertAbsolute("sessionFile", resumeFile);
      const authorizedFile = validatedSessionFile(resumeFile, sessionRoot, resumeId, init.cwd);
      // A stale path can accompany a durable session id after a project move or
      // remote handoff. Prefer the id lookup in that case; never create a new
      // session while a persisted native pointer is present.
      if (authorizedFile) {
        return method(manager, "open").call(manager, authorizedFile, storageDir ?? path.dirname(authorizedFile), init.cwd) as PiSessionManager;
      }
      if (!resumeId) {
        throw new Error(`Pi session file "${resumeFile}" is missing, outside the authorized session directory, or invalid.`);
      }
    }
    if (resumeId) {
      const authorizedFoundPath = await authorizedSessionFileForId(manager, init, resumeId, method);
      if (!authorizedFoundPath) {
        throw new Error(`Pi session "${resumeId}" was not found in the authorized session directory.`);
      }
      return method(manager, "open").call(manager, authorizedFoundPath, storageDir ?? path.dirname(authorizedFoundPath), init.cwd) as PiSessionManager;
    }
    if (resume === true) {
      return method(manager, "continueRecent").call(manager, init.cwd, storageDir) as PiSessionManager;
    }
    return method(manager, "create").call(manager, init.cwd, storageDir) as PiSessionManager;
  } catch (error) {
    throw new Error(`Pi session could not be opened${resumeFile ? ` at ${resumeFile}` : ""}: ${errorMessage(error)}`);
  }
}

function makeResourceLoader(
  init: PiSdkWorkerInit,
  sdk: PiModule,
  settingsManager: unknown,
  extensionFactories: unknown[] = [],
): unknown {
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
    // Without this the loader builds its own settings manager, which trusts
    // the project and would auto-load extensions from the checkout.
    ...(settingsManager ? { settingsManager } : {}),
    // Pi extensions execute arbitrary code and install their own UI handlers,
    // so ADE chat keeps them out unless the caller opts in. When enabled they
    // are bound to ADE's limited UI bridge; the Pi CLI remains the escape hatch
    // for extension experiences the bridge cannot render.
    noExtensions: init.extensions !== true,
    // Inline factories load whether or not the user's extensions do: this is
    // how ADE adds Pi's MCP support without turning the rest on.
    ...(extensionFactories.length ? { extensionFactories } : {}),
    // Do not inherit project/user Pi skill settings. ADE passes only its
    // explicitly approved skill roots below; the CLI remains the escape hatch
    // for Pi-native skill discovery.
    noSkills: true,
    ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}),
    ...(init.systemPrompt != null ? { systemPromptOverride: () => init.systemPrompt ?? "" } : {}),
  });
}

/**
 * Assemble ADE's custom tools: `ask_user`, plus approval-gated rebuilds of the
 * built-ins the caller wants gated.
 *
 * A custom tool whose name matches a built-in replaces it in Pi's registry, so
 * rebuilding `bash` from Pi's own factory keeps its schema, prompt text, and
 * rendering while adding the gate. Pi's shell settings are passed through so a
 * gated bash still honours the user's configured shell.
 */
function buildCustomTools(
  init: PiSdkWorkerInit,
  requestedTools: readonly string[],
  sdk: PiModule,
  settingsManager: unknown,
): { tools: PiToolDefinitionLike[]; ungateable: string[] } {
  const tools: PiToolDefinitionLike[] = [];
  const ungateable: string[] = [];
  const define = typeof sdk.defineTool === "function" ? sdk.defineTool as Callable : null;
  const finish = (definition: PiToolDefinitionLike): PiToolDefinitionLike =>
    (define ? define.call(null, definition) as PiToolDefinitionLike : definition);

  if (init.askUserTool) tools.push(finish(createPiAskUserTool(uiBridge)));

  // Only gate a tool this session actually grants. Relying on Pi's own
  // allowlist to drop an unrequested wrapper would make the gate depend on
  // resolution order rather than on ADE's permission mode.
  const requested = new Set(requestedTools);
  const gated = (init.approvalTools ?? []).filter((tool) => PI_GATEABLE_TOOLS.has(tool) && requested.has(tool));
  if (!gated.length) return { tools, ungateable };
  const gate = sharedApprovalGate();
  const settings = record(settingsManager);
  const shellPath = typeof settings?.getShellPath === "function"
    ? nonEmpty((settings.getShellPath as Callable).call(settings))
    : null;
  const commandPrefix = typeof settings?.getShellCommandPrefix === "function"
    ? nonEmpty((settings.getShellCommandPrefix as Callable).call(settings))
    : null;
  for (const toolName of gated) {
    const factoryName = PI_TOOL_DEFINITION_FACTORIES[toolName];
    const factory = factoryName ? sdk[factoryName] : undefined;
    if (typeof factory !== "function") {
      // Nothing to wrap, so the caller withholds the tool. Granting it ungated
      // would silently downgrade the permission mode.
      ungateable.push(toolName);
      continue;
    }
    const options = toolName === "bash"
      ? {
          ...(shellPath ? { shellPath } : {}),
          ...(commandPrefix ? { commandPrefix } : {}),
        }
      : undefined;
    const definition = (factory as Callable).call(null, init.cwd, options) as PiToolDefinitionLike;
    tools.push(finish(withPiApproval(definition, gate)));
  }
  return { tools, ungateable };
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
  const currentModel = currentModelDescriptor();
  const providerId = nonEmpty(record(currentModel)?.provider);
  const activeTools = session && typeof session.getActiveToolNames === "function"
    ? (session.getActiveToolNames as Callable).call(session)
    : undefined;
  return {
    protocolVersion: PI_SDK_PROTOCOL_VERSION,
    packageRoot: piRoot,
    packageEntry: piEntry,
    version: piVersion ?? (typeof pi?.VERSION === "string" ? pi.VERSION : null),
    sessionFile: typeof sessionFileValue === "string" ? sessionFileValue : null,
    sessionId: typeof sessionIdValue === "string" ? sessionIdValue : null,
    currentModel,
    thinkingLevel: typeof session?.thinkingLevel === "string" ? session.thinkingLevel : null,
    availableModels: modelInventory,
    ...(providerId ? { account: accountReader.accountFor(providerId) } : {}),
    extensions: loadedExtensions,
    extensionsError,
    ungateableTools,
    ...(Array.isArray(activeTools)
      ? { activeTools: activeTools.filter((tool): tool is string => typeof tool === "string" && tool.length > 0) }
      : {}),
  };
}

/**
 * Bind the user's extensions to ADE's UI bridge and report what loaded.
 *
 * `bindExtensions` is also what fires Pi's `session_start` event, and it is
 * where extension-registered providers are flushed into the model runtime — so
 * it must run before the model inventory is read.
 */
async function bindExtensions(active: PiSession, loadResult: unknown): Promise<void> {
  loadedExtensions = [];
  extensionsError = null;
  const bind = (active as Record<string, unknown>).bindExtensions;
  if (typeof bind !== "function") {
    extensionsError = "This Pi build does not support binding extensions to a host UI.";
    return;
  }
  try {
    await (bind as Callable).call(active, {
      uiContext: createPiExtensionUiContext({ bridge: uiBridge }),
      // Pi's own non-terminal host mode: dialogs and notifications are
      // supported, terminal-only widgets are not.
      mode: "rpc",
      onError: (error: unknown) => {
        const detail = record(error);
        uiBridge.notify({
          origin: "extension",
          level: "error",
          message: `A Pi extension failed: ${nonEmpty(detail?.error) ?? errorMessage(error)}`,
          ...(nonEmpty(detail?.extensionPath) ? { sourceId: nonEmpty(detail?.extensionPath)! } : {}),
        });
      },
    });
  } catch (error) {
    extensionsError = errorMessage(error);
    return;
  }

  // `createAgentSession` hands back the load result directly; prefer it. The
  // resource-loader accessor stays only as a fallback for Pi builds that do
  // not return one — reading it first reported "no extensions" whenever that
  // accessor was shaped differently.
  const loader = record((active as Record<string, unknown>).resourceLoader);
  const getExtensions = loader?.getExtensions;
  const result = record(loadResult)
    ?? (typeof getExtensions === "function" ? record((getExtensions as Callable).call(loader)) : null);
  if (!result) return;
  const entries = Array.isArray(result?.extensions) ? result.extensions : [];
  loadedExtensions = entries.flatMap((entry) => {
    const item = record(entry);
    // Pi identifies an extension by path. `sourceInfo.source` names the origin
    // ("auto", "local", a package name), so it only doubles as a label when it
    // is a package; otherwise the path is what the user recognizes, and an
    // `index.*` entry is named by its folder rather than "index".
    const id = nonEmpty(item?.resolvedPath) ?? nonEmpty(item?.path);
    if (!id || item?.hidden === true) return [];
    const base = path.basename(id).replace(/\.(?:ts|js|mjs|cjs)$/, "");
    const name = base === "index" ? path.basename(path.dirname(id)) : base;
    return [{ id, name }];
  });
  const failures = Array.isArray(result?.errors) ? result.errors : [];
  if (failures.length) {
    extensionsError = failures
      .map((failure) => {
        const item = record(failure);
        return `${nonEmpty(item?.path) ?? "extension"}: ${nonEmpty(item?.error) ?? "failed to load"}`;
      })
      .join("; ");
  }
}

/**
 * Pi's `grep` runs ripgrep and its `find` runs fd. When neither copy is on
 * PATH or in `<agentDir>/bin`, Pi downloads one from GitHub, unpinned, the
 * first time the tool runs. ADE never runs an unpinned download, and pins
 * neither binary, so a tool whose binary this machine lacks is left out of
 * the session: the model uses `bash` (or `ls`) instead.
 */
function withoutMissingSearchBinaries(tools: readonly string[], agentDir: string): string[] {
  const needs: Record<string, string> = { grep: "rg", find: "fd" };
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [path.join(agentDir, "bin"), ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  const present = (binary: string): boolean => dirs.some((dir) => {
    try {
      return fs.statSync(path.join(dir, `${binary}${exe}`)).isFile();
    } catch {
      return false;
    }
  });
  return tools.filter((tool) => !needs[tool] || present(needs[tool]!));
}

async function initWorker(init: PiSdkWorkerInit): Promise<PiSdkReady> {
  if (!isNodeSupported()) {
    throw new Error(`Pi SDK requires Node >= ${PI_SDK_MIN_NODE}; ADE worker is running Node ${process.versions.node}. Start ADE with a newer Node runtime.`);
  }
  assertAbsolute("cwd", init.cwd);
  assertAbsolute("agentDir", init.agentDir);
  if (init.thinkingLevel && !isPiThinkingLevel(init.thinkingLevel.trim())) {
    throw new Error(`Invalid Pi thinking level "${init.thinkingLevel}". Use off, minimal, low, medium, high, xhigh, or max.`);
  }
  const readOnly = init.readOnly === true;
  const askedTools = init.tools ?? (readOnly ? [...PI_READ_ONLY_TOOLS] : ["read"]);
  const invalidTools = askedTools.filter((tool) => !PI_GRANTABLE_TOOLS.has(tool));
  if (invalidTools.length) {
    throw new Error(`Pi SDK only permits the built-in tools ${[...PI_GRANTABLE_TOOLS].join(", ")}; received ${invalidTools.join(", ")}.`);
  }
  if (readOnly) {
    // Refused rather than trimmed: a caller that asked for a write tool and
    // a read-only session at once has a bug that a quiet trim would hide.
    const writable = askedTools.filter((tool) => !PI_READ_ONLY_TOOL_SET.has(tool));
    if (writable.length) {
      throw new Error(`A read-only Pi session can only use ${PI_READ_ONLY_TOOLS.join(", ")}; received ${writable.join(", ")}.`);
    }
    if (init.approvalTools?.length) {
      throw new Error("A read-only Pi session has no tools to approve; approvalTools must be empty.");
    }
    if (init.mcp) {
      throw new Error("A read-only Pi session has no MCP servers: an MCP tool can change the workspace.");
    }
  }
  if (init.sessionRoot) assertAbsolute("sessionRoot", init.sessionRoot);
  if (init.sessionStorageDir) assertAbsolute("sessionStorageDir", init.sessionStorageDir);
  const requestedTools = withoutMissingSearchBinaries(askedTools, init.agentDir);
  const location = resolvePackageLocation(init);
  piRoot = location.root;
  piEntry = location.entry;
  piVersion = location.version;
  initState = init;
  accountReader.clear();
  process.env.PI_CODING_AGENT_DIR = init.agentDir;
  // Pi's embedded SDK never reads PI_CODING_AGENT_SESSION_DIR — only its CLI
  // entry point does — so the storage directory travels as an explicit
  // SessionManager argument instead. Mirroring the variable here would just
  // hand a stale override to anything the worker later spawns.
  for (const [key, value] of Object.entries(init.skillsEnv ?? {})) process.env[key] = value;
  fs.mkdirSync(init.agentDir, { recursive: true });
  if (init.sessionRoot) fs.mkdirSync(init.sessionRoot, { recursive: true });
  if (init.sessionStorageDir) fs.mkdirSync(init.sessionStorageDir, { recursive: true });

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
  // One settings manager governs both the resource loader and the session.
  //
  // `projectTrusted` is deliberately false. Pi treats a trusted project as
  // permission to auto-load and execute extensions from the checkout's own
  // `.pi/` directory, which its CLI only does after prompting. ADE opens
  // repositories the user has not vouched for, so only the user's own profile
  // extensions may load here; without this the loader would build its own
  // settings manager that defaults to trusted.
  //
  // It also never writes: Pi saves a session's model and thinking picks as the
  // user's global defaults, and an ADE chat must not change what the Pi CLI
  // starts on.
  const settingsManager = createPiSettingsManager(pi.SettingsManager, init.cwd, init.agentDir);
  if (init.compaction && settingsManager) {
    const manager = record(settingsManager);
    const compact = init.compaction;
    if (typeof manager?.applyOverrides === "function") {
      manager.applyOverrides({ compaction: {
        ...(compact.reserveTokens !== undefined ? { reserveTokens: compact.reserveTokens } : {}),
        ...(compact.keepRecentTokens !== undefined ? { keepRecentTokens: compact.keepRecentTokens } : {}),
      } });
    }
  }
  defaultThinkingLevel = piDefaultThinkingLevel(settingsManager);
  // Without a settings manager ADE cannot pin `projectTrusted`, and Pi's own
  // default would trust the checkout — so extensions stay off rather than
  // loading repository code on a Pi build ADE cannot constrain.
  // A read-only session never loads extensions: their tools and hooks can
  // change the workspace, and no allowlist can name them in advance.
  const extensionsAllowed = !readOnly && init.extensions === true && settingsManager !== null;
  if (init.extensions && readOnly) {
    extensionsError = "Extensions stay off in a read-only Pi session, because their tools can change the workspace.";
  } else if (init.extensions && !extensionsAllowed) {
    extensionsError = "This Pi build does not let ADE mark the project untrusted, so extensions stayed off.";
  }
  // Pi's MCP support needs the same untrusted-project pin as extensions:
  // without it Pi would read a checkout's own `.pi/mcp.json` and start its
  // commands.
  const mcpRegistrationErrors: string[] = [];
  const mcpExtensions = !readOnly && settingsManager !== null
    ? await buildMcpExtensions(init, pi, mcpRegistrationErrors, {
      piRoot,
      method,
      errorMessage,
      approvalGate: sharedApprovalGate,
    })
    : null;
  if (init.mcp && settingsManager === null) {
    mcpRegistrationErrors.push("This Pi build does not let ADE mark the project untrusted, so MCP servers stayed off.");
  }
  const mcpAllowed = mcpExtensions !== null;
  const resourceLoader = makeResourceLoader({ ...init, extensions: extensionsAllowed }, pi, settingsManager, mcpExtensions ?? []);
  if (resourceLoader && typeof (resourceLoader as Record<string, unknown>).reload === "function") {
    await method(resourceLoader, "reload").call(resourceLoader);
  }
  const { tools: customTools, ungateable } = buildCustomTools(init, requestedTools, pi, settingsManager);
  // A Pi build that cannot supply a tool's definition factory cannot have that
  // tool gated, so it is withheld rather than granted ungated — and the chat
  // still starts.
  const grantedTools = requestedTools.filter((tool) => !ungateable.includes(tool));
  // Reported on the ready payload rather than as a notice: nothing is listening
  // for notices until the desktop process finishes acquiring this worker.
  ungateableTools = ungateable;
  const createSession = callable(pi.createAgentSession, "createAgentSession");
  const options: Record<string, unknown> = {
    cwd: init.cwd,
    agentDir: init.agentDir,
    modelRuntime,
    sessionManager,
    ...(settingsManager ? { settingsManager } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    // No `thinkingLevel` here: on a resumed session Pi would take it without
    // recording it, leaving the file on its old level. The level is applied
    // once the session exists instead.
    ...(resourceLoader ? { resourceLoader } : {}),
    // Pi's `tools` option is one flat allowlist covering built-ins, extension
    // tools, and custom tools, and anything unlisted is dropped. With
    // extensions enabled ADE cannot name their tools in advance, so it denies
    // the unwanted built-ins instead and leaves the rest of the namespace
    // alone. Without extensions the tighter allowlist still applies.
    //
    // That session starts on Pi's `defaultTools` (read, bash, edit, write
    // unless the user changed it), so a granted built-in outside it (grep,
    // find, ls, powershell) is added with Pi's `+name` form, which edits the
    // default selection rather than replacing it.
    ...(extensionsAllowed
      ? {
          // An empty list would be an allowlist of nothing, not a no-op edit.
          ...(grantedTools.length ? { tools: grantedTools.map((tool) => `+${tool}`) } : {}),
          excludeTools: PI_ALL_BUILTIN_TOOLS.filter((tool) => !grantedTools.includes(tool)),
        }
      : {
          // An MCP tool the allowlist does not match stays callable from
          // codemode and tool_search but is never declared, so a server with
          // `direct` exposure would reach the model with no tools. Naming
          // `mcp__*` and the resource tools keeps every MCP tool, as `pi`
          // does without `--tools`; codemode and tool_search are named too.
          tools: [
            ...grantedTools,
            ...(init.askUserTool ? [PI_ASK_USER_TOOL_NAME] : []),
            ...(mcpAllowed ? [...PI_MCP_DISCOVERY_TOOLS, "mcp__*", ...PI_MCP_RESOURCE_TOOLS] : []),
          ],
        }),
    ...(customTools.length ? { customTools } : {}),
    ...(init.noTools ? { noTools: init.noTools } : {}),
  };
  const created = record(await createSession(options));
  session = record(created?.session);
  if (!session) throw new Error("Pi SDK createAgentSession returned no session.");
  applyThinkingLevel(session, init.thinkingLevel ?? null);
  if (mcpAllowed && init.mcp?.approval) {
    // Fail closed: without the approval hook every MCP call would run unasked.
    const failures = record(created?.extensionsResult)?.errors;
    const gateFailure = (Array.isArray(failures) ? failures : [])
      .map((failure) => record(failure))
      .find((failure) => String(failure?.path ?? "").includes(ADE_MCP_APPROVAL_EXTENSION));
    if (gateFailure) {
      throw new Error(`Pi could not load ADE's MCP approval hook, so the chat did not start: ${nonEmpty(gateFailure.error) ?? "unknown error"}`);
    }
  }
  // `bindExtensions` fires `session_start`, which is also when Pi's MCP
  // support connects its servers, so it runs for MCP alone too.
  if (extensionsAllowed || mcpAllowed) await bindExtensions(session, created?.extensionsResult);
  if (mcpRegistrationErrors.length) {
    extensionsError = [extensionsError, ...mcpRegistrationErrors].filter(Boolean).join("; ");
  }
  const subscribe = method(session, "subscribe");
  const listener = (event: unknown): void => {
    const eventRecord = record(event);
    let eventForHost = event;
    if (eventRecord?.type === "message_end") {
      const message = record(eventRecord.message);
      if (message?.role === "assistant") {
        if (message.stopReason === "error") {
          lastAssistantError = nonEmpty(message.errorMessage) ?? "Pi provider returned an assistant error.";
        } else {
          lastAssistantError = null;
        }
        eventForHost = withPiTurnAccount(eventRecord, message, accountReader.accountFor);
      }
    }
    post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "sdk_event", event: toPiSdkJson(eventForHost) });
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

async function imageContents(
  images: PiSdkImage[] | undefined,
): Promise<{ contents: unknown[] | undefined; omittedHints: string[] }> {
  const materialized = await materializeWorkerImages(images, {
    label: "Pi SDK",
  });
  const contents: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const image of materialized.images) {
    if (!("data" in image)) {
      throw new Error("Pi SDK image URLs are not supported.");
    }
    contents.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return {
    contents: contents.length ? contents : undefined,
    omittedHints: materialized.omittedHints,
  };
}

async function sendPrompt(request: Extract<PiSdkWorkerRequest, { type: "send" }>): Promise<JsonValue> {
  const active = requireSession();
  lastAssistantError = null;
  post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "prompt_started", requestId: request.requestId });
  try {
    const promptOptions: Record<string, unknown> = {};
    const { contents: images, omittedHints } = await imageContents(request.payload.images);
    if (images) promptOptions.images = images;
    if (request.payload.streamingBehavior) promptOptions.streamingBehavior = request.payload.streamingBehavior;
    await method(active, "prompt").call(active, withOmittedImageHints(request.payload.prompt, omittedHints), promptOptions);
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

/**
 * Put the session on `level`, or on Pi's default when ADE picked none.
 *
 * Pi records the change in the session file, so a resume keeps it, and clamps
 * the level to what the model supports. It would also save the level as the
 * user's global default; the settings manager drops that write.
 */
function applyThinkingLevel(active: PiSession, level: string | null): void {
  const target = level?.trim() || defaultThinkingLevel;
  if (!isPiThinkingLevel(target)) {
    throw new Error(`Invalid Pi thinking level "${level}". Use off, minimal, low, medium, high, xhigh, or max.`);
  }
  method(active, "setThinkingLevel").call(active, target);
}

async function setThinking(level: string | null): Promise<PiSdkReady> {
  applyThinkingLevel(requireSession(), level);
  return ready();
}

async function compact(customInstructions?: string | null): Promise<JsonValue> {
  const active = requireSession();
  const compactMethod = (active as Record<string, unknown>).compact;
  if (typeof compactMethod !== "function") throw new Error("This Pi SDK build does not expose session.compact().");
  return toPiSdkJson(await (compactMethod as Callable).call(active, customInstructions ?? undefined));
}

async function contextUsage(): Promise<PiSdkContextUsage | null> {
  const active = requireSession();
  return normalizePiSdkContextUsage(await method(active, "getContextUsage").call(active));
}

async function disposeWorker(): Promise<void> {
  if (disposed) return;
  disposed = true;
  piAuth.abort();
  // Every awaiting Pi callback resolves to "no answer" rather than hanging a
  // teardown that is already underway.
  uiBridge.close();
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
      const { contents: images, omittedHints } = await imageContents(request.payload.images);
      await method(active, "steer").call(active, withOmittedImageHints(request.payload.prompt, omittedHints), images);
      return null;
    }
    case "follow_up": {
      const active = requireSession();
      const { contents: images, omittedHints } = await imageContents(request.payload.images);
      await method(active, "followUp").call(active, withOmittedImageHints(request.payload.prompt, omittedHints), images);
      return null;
    }
    case "abort": {
      const active = requireSession();
      // Cards waiting on the user belong to the turn being abandoned; leaving
      // them pending would block their tool calls forever. A chat worker never
      // holds an auth request — login runs on its own worker.
      uiBridge.drain();
      await method(active, "abort").call(active);
      post({ protocolVersion: PI_SDK_PROTOCOL_VERSION, type: "lifecycle", event: "aborted", requestId: request.requestId });
      return null;
    }
    case "login": return await piAuth.loginProvider(request.payload.providerId, request.payload.method);
    case "login_cancel": {
      piAuth.abort();
      uiBridge.drain("auth");
      return null;
    }
    case "ui_response": {
      uiBridge.resolve(request.requestId, request.payload);
      return null;
    }
    case "set_model": return toPiSdkJson(await setModel(request.payload.modelRef));
    case "set_thinking": return toPiSdkJson(await setThinking(request.payload.thinkingLevel));
    case "compact": return await compact(request.payload?.customInstructions);
    case "context_usage": return toPiSdkJson(await contextUsage());
    case "models": return toPiSdkJson(await availableModels());
    case "auth": return await piAuth.authInventory();
    case "fork": {
      if (!pi || !initState || disposed) throw new Error("Pi SDK worker is not initialized or has been disposed.");
      return toPiSdkJson(await forkSession(request.payload, { pi, init: initState, method, assertAbsolute }));
    }
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
