import { createHash, randomBytes } from "node:crypto";
import {
  decodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
  getLocalProviderDefaultEndpoint,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type { OpenCodeMcpServerConfig } from "../../../shared/callerMcpServers";
import type {
  AiCustomProviderConfig,
  AiLocalProviderConfigs,
  EffectiveProjectConfig,
  ProjectConfigFile,
} from "../../../shared/types";
import { stableStringify } from "../shared/utils";
import type { PermissionMode } from "../ai/tools/universalTools";
import type { OpenCodeServerConfig, OpenCodeServerProfile } from "./openCodeServer";

/**
 * ADE's generated OpenCode 2.0 config, in the native 2.0 shape.
 *
 * It reaches the server through `OPENCODE_CONFIG` (see `openCodeServer.ts`) and
 * layers over the user's own global config. It holds only what is the same for
 * every chat on a server — providers, ADE's agents, skills — so every ordinary
 * chat shares one server. Per-chat context (worktree, lineage, mode rules) goes
 * to the session as an instruction entry instead.
 */

export type OpenCodeAgentProfile = "ade-plan" | "ade-edit" | "ade-full-auto" | "ade-helper";

export type DiscoveredLocalModelEntry = {
  provider: LocalProviderFamily;
  modelId: string;
  /** Whether the model is actively loaded/running. Only loaded models are injected into OpenCode config. */
  loaded?: boolean;
};

type PermissionEffect = "allow" | "ask" | "deny";

/**
 * The 2.0 permission actions ADE states. A typo would compile against a plain
 * string and silently not apply, so the set is closed.
 */
type OpenCodePermissionAction =
  | "*"
  | "edit"
  | "shell"
  | "read"
  | "webfetch"
  | "websearch"
  | "doom_loop"
  | "external_directory"
  | "question"
  | "subagent"
  | "skill";

export type OpenCodePermissionRule = {
  action: OpenCodePermissionAction;
  resource: string;
  effect: PermissionEffect;
};

type OpenCodeModelBlock = { name?: string };

export type OpenCodeProviderBlock = {
  name?: string;
  package?: string;
  settings?: Record<string, unknown>;
  models?: Record<string, OpenCodeModelBlock>;
};

export type OpenCodeProviderMap = Record<string, OpenCodeProviderBlock>;

export type BuildOpenCodeConfigArgs = {
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  /** Dynamically discovered models from local provider endpoints (e.g. LM Studio /v1/models). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
  mcpServers?: Record<string, OpenCodeMcpServerConfig>;
  /** Extra skill roots, added to OpenCode's own skill discovery. */
  agentSkillRoots?: readonly string[];
  /** The server hides the user's config, so ADE must supply everything it needs. */
  isolated?: boolean;
  /**
   * A personal (no-project) chat. It gets no ADE skills, so its config differs
   * from the lane chats' and it runs on a shared server of its own.
   */
  personal?: boolean;
  /**
   * Provider blocks a harness preset contributes for ONE session. Merged last,
   * so the preset outranks a same-named configured provider for that session;
   * a config with presets always gets a profile (server) of its own.
   */
  presetProviders?: OpenCodeProviderMap;
};

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const rule = (action: OpenCodePermissionAction, effect: PermissionEffect, resource = "*"): OpenCodePermissionRule => ({
  action,
  resource,
  effect,
});

/**
 * Ordered rules per ADE mode. OpenCode evaluates the last match, after its own
 * base policy (`* allow`, then asks for external directories and `.env` reads)
 * and its managed-directory allows, so these rules only state what ADE changes.
 */
export function buildOpenCodePermissions(mode: PermissionMode | "helper"): OpenCodePermissionRule[] {
  if (mode === "full-auto") {
    // Full access means no prompts at all, including external directories and
    // `.env` reads, which the base policy asks about.
    return [rule("*", "allow")];
  }
  if (mode === "plan") {
    return [
      rule("edit", "deny"),
      rule("shell", "ask"),
      rule("doom_loop", "ask"),
      // Subagents stay allowed: these rules also go on the session, and a child
      // inherits session rules, so a plan-mode child cannot edit either.
      rule("websearch", "deny"),
      rule("skill", "deny"),
    ];
  }
  if (mode === "helper") {
    // One-shot helper: no UI to answer an ask, so everything with side effects
    // is denied outright.
    return [
      rule("edit", "deny"),
      rule("shell", "deny"),
      rule("webfetch", "deny"),
      rule("websearch", "deny"),
      rule("doom_loop", "deny"),
      rule("question", "deny"),
      rule("subagent", "deny"),
      rule("external_directory", "deny"),
    ];
  }
  return [
    rule("edit", "ask"),
    rule("shell", "ask"),
    rule("doom_loop", "ask"),
  ];
}

/**
 * The ADE mode an OpenCode permission mode maps to, or null for none.
 * `config-toml` (and no mode at all) defers to the user's own OpenCode config,
 * so ADE sets neither an agent nor session rules for it; any other value runs
 * as edit.
 */
export function adeOpenCodeMode(mode: string | null | undefined): PermissionMode | null {
  if (!mode || mode === "config-toml") return null;
  return mode === "plan" || mode === "full-auto" ? mode : "edit";
}

/**
 * The rules ADE puts on the session itself. OpenCode gives a child session its
 * parent's session rules, but not its parent's agent rules, so without these a
 * `general` subagent in edit mode writes files with no ask.
 */
export function openCodeSessionRulesFor(mode: string | null | undefined): OpenCodePermissionRule[] {
  const effective = adeOpenCodeMode(mode);
  return effective ? buildOpenCodePermissions(effective) : [];
}

/** The ADE agent a session runs under for a permission mode, or null when ADE sets none. */
export function openCodeAgentFor(mode: string | null | undefined): OpenCodeAgentProfile | null {
  const effective = adeOpenCodeMode(mode);
  if (effective === "plan") return "ade-plan";
  if (effective === "full-auto") return "ade-full-auto";
  return effective ? "ade-edit" : null;
}

function normalizeProviderModelId(descriptor: ModelDescriptor): string {
  const candidate = descriptor.providerModelId.trim();
  const providerPrefix = `${descriptor.family}/`;
  if (candidate.toLowerCase().startsWith(providerPrefix)) {
    const stripped = candidate.slice(providerPrefix.length).trim();
    return stripped || candidate;
  }
  return candidate;
}

/** The `{ providerID, id }` OpenCode 2.0 expects for a model in ADE's registry. */
export function resolveOpenCodeModelRef(descriptor: ModelDescriptor): { providerID: string; id: string } {
  const opPid = descriptor.openCodeProviderId?.trim();
  const opMid = descriptor.openCodeModelId?.trim();
  if (opPid && opMid) return { providerID: opPid, id: opMid };
  if (descriptor.providerRoute === "opencode" || descriptor.openCodeProviderId) {
    const decoded = decodeOpenCodeRegistryId(descriptor.id);
    if (decoded) return { providerID: decoded.openCodeProviderId, id: decoded.openCodeModelId };
  }
  return { providerID: descriptor.family, id: normalizeProviderModelId(descriptor) };
}

/**
 * Provider ids OpenCode ships in its built-in catalog. A custom model slug
 * (`providerId/modelId`) on one of these may be declared with an empty model
 * block — OpenCode already knows the package and endpoint. Slugs for other
 * providers that are not user-configured are dropped: a bare block would leave
 * OpenCode unable to load the provider.
 */
const KNOWN_OPENCODE_CATALOG_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "azure",
  "amazon-bedrock",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "togetherai",
  "fireworks-ai",
  "cerebras",
  "cohere",
  "perplexity",
  "deepinfra",
  "github-copilot",
  "github-models",
  "huggingface",
  "moonshotai",
  "zhipuai",
  "opencode",
  "opencode-go",
  "ollama",
  "lmstudio",
]);

/** An AI SDK npm package in 2.0's `package` syntax. */
function aiSdkPackage(npm: string | null | undefined): string {
  const trimmed = trimToUndefined(npm);
  if (!trimmed || trimmed === "@ai-sdk/openai-compatible") return "@opencode/ai/providers/openai-compatible";
  return trimmed.startsWith("aisdk:") || trimmed.startsWith("@opencode/") ? trimmed : `aisdk:${trimmed}`;
}

function buildProviders(args: BuildOpenCodeConfigArgs): OpenCodeProviderMap | undefined {
  // Every project setting the config reads comes from this one projection,
  // which also decides the shared server (`sharedOpenCodeProfileFor`).
  const { apiKeys, localProviders, customProviders, customModelSlugs } = projectOpenCodeSettings(args.projectConfig);
  const providers: OpenCodeProviderMap = {};

  const addApiKey = (id: string, key: string | null | undefined): void => {
    const apiKey = trimToUndefined(key);
    if (!apiKey) return;
    const existing = providers[id];
    providers[id] = { ...existing, settings: { ...existing?.settings, apiKey } };
  };

  // Resolve a stored API key for a specific provider id. A no-op when the key
  // store is unavailable (e.g. unit tests), so the config still builds.
  let resolveStoredApiKey: (id: string) => string | null = () => null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require("../ai/apiKeyStore") as {
      getAllApiKeys: () => Record<string, string>;
      getApiKey: (id: string) => string | null;
    };
    for (const [providerId, key] of Object.entries(store.getAllApiKeys())) {
      addApiKey(providerId.trim().toLowerCase(), key);
    }
    resolveStoredApiKey = (id: string) => store.getApiKey(id);
  } catch {
    // Key store may not be available (e.g. unit tests).
  }
  // Project-config keys win over stored ones.
  for (const [providerId, key] of Object.entries(apiKeys)) addApiKey(providerId, key);

  const discoveredByFamily = new Map<LocalProviderFamily, DiscoveredLocalModelEntry[]>();
  for (const entry of args.discoveredLocalModels ?? []) {
    const list = discoveredByFamily.get(entry.provider) ?? [];
    list.push(entry);
    discoveredByFamily.set(entry.provider, list);
  }

  const addLocalProvider = (
    family: LocalProviderFamily,
    settings: AiLocalProviderConfigs[LocalProviderFamily] | undefined,
  ): void => {
    if (settings?.enabled === false) return;
    const models: Record<string, OpenCodeModelBlock> = {};
    for (const { modelId, loaded } of discoveredByFamily.get(family) ?? []) {
      if (loaded === false) continue;
      models[modelId] = { name: modelId };
    }
    const endpoint = trimToUndefined(settings?.endpoint);
    const modelCount = Object.keys(models).length;
    // Say nothing about a provider the user never set up: ADE's config layers
    // over the user's, and an invented endpoint would repoint a remote host the
    // user configured back at localhost.
    if (!endpoint && !modelCount) return;
    // Only an isolated server may fill in ollama's default endpoint: it loads no
    // user config, so nothing else can supply the address and nothing is clobbered.
    const resolvedEndpoint = endpoint
      ?? (args.isolated && family === "ollama" && modelCount ? getLocalProviderDefaultEndpoint(family) : undefined);
    providers[family] = {
      ...providers[family],
      // lmstudio is in OpenCode's catalog; ollama is not and needs a package.
      ...(family === "ollama" ? { package: "@opencode/ai/providers/openai-compatible" } : {}),
      ...(resolvedEndpoint
        ? { settings: { ...providers[family]?.settings, baseURL: ensureOpenCodeBaseURL(resolvedEndpoint) } }
        : {}),
      ...(modelCount ? { models } : {}),
    };
  };
  addLocalProvider("ollama", localProviders.ollama);
  addLocalProvider("lmstudio", localProviders.lmstudio);

  addCustomProviders(providers, customProviders, resolveStoredApiKey);
  mergeCustomModelSlugs(providers, customModelSlugs);

  for (const [id, block] of Object.entries(args.presetProviders ?? {})) {
    providers[id] = { ...providers[id], ...block };
  }
  return Object.keys(providers).length ? providers : undefined;
}

function addCustomProviders(
  providers: OpenCodeProviderMap,
  customProviders: AiCustomProviderConfig[] | undefined,
  resolveStoredApiKey: (id: string) => string | null,
): void {
  for (const entry of customProviders ?? []) {
    const id = entry?.id?.trim();
    const baseURL = entry?.baseURL?.trim();
    const models = (entry?.models ?? [])
      .map((model) => model?.trim())
      .filter((model): model is string => Boolean(model));
    if (!id || !baseURL || models.length === 0) {
      console.warn("opencode.custom_provider_skipped", {
        id: entry?.id,
        reason: !id ? "missing-id" : !baseURL ? "missing-baseURL" : "no-models",
      });
      continue;
    }
    const apiKey = trimToUndefined(resolveStoredApiKey(id));
    const existing = providers[id];
    providers[id] = {
      ...existing,
      package: aiSdkPackage(entry.npm),
      name: trimToUndefined(entry.name) ?? id,
      settings: { ...existing?.settings, baseURL, ...(apiKey ? { apiKey } : {}) },
      models: {
        ...existing?.models,
        ...Object.fromEntries(models.map((modelId) => [modelId, {}])),
      },
    };
  }
}

function mergeCustomModelSlugs(providers: OpenCodeProviderMap, customModelSlugs: string[] | undefined): void {
  for (const raw of customModelSlugs ?? []) {
    const slug = raw?.trim();
    if (!slug) continue;
    const slashIndex = slug.indexOf("/");
    const providerId = slashIndex > 0 ? slug.slice(0, slashIndex).trim() : "";
    const modelId = slashIndex > 0 ? slug.slice(slashIndex + 1).trim() : "";
    if (!providerId || !modelId) {
      console.warn("opencode.custom_model_slug_skipped", { slug: raw, reason: "malformed" });
      continue;
    }
    const existing = providers[providerId];
    if (existing || KNOWN_OPENCODE_CATALOG_PROVIDER_IDS.has(providerId.toLowerCase())) {
      providers[providerId] = {
        ...existing,
        models: { ...existing?.models, [modelId]: existing?.models?.[modelId] ?? {} },
      };
      continue;
    }
    console.warn("opencode.custom_model_slug_skipped", { slug: raw, reason: "unknown-provider" });
  }
}

export function buildOpenCodeConfig(args: BuildOpenCodeConfigArgs): OpenCodeServerConfig {
  const providers = buildProviders(args);
  const skills = (args.agentSkillRoots ?? []).map((root) => root.trim()).filter(Boolean);
  // The mode agents stay visible: OpenCode's terminal app replaces a hidden
  // agent with `build` on its first prompt, which would run a plan-mode
  // terminal with edits allowed. Only the one-shot helper is hidden.
  const agent = (mode: PermissionMode | "helper", extra: Record<string, unknown> = {}) => ({
    mode: "primary",
    hidden: mode === "helper",
    permissions: buildOpenCodePermissions(mode),
    ...extra,
  });
  return {
    ...(providers ? { providers } : {}),
    ...(args.mcpServers && Object.keys(args.mcpServers).length ? { mcp: { servers: args.mcpServers } } : {}),
    ...(skills.length ? { skills } : {}),
    agents: {
      "ade-plan": agent("plan"),
      "ade-edit": agent("edit"),
      "ade-full-auto": agent("full-auto"),
      "ade-helper": agent("helper", { steps: 1 }),
    },
    // ADE has no share UI, and pins the binary itself.
    share: "disabled",
    update: "disable",
  };
}

/**
 * The server profile a config belongs on. Configs that differ per chat (their
 * own MCP servers, a preset provider, an isolated surface) cannot share the
 * common server, so they get one keyed by their content.
 */
/** The shared server for projects with no OpenCode settings of their own. */
export const SHARED_OPENCODE_PROFILE: OpenCodeServerProfile = { key: "shared", isolated: false, shared: true };

export const PERSONAL_OPENCODE_PROFILE: OpenCodeServerProfile = { key: "shared:personal", isolated: false, shared: true };

type ProjectOpenCodeSettings = {
  apiKeys: NonNullable<NonNullable<EffectiveProjectConfig["ai"]>["apiKeys"]>;
  localProviders: NonNullable<NonNullable<EffectiveProjectConfig["ai"]>["localProviders"]>;
  customProviders: NonNullable<NonNullable<EffectiveProjectConfig["ai"]>["customProviders"]>;
  customModelSlugs: NonNullable<NonNullable<EffectiveProjectConfig["ai"]>["customModelSlugs"]>;
};

/** The project settings the generated config reads: keys, local servers, custom providers and slugs. */
function projectOpenCodeSettings(projectConfig: ProjectConfigFile | EffectiveProjectConfig): ProjectOpenCodeSettings {
  const ai = projectConfig.ai ?? {};
  return {
    apiKeys: ai.apiKeys ?? {},
    localProviders: ai.localProviders ?? {},
    customProviders: ai.customProviders ?? [],
    customModelSlugs: ai.customModelSlugs ?? [],
  };
}

function hasProjectOpenCodeSettings(settings: ProjectOpenCodeSettings): boolean {
  return Object.keys(settings.apiKeys).length > 0
    || Object.keys(settings.localProviders).length > 0
    || settings.customProviders.length > 0
    || settings.customModelSlugs.length > 0;
}

/**
 * Salted per process: profile keys appear in logs, and the settings hold API
 * keys, so a key must not be a stable fingerprint of a secret across runs.
 */
const PROFILE_DIGEST_SALT = randomBytes(16).toString("hex");

function digestOf(value: unknown): string {
  return createHash("sha256").update(PROFILE_DIGEST_SALT).update(stableStringify(value)).digest("hex").slice(0, 16);
}

/**
 * The shared server for a project. One brain can serve several projects, and
 * their settings can differ; one config file per server would make them
 * overwrite each other. Projects with the same settings (the usual case)
 * still share one server.
 */
export function sharedOpenCodeProfileFor(projectConfig: ProjectConfigFile | EffectiveProjectConfig): OpenCodeServerProfile {
  const settings = projectOpenCodeSettings(projectConfig);
  return hasProjectOpenCodeSettings(settings)
    ? { key: `shared:${digestOf(settings)}`, isolated: false, shared: true }
    : SHARED_OPENCODE_PROFILE;
}

export function openCodeProfileFor(args: {
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  isolated?: boolean;
  personal?: boolean;
  mcpServers?: Record<string, OpenCodeMcpServerConfig>;
  presetProviders?: OpenCodeProviderMap;
}): OpenCodeServerProfile {
  const hasMcp = Boolean(args.mcpServers && Object.keys(args.mcpServers).length);
  const hasPreset = Boolean(args.presetProviders && Object.keys(args.presetProviders).length);
  if (!args.isolated && !hasMcp && !hasPreset) {
    return args.personal ? PERSONAL_OPENCODE_PROFILE : sharedOpenCodeProfileFor(args.projectConfig);
  }
  const digest = digestOf({
    isolated: Boolean(args.isolated),
    personal: Boolean(args.personal),
    mcp: args.mcpServers ?? {},
    preset: args.presetProviders ?? {},
    project: projectOpenCodeSettings(args.projectConfig),
  });
  return { key: `profile:${digest}`, isolated: Boolean(args.isolated), shared: false };
}
