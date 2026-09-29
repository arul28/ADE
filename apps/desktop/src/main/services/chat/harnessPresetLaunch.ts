/**
 * Turning a saved harness preset into a launch.
 *
 * A preset (`shared/harnessPresets.ts`) is a *body* (which harness ADE runs)
 * paired with a *brain* (where its intelligence comes from). The data model
 * deliberately knows nothing about processes; this module is the other half —
 * it reads one preset and answers the only question a launch actually asks:
 * **what environment does this process start with, and on what model.**
 *
 * Three rules shape everything below.
 *
 * 1. **A config home is never shared.** A key-sourced preset gets its own
 *    directory under `<adeHome>/provider-homes/preset/<presetId>/`, while a
 *    direct credential gets `<adeHome>/provider-homes/credential/<provider-id>`.
 *    ADE writes into those and nowhere else — in particular it never touches `~/.codex/`
 *    or `~/.claude/`, because those are the user's own sign-ins and a preset
 *    that rewrote them would silently repoint every other chat on the machine.
 * 2. **Unsupported is a value, not a throw.** Six of the ten harnesses have no
 *    documented way to take an API key from the outside. Saying so — with the
 *    reason, in the user's words — lets the chat fall back to the harness's
 *    native sign-in and post a notice. Throwing would just fail the launch.
 * 3. **The model id is passed through.** Every other ADE launch path rewrites
 *    a Claude model id through `resolveClaudeCliModelAlias`'s substring table,
 *    which is right for ADE's own catalog and wrong for a preset: a preset's
 *    model can be a gateway's id (`anthropic/claude-opus-4.5` on OpenRouter)
 *    that must reach the endpoint exactly as typed. `passthroughModelId` is
 *    how a launch site knows not to rewrite.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  harnessBodyLabel,
  HARNESS_PRESET_AGENT_FOLLOWS,
  HARNESS_PRESET_AGENT_KEYS,
  HARNESS_PRESET_SUBAGENT_INHERIT,
  DEFAULT_HARNESS_PRESET_ACCENT,
  type HarnessPreset,
  type HarnessPresetAgentKey,
  type HarnessPresetBody,
} from "../../../shared/harnessPresets";
import { buildClaudeBuiltinAgentOverrides } from "../../../shared/claudeBuiltinAgentPrompts";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import { cliPresetGateReason } from "../../../shared/harnessPresetCliGate";
import type { TrackedCliPresetLaunch } from "../../../shared/cliLaunch";
import {
  isHarnessPresetBody,
  credentialStoreProviderForHarness,
} from "../../../shared/harnessCredentialProviders";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import { getApiCredentialKey, getApiCredentialSummary } from "../ai/apiKeyStore";
import { resolveProviderInstanceForLaunch } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { isBaseProviderInstance } from "../../../shared/types/providerInstances";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  isProxySubscriptionHarness,
  proxyEnvForSubscription,
  type ProxySubscriptionEnvironment,
  type ProxySubscriptionProvider,
} from "../../../../../ade-cli/src/services/proxy/proxyEnv";
import {
  buildCodexPresetConfigToml,
  buildCodexProxyConfigToml,
  credentialConfigHome,
  routeConfigHome,
  pruneStaleRouteConfigHomes,
  type HarnessPresetOpenCodeProvider,
  presetConfigHome,
  pruneOrphanedPresetConfigHomes,
  writeDroidPresetSettings,
  writeOpenCodePresetConfig,
} from "./harnessPresetConfigHomes";
import { readHarnessPresetsFromMachine } from "./harnessPresetSettings";
import { buildKeySourceLaunch, guardedPrivateHomeWrite } from "./harnessKeySourceLaunch";
import {
  buildRouteLaunch,
  buildSubscriptionRouteLaunch,
  type RouteLaunchResult,
  type RouteReasonCode,
} from "./harnessRouteLaunch";
import {
  decodeRoutePresetId,
  harnessAcceptsRoutes,
  isRoutePresetId,
  launchModelIdFor,
  stripTrailingV1,
  type HarnessRoute,
} from "../../../shared/harnessRoutes";

import { resolveCredentialForLaunch } from "./harnessPresetCredentialCatalog";
// The owner-only directory/file primitives live in the CLI's trusted-tools
// module, which is also where `harnessPresetConfigHomes` takes them from.
// Aliased so every call site in this file keeps the harness-facing spelling.
import {
  ensurePrivateDirectory,
  writePrivateFile,
  type PrivateFileSecurityOptions as HarnessPrivateFileSecurity,
} from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import {
  defaultReadProxyConnection,
  type ProxySubscriptionConnectionParts,
  type ProxySubscriptionConnectionUnavailable,
} from "./harnessPresetProxyConnection";

/** The OpenCode provider id ADE files a proxied subscription under. */
const PROXY_OPENCODE_PROVIDER_ID = "ade-proxy";

/** What a launch site needs to start a process under a preset. */
export type HarnessPresetLaunchPlan = {
  status: "ready";
  presetId: string | null;
  /** The harness to run. Never differs from the session's own provider. */
  provider: HarnessPresetBody;
  /** Set only for an `account` source — the provider instance to launch under. */
  instanceId?: string;
  /** Environment patch. Spread onto a copy of the caller's env, never assigned over it. */
  env: Record<string, string>;
  /** Model id exactly as the preset states it. */
  model: string;
  /** Always true on a preset plan: the id reaches the harness unrewritten. */
  passthroughModelId: true;
  reasoningEffort?: string;
  /** Resolved subagent model, absent when the preset says "same as main". */
  subagentModel?: string;
  /** SDK `agents` entries for the built-ins this preset pinned. Claude only. */
  claudeAgents?: Record<string, { description: string; prompt: string; model: string; disallowedTools?: string[] }>;
  /** The preset-owned `CODEX_HOME` ADE created and wrote `config.toml` into. */
  codexConfigHome?: string;
  /** Provider block for OpenCode's config, when the preset is a key on OpenCode. */
  openCodeProvider?: HarnessPresetOpenCodeProvider;
  /** The ADE-owned OpenCode config file containing that provider block. */
  openCodeConfigPath?: string;
  /**
   * Capabilities this preset asked for that the harness cannot honour, in the
   * user's words. The chat posts them as notices; the launch still happens.
   */
  notes?: string[];
  /** How a key/OpenCode source reached the harness: direct, or via ADE's proxy. */
  route?: HarnessRoute;
  /**
   * When the plan's token stops working (an OpenCode OAuth login). A caller
   * that caches the plan resolves again after this: on a proxied route that
   * rewrites the proxy upstream with the refreshed token, which a running
   * harness picks up on its next request. A direct route's running process
   * keeps the token it started with until it restarts.
   */
  expiresAt?: number;
};

export type HarnessPresetLaunchUnsupported = {
  status: "unsupported";
  presetId: string | null;
  provider: HarnessPresetBody | null;
  /** One sentence, shown to the user. The chat falls back to native sign-in. */
  unsupported: string;
  /** Set when a caller can fix the cause itself (`harnessLaunchPrepare` starts the proxy). */
  reasonCode?: RouteReasonCode;
};

export type HarnessPresetLaunchResult = HarnessPresetLaunchPlan | HarnessPresetLaunchUnsupported;

export type HarnessPresetLaunchDeps = {
  /** Reads the account-scoped preset list. Defaults to the machine's settings cache. */
  readPresets?: () => HarnessPreset[];
  /** Machine ADE home. Defaults to `resolveMachineAdeDir()`. */
  adeHome?: string;
  listCredentials?: (provider?: string) => ApiCredentialSummary[];
  /** OpenCode custom-provider ids from the effective project config. */
  customProviderIds?: readonly string[];
  getCredentialSummary?: (provider: string, credentialId: string) => ApiCredentialSummary | null;
  getCredentialKey?: (provider: string, credentialId: string) => string | null;
  resolveInstance?: (
    provider: string,
    instanceId: string | null | undefined,
  ) => { id: string; provider: "claude" | "codex"; configHome: string } | null;
  /**
   * The proxy connection for one provider: port + shared api key + the login's
   * routing prefix. `proxy-stopped` is distinct from a live proxy with no
   * matching login, so a subscription launch can tell the user what to fix.
   */
  readProxyConnection?: (
    provider: ProxySubscriptionProvider,
  ) => ProxySubscriptionConnectionParts | ProxySubscriptionConnectionUnavailable | null;
  /** Security seams are injectable so Windows ACL behavior is testable off-host. */
  platform?: NodeJS.Platform;
  aclRunner?: HarnessPrivateFileSecurity["aclRunner"];
  currentWindowsUser?: string;
  /** False for previews: return the launch paths without writing config files. */
  writeConfig?: boolean;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } | null;
};

// The per-harness key table lives in `harnessKeySourceLaunch.ts`.
export { buildKeySourceLaunch, stripTrailingV1 };

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

function resolveSubagentModel(preset: HarnessPreset): string | undefined {
  const value = preset.subagentModel?.trim();
  if (!value || value === HARNESS_PRESET_SUBAGENT_INHERIT) return undefined;
  return value;
}

/**
 * Per-built-in model pins, with `follows` already resolved.
 *
 * `follows` means "take the subagent model", and the subagent model may itself
 * be `inherit` — in which case the pin resolves to the preset's own model. A
 * pin is only dropped when it names nothing at all.
 */
export function resolveAgentPins(preset: HarnessPreset): Partial<Record<HarnessPresetAgentKey, string>> {
  const subagent = resolveSubagentModel(preset) ?? preset.model?.trim();
  const pins: Partial<Record<HarnessPresetAgentKey, string>> = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const raw = preset.agentOverrides?.[key]?.trim();
    if (!raw) continue;
    const resolved = raw === HARNESS_PRESET_AGENT_FOLLOWS ? subagent : raw;
    if (resolved) pins[key] = resolved;
  }
  return pins;
}

/**
 * Claude's subagent-model env pair.
 *
 * The `_FORCE` half matters: without it the CLI treats the model as a default
 * a per-agent setting may override, and a preset that said "subagents on Haiku"
 * would silently keep running them on the main model.
 */
export function claudeSubagentEnv(subagentModel: string | undefined): Record<string, string> {
  if (!subagentModel) return {};
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
  };
}

/** Harnesses that can pin a subagent model. Everything else says so out loud. */
const SUBAGENT_MODEL_SUPPORTED: ReadonlySet<HarnessPresetBody> = new Set(["claude"]);

export function resolveHarnessPresetForLaunch(
  presetId: string | null | undefined,
  deps: HarnessPresetLaunchDeps = {},
): HarnessPresetLaunchResult | null {
  const id = typeof presetId === "string" ? presetId.trim() : "";
  if (!id) return null;
  // Refused before anything is read or written: an id that cannot name a
  // directory cannot name a preset either, and the answer must not depend on
  // the state of the disk.
  if (!isSafeIdentifier(id)) {
    return {
      status: "unsupported",
      presetId: id,
      provider: null,
      unsupported: "This harness preset id is unsafe; use only letters, digits, dot, underscore, and dash.",
    };
  }
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  if (isRoutePresetId(id)) {
    const routePreset = presetFromRouteId(id);
    if (!routePreset) {
      return {
        status: "unsupported",
        presetId: id,
        provider: null,
        unsupported: "This model choice could not be read. Pick the model again.",
      };
    }
    if (deps.writeConfig !== false) {
      pruneStaleRouteConfigHomes(adeHome, { platform: deps.platform, logger: deps.logger });
    }
    return resolveHarnessPresetPlan(routePreset, { ...deps, adeHome });
  }
  const presets = deps.readPresets?.() ?? readHarnessPresetsFromMachine(adeHome);
  // WHY the null check: the pruner deletes every preset home the list does not
  // mention, so running it on a list that is really "this machine could not
  // read the cache" wipes the private home of the very preset being launched —
  // including the file holding its API key. A failed read prunes nothing.
  if (presets === null) {
    return {
      status: "unsupported",
      presetId: id,
      provider: null,
      unsupported: "ADE could not read this account's harness presets on this machine.",
    };
  }
  if (deps.writeConfig !== false) {
    pruneOrphanedPresetConfigHomes(adeHome, presets, {
      platform: deps.platform,
      logger: deps.logger,
    });
  }
  const preset = presets.find((entry) => entry.id === id) ?? null;
  if (!preset) {
    return {
      status: "unsupported",
      presetId: id,
      provider: null,
      unsupported: "This harness preset no longer exists on this account.",
    };
  }
  return resolveHarnessPresetPlan(preset, { ...deps, adeHome });
}

/**
 * An ad-hoc route (a picker choice, not a saved preset) as a preset object, so
 * it resolves through exactly the same code as a saved one. Its config home is
 * named after a hash of the route and lives under `route/`, outside the
 * preset namespace the orphan pruner sweeps.
 */
function presetFromRouteId(presetId: string): HarnessPreset | null {
  const spec = decodeRoutePresetId(presetId);
  if (!spec) return null;
  const homeId = `r${createHash("sha256").update(presetId).digest("hex").slice(0, 16)}`;
  const epoch = new Date(0).toISOString();
  return {
    id: homeId,
    name: spec.model,
    harness: spec.harness,
    source: spec.source,
    model: spec.model,
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    accentColor: DEFAULT_HARNESS_PRESET_ACCENT,
    logo: { kind: "ade" },
    createdAt: epoch,
    updatedAt: epoch,
  };
}

/** Preset homes are pruned against the saved list; route homes are not. */
function isRouteHomeId(id: string): boolean {
  return /^r[0-9a-f]{16}$/.test(id);
}

/** The private config home a preset (or an ad-hoc route) launches in. */
function configHomeFor(adeHome: string, preset: HarnessPreset): string {
  return isRouteHomeId(preset.id) ? routeConfigHome(adeHome, preset.id) : presetConfigHome(adeHome, preset.id);
}

/**
 * Mark a route's private home as in use. Stale route homes are pruned by the
 * directory's mtime, which rewriting a file inside it does not change.
 */
function touchConfigHome(configHome: string, writeConfig: boolean): void {
  if (!writeConfig) return;
  try {
    const now = new Date();
    fs.utimesSync(configHome, now, now);
  } catch {
    // No home on disk (a Claude route writes none): nothing to keep alive.
  }
}

/** Run a route build, turning a filesystem throw into `unsupported` when it writes. */
function runRouteBuild(writeConfig: boolean, build: () => RouteLaunchResult): RouteLaunchResult {
  if (!writeConfig) return build();
  const guarded = guardedPrivateHomeWrite(build);
  return guarded.status === "ready" ? guarded.value : guarded;
}

export function resolveHarnessPresetPlan(
  preset: HarnessPreset,
  deps: HarnessPresetLaunchDeps = {},
): HarnessPresetLaunchResult {
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  const writeConfig = deps.writeConfig !== false;
  const security: HarnessPrivateFileSecurity = {
    platform: deps.platform,
    aclRunner: deps.aclRunner,
    currentUser: deps.currentWindowsUser,
  };
  const harness = preset.harness;
  const notes: string[] = [];

  if (!isSafeIdentifier(preset.id)) {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: "This harness preset id is unsafe; use only letters, digits, dot, underscore, and dash.",
    };
  }

  const subagentModel = resolveSubagentModel(preset);
  if (subagentModel && !SUBAGENT_MODEL_SUPPORTED.has(harness)) {
    notes.push(
      `${harness} runs its subagents on the main model, so this preset's subagent model is not applied.`,
    );
  }

  const base: Omit<HarnessPresetLaunchPlan, "env"> = {
    status: "ready",
    presetId: preset.id,
    provider: harness,
    model: preset.model,
    passthroughModelId: true,
    ...(preset.reasoningEffort?.trim() ? { reasoningEffort: preset.reasoningEffort.trim() } : {}),
    ...(subagentModel && SUBAGENT_MODEL_SUPPORTED.has(harness) ? { subagentModel } : {}),
  };

  // `modelPrefix` is set on a route translated through ADE's proxy, which only
  // routes model ids that carry it — the subagent model and every pin too.
  const claudeExtras = (modelPrefix = ""): Pick<HarnessPresetLaunchPlan, "claudeAgents"> & { env: Record<string, string> } => {
    if (harness !== "claude") return { env: {} };
    const pins = Object.fromEntries(
      Object.entries(resolveAgentPins(preset)).map(([agent, model]) => [agent, `${modelPrefix}${model}`]),
    ) as ReturnType<typeof resolveAgentPins>;
    const agents = buildClaudeBuiltinAgentOverrides(pins);
    return {
      env: claudeSubagentEnv(subagentModel ? `${modelPrefix}${subagentModel}` : undefined),
      ...(Object.keys(agents).length ? { claudeAgents: agents } : {}),
    };
  };

  if (preset.source.kind === "account") {
    const resolveInstance = deps.resolveInstance ?? resolveProviderInstanceForLaunch;
    const instance = resolveInstance(preset.source.provider, preset.source.instanceId);
    if (!instance) {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: "The account this preset signs in with is no longer on this machine.",
      };
    }
    if (instance.provider !== harness) {
      // A Claude account cannot sign a Codex harness in. The proxy exists for
      // exactly that case, and this preset did not ask for it.
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported:
          `A ${instance.provider} account cannot sign ${harness} in directly. Use a subscription source to borrow it through ADE's proxy.`,
      };
    }
    const extras = claudeExtras();
    return {
      ...base,
      instanceId: instance.id,
      env: {
        // The base identity inherits the environment (`isBaseProviderInstance`);
        // only a second account gets its config home exported.
        ...(isBaseProviderInstance(instance)
          ? {}
          : instance.provider === "claude"
            ? { CLAUDE_CONFIG_DIR: instance.configHome }
            : { CODEX_HOME: instance.configHome }),
        ...extras.env,
      },
      ...(extras.claudeAgents ? { claudeAgents: extras.claudeAgents } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  if (preset.source.kind === "subscription") {
    // Only three harnesses can be pointed at an OpenAI/Anthropic-shaped
    // endpoint the proxy speaks. The rest read their identity from their own
    // sign-in and have no endpoint to redirect, which is a capability gap to
    // state rather than a failure to raise.
    if (!isProxySubscriptionHarness(harness)) {
      if (!harnessAcceptsRoutes(harness)) {
        return {
          status: "unsupported",
          presetId: preset.id,
          provider: harness,
          unsupported:
            `${harnessBodyLabel(harness)} cannot be pointed at ADE's proxy — it reads its own sign-in and takes no endpoint.`,
        };
      }
      // Grok, Droid and Qwen take an endpoint through their own config/env
      // shape, which the route writer already knows; the proxy holds the login.
      const readConnection = deps.readProxyConnection ?? defaultReadProxyConnection(adeHome);
      const connection = readConnection(preset.source.provider);
      if (!connection || "reason" in connection) {
        return {
          status: "unsupported",
          presetId: preset.id,
          provider: harness,
          unsupported: !connection
            ? "Sign-in through ADE's proxy is not available yet."
            : "Sign-in through ADE's proxy is stopped; start the proxy and try again.",
          ...(connection ? { reasonCode: "proxy-not-ready" as const } : {}),
        };
      }
      const subscriptionProvider = preset.source.provider;
      const built = runRouteBuild(writeConfig, () => buildSubscriptionRouteLaunch({
        harness,
        provider: subscriptionProvider,
        model: preset.model,
        configHome: configHomeFor(adeHome, preset),
        prefix: connection.prefix,
        deps: { adeHome, writeConfig, security },
      }));
      if (built.status === "unsupported") {
        return {
          status: "unsupported",
          presetId: preset.id,
          provider: harness,
          unsupported: built.unsupported,
          ...(built.reasonCode ? { reasonCode: built.reasonCode } : {}),
        };
      }
      touchConfigHome(configHomeFor(adeHome, preset), writeConfig);
      return {
        ...base,
        model: built.model,
        env: built.env,
        route: built.route,
        ...(notes.length ? { notes } : {}),
      };
    }
    const readConnection = deps.readProxyConnection ?? defaultReadProxyConnection(adeHome);
    const connection = readConnection(preset.source.provider);
    if (!connection) {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: "Sign-in through ADE's proxy is not available yet.",
      };
    }
    if ("reason" in connection && connection.reason === "proxy-stopped") {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: "Sign-in through ADE's proxy is stopped; start the proxy and try again.",
        reasonCode: "proxy-not-ready",
      };
    }
    const parts = connection as ProxySubscriptionConnectionParts;
    let proxy: ProxySubscriptionEnvironment;
    try {
      proxy = proxyEnvForSubscription(
        preset.source.provider,
        harness,
        { ...parts, model: preset.model },
      );
    } catch {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: "Sign-in through ADE's proxy is not available yet.",
      };
    }
    // The proxy routes a subscription by its login's prefix, so a pinned
    // subagent model and the built-in pins must carry it as the main model does.
    const extras = claudeExtras(`${parts.prefix}/`);
    const env: Record<string, string> = { ...proxy.env, ...extras.env };
    const configureSubscriptionConfig = () => {
      let codexConfigHome: string | undefined;
      let openCodeProvider: HarnessPresetOpenCodeProvider | undefined;
      let openCodeConfigPath: string | undefined;
      if (proxy.codexConfigToml) {
        // Codex takes a provider as TOML or not at all, so the fragment is
        // written into a home ADE owns. `~/.codex/config.toml` is never touched:
        // CODEX_HOME moves the whole directory, leaving the user's own sign-in
        // exactly where it was.
        codexConfigHome = presetConfigHome(adeHome, preset.id);
        if (writeConfig) {
          ensurePrivateDirectory(codexConfigHome, security);
          writePrivateFile(
            path.join(codexConfigHome, "config.toml"),
            buildCodexProxyConfigToml(proxy.codexConfigToml),
            security,
          );
        }
        env.CODEX_HOME = codexConfigHome;
      }
      if (proxy.opencodeProvider) {
        openCodeProvider = {
          id: PROXY_OPENCODE_PROVIDER_ID,
          block: {
            npm: "@ai-sdk/openai-compatible",
            name: "ADE proxy",
            options: {
              baseURL: proxy.opencodeProvider.baseURL,
              apiKey: proxy.opencodeProvider.apiKey,
            },
            models: { [proxy.opencodeProvider.model]: {} as Record<string, never> },
          },
        };
        openCodeConfigPath = writeConfig
          ? writeOpenCodePresetConfig(
            presetConfigHome(adeHome, preset.id),
            openCodeProvider,
            security,
          )
          : path.join(presetConfigHome(adeHome, preset.id), "opencode.json");
        env.OPENCODE_CONFIG = openCodeConfigPath;
      }
      return { codexConfigHome, openCodeProvider, openCodeConfigPath };
    };
    const guardedConfig = writeConfig
      ? guardedPrivateHomeWrite(configureSubscriptionConfig)
      : { status: "ready" as const, value: configureSubscriptionConfig() };
    if (guardedConfig.status === "unsupported") {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: guardedConfig.unsupported,
      };
    }
    const { codexConfigHome, openCodeProvider, openCodeConfigPath } = guardedConfig.value;
    return {
      ...base,
      // The proxy routes by a prefixed model id (`<prefix>/<model>`), so the
      // launch must use the proxy's spelling, not the preset's raw one.
      model: proxy.model,
      env,
      ...(extras.claudeAgents ? { claudeAgents: extras.claudeAgents } : {}),
      ...(codexConfigHome ? { codexConfigHome } : {}),
      ...(openCodeProvider ? { openCodeProvider } : {}),
      ...(openCodeConfigPath ? { openCodeConfigPath } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }

  if (preset.source.kind === "opencode" && harness === "opencode") {
    // OpenCode already holds this sign-in: the model is simply one of its own.
    return {
      ...base,
      model: launchModelIdFor(harness, preset.source, preset.model),
      env: {},
      route: { kind: "native" },
      ...(notes.length ? { notes } : {}),
    };
  }

  // Kimi and Copilot take no endpoint, only their vendor's key in an env var,
  // so their key presets keep the plain key path below rather than a route.
  const routable = harnessAcceptsRoutes(harness) && harness !== "opencode";
  if (preset.source.kind === "opencode" || (preset.source.kind === "key" && routable)) {
    const routeSource = preset.source;
    const routed = runRouteBuild(writeConfig, () => buildRouteLaunch({
      harness,
      source: routeSource,
      model: preset.model,
      configHome: configHomeFor(adeHome, preset),
      ...(subagentModel ? { subagentModel } : {}),
      pinnedModels: harness === "claude" ? Object.values(resolveAgentPins(preset)) : [],
      deps: {
        adeHome,
        writeConfig,
        security,
        ...(deps.getCredentialSummary ? { getCredentialSummary: deps.getCredentialSummary } : {}),
        ...(deps.getCredentialKey ? { getCredentialKey: deps.getCredentialKey } : {}),
      },
    }));
    if (routed.status === "unsupported") {
      return {
        status: "unsupported",
        presetId: preset.id,
        provider: harness,
        unsupported: routed.unsupported,
        ...(routed.reasonCode ? { reasonCode: routed.reasonCode } : {}),
      };
    }
    const extras = claudeExtras(routed.modelPrefix);
    touchConfigHome(configHomeFor(adeHome, preset), writeConfig);
    return {
      ...base,
      model: routed.model,
      env: { ...routed.env, ...extras.env },
      route: routed.route,
      ...(routed.expiresAt ? { expiresAt: routed.expiresAt } : {}),
      ...(extras.claudeAgents ? { claudeAgents: extras.claudeAgents } : {}),
      ...(routed.codexConfigHome ? { codexConfigHome: routed.codexConfigHome } : {}),
      ...(notes.length || routed.notes?.length ? { notes: [...notes, ...(routed.notes ?? [])] } : {}),
    };
  }

  // A key on OpenCode (a provider block in OpenCode's own config), or on Kimi
  // or Copilot (the vendor key in the env var that CLI reads).
  if (preset.source.kind !== "key") {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: "This preset's source cannot run in this harness.",
    };
  }
  const storeProvider = preset.source.provider?.trim() || credentialStoreProviderForHarness(harness);
  const sourceCredentialId = preset.source.credentialId.trim();
  if (!isSafeIdentifier(storeProvider) || !isSafeIdentifier(sourceCredentialId)) {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: "This preset uses an unsafe credential id; use only letters, digits, dot, underscore, and dash.",
    };
  }
  const getSummary = deps.getCredentialSummary ?? getApiCredentialSummary;
  const credential = getSummary(storeProvider, sourceCredentialId);
  if (!credential) {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: "The API key this preset uses is not on this machine.",
    };
  }
  const getKey = deps.getCredentialKey ?? getApiCredentialKey;
  const key = getKey(storeProvider, sourceCredentialId)?.trim();
  if (!key) {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: "The API key this preset uses could not be read from this machine's key store.",
    };
  }
  const keySource = buildKeySourceLaunch({
    harness,
    credential,
    key,
    adeHome,
    configHomeId: preset.id,
    platform: deps.platform,
    aclRunner: deps.aclRunner,
    currentWindowsUser: deps.currentWindowsUser,
    writeConfig: deps.writeConfig,
  });
  if (keySource.status === "unsupported") {
    return {
      status: "unsupported",
      presetId: preset.id,
      provider: harness,
      unsupported: keySource.unsupported,
    };
  }
  const extras = claudeExtras();
  return {
    ...base,
    env: { ...keySource.env, ...extras.env },
    ...(extras.claudeAgents ? { claudeAgents: extras.claudeAgents } : {}),
    ...(keySource.codexConfigHome ? { codexConfigHome: keySource.codexConfigHome } : {}),
    ...(keySource.openCodeProvider ? { openCodeProvider: keySource.openCodeProvider } : {}),
    ...(keySource.openCodeConfigPath ? { openCodeConfigPath: keySource.openCodeConfigPath } : {}),
    ...(notes.length || keySource.notes?.length
      ? { notes: [...notes, ...(keySource.notes ?? [])] }
      : {}),
  };
}

/**
 * The one entry point every launch site calls.
 *
 * A launch carries at most one of the two ids, and which one it carries is a
 * property of how the model was chosen — from the harnesses list, or from a
 * key's declared models under its provider. Collapsing both into one call is
 * what keeps "the model came from a preset" and "the model came from a key"
 * from growing two different environments for the same endpoint.
 *
 * Returns `null` when the launch names neither: the overwhelmingly common case,
 * and the one that must cost nothing.
 */
export function resolveLaunchBrain(
  args: {
    provider: string;
    presetId?: string | null;
    credentialId?: string | null;
  },
  deps: HarnessPresetLaunchDeps = {},
): HarnessPresetLaunchResult | null {
  const presetId = args.presetId?.trim();
  if (presetId) return resolveHarnessPresetForLaunch(presetId, deps);
  const credentialId = args.credentialId?.trim();
  if (!credentialId) return null;
  if (!isHarnessPresetBody(args.provider)) return null;
  return resolveCredentialForLaunch(args.provider, credentialId, deps);
}

export type HarnessPresetLaunchPreview = {
  status: "none" | "ready" | "unsupported" | "gated";
  presetId: string | null;
  provider: HarnessPresetBody | null;
  model: string | null;
  /** Environment projection with every non-empty credential value redacted. */
  env: Record<string, string>;
  reason?: string;
};

const PREVIEW_REDACTED_VALUE = "<redacted>";
const SECRET_ENV_KEY = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD)$/i;

function redactLaunchPreviewEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_ENV_KEY.test(key) && value.length > 0 ? PREVIEW_REDACTED_VALUE : value,
    ]),
  );
}

/**
 * Project the same resolved brain a launch will use without returning a secret.
 *
 * This intentionally calls `resolveLaunchBrain`, rather than reproducing its
 * source-specific environment table for a dry run. The projection only keeps
 * the safe model/environment fields and replaces credential values before they
 * leave this module. CLI mode applies the same native-CLI capability gate as a
 * tracked launch, so a print-config result cannot promise env that the real
 * CLI launch is forbidden to use.
 */
export function previewHarnessLaunchPlan(
  args: {
    provider: string;
    presetId?: string | null;
    credentialId?: string | null;
    mode?: "chat" | "cli";
  },
  deps: HarnessPresetLaunchDeps = {},
): HarnessPresetLaunchPreview {
  const provider = args.provider.trim().toLowerCase();
  const presetId = args.presetId?.trim() || null;
  const credentialId = args.credentialId?.trim() || null;
  const providerBody = isHarnessPresetBody(provider) ? provider : null;

  if (args.mode === "cli" && (presetId || credentialId)) {
    const gateReason = cliPresetGateReason(provider);
    if (gateReason) {
      return {
        status: "gated",
        presetId,
        provider: providerBody,
        model: null,
        env: {},
        reason: gateReason,
      };
    }
  }

  const result = resolveLaunchBrain(
    { provider, presetId, credentialId },
    { ...deps, writeConfig: false },
  );
  if (!result) {
    return { status: "none", presetId, provider: providerBody, model: null, env: {} };
  }
  if (result.status === "unsupported") {
    return {
      status: "unsupported",
      presetId: result.presetId,
      provider: result.provider,
      model: null,
      env: {},
      reason: result.unsupported,
    };
  }
  return {
    status: "ready",
    presetId: result.presetId,
    provider: result.provider,
    model: result.model.trim() || null,
    env: redactLaunchPreviewEnv(result.env),
  };
}

/** Narrow a result to a usable plan, swallowing the unsupported case. */
export function launchPlanOrNull(
  result: HarnessPresetLaunchResult | null | undefined,
): HarnessPresetLaunchPlan | null {
  return result?.status === "ready" ? result : null;
}

export type TrackedCliPresetResolution = {
  preset: TrackedCliPresetLaunch | null;
  model: string | null;
  gateReason: string | null;
};

/** Resolve the preset handshake once for every tracked-CLI launch surface. */
export function resolveTrackedCliPreset(
  provider: string,
  args: { presetId?: string | null; credentialId?: string | null },
  deps: HarnessPresetLaunchDeps = {},
): TrackedCliPresetResolution | null {
  const presetId = args.presetId?.trim() || null;
  const credentialId = args.credentialId?.trim() || null;
  if (!presetId && !credentialId) return null;

  const gateReason = cliPresetGateReason(provider);
  if (gateReason) return { preset: null, model: null, gateReason };

  const plan = launchPlanOrNull(resolveLaunchBrain({ provider, presetId, credentialId }, deps));
  if (!plan) return null;
  return {
    preset: { env: plan.env, passthroughModelId: true },
    model: plan.model.trim() || null,
    gateReason: null,
  };
}
