/**
 * Every model a harness could draw on outside its own sign-in.
 *
 * Sources are the machine's OpenCode sign-ins (OpenCode Go, Zen, and anything
 * signed in inside OpenCode) and its stored API keys. Model lists come from
 * what ADE already knows — a key's own declared models, OpenCode's cached
 * inventory for the same provider, then the static registry — so listing never
 * spends a request. Routes are computed in the renderer from the pure
 * `resolveHarnessRoute`, which is why each source ships its endpoints, its
 * sign-in kind and, per model, its probe verdict rather than a pre-decided
 * route.
 *
 * The live check behind the Test button lives with the verdicts it records, in
 * `harnessRouteProbes.ts`.
 */

import path from "node:path";

import {
  canonicalSourceProvider,
  endpointsForSource,
  harnessRouteSourceKey,
  KNOWN_SOURCE_ENDPOINTS,
  type HarnessRouteCatalog,
  type HarnessRouteModel,
  type HarnessRouteSource,
} from "../../../shared/harnessRoutes";
import { AdeExpectedError } from "../../../shared/expectedError";
import { harnessBodyLabel, isHarnessPresetAccountProvider, openCodeSourceLabel, type HarnessPresetBody, type HarnessPresetSource } from "../../../shared/harnessPresets";
import { providerLabel } from "../../../shared/modelCatalog";
import { decodeOpenCodeRegistryId, MODEL_REGISTRY, type ProviderFamily } from "../../../shared/modelRegistry";
import { listApiCredentials } from "../ai/apiKeyStore";
import {
  readOpenCodeSignedInProviderIds,
  readOpenCodeSignedInSources,
} from "../opencode/openCodeCredentials";
import { listPersistedOpenCodeProviderModels } from "../opencode/openCodeInventory";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import {
  cliLoginBorrowableAccounts,
  readBorrowedModels,
  type BorrowableProvider,
} from "../../../../../ade-cli/src/services/proxy/borrowedLogins";
import type { HarnessPresetLaunchResult } from "./harnessPresetLaunch";
import { readRouteProbe } from "./harnessRouteProbes";
import { routeSourceKey } from "./harnessRouteLaunch";
import { pinnedCliBinaries, requirePinnedProviderCli, type PinnedProviderCli } from "../pty/pinnedProviderCli";

/** Key-store providers whose keys never route: they sign their own tool in. */
const NON_ROUTABLE_KEY_PROVIDERS = new Set([
  "cursor", "devin", "factory", "droid", "copilot", "github-copilot",
  // Antigravity's Gemini and Agent Platform keys are read only by its own agent.
  "antigravity-gemini", "antigravity-agent-platform",
]);

const REGISTRY_FAMILY_FOR_PROVIDER: Record<string, ProviderFamily> = {
  anthropic: "anthropic",
  openai: "openai",
  deepseek: "deepseek",
  xai: "xai",
  moonshotai: "moonshot",
  mistral: "mistral",
  groq: "groq",
  google: "google",
  openrouter: "openrouter",
  together: "together",
};

function modelsForSource(
  source: Extract<HarnessPresetSource, { kind: "key" } | { kind: "opencode" }>,
  adeHome: string,
  declared?: readonly string[],
): HarnessRouteModel[] {
  const provider = canonicalSourceProvider(source.kind === "key" ? source.provider : source.providerId);
  const probeKey = routeSourceKey(source);
  const withProbe = (model: HarnessRouteModel): HarnessRouteModel => {
    const probe = readRouteProbe(adeHome, probeKey, model.id);
    return probe ? { ...model, probe } : model;
  };
  if (declared && declared.length > 0) {
    return declared.map((id) => withProbe({ id, label: id }));
  }
  const fromOpenCode = listPersistedOpenCodeProviderModels(provider);
  if (fromOpenCode.length > 0) {
    return fromOpenCode
      .filter((descriptor) => descriptor.openCodeModelId && !descriptor.deprecated)
      .map((descriptor) => withProbe({
        id: descriptor.openCodeModelId!,
        label: descriptor.displayName,
        ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
        ...(descriptor.maxOutputTokens ? { maxOutputTokens: descriptor.maxOutputTokens } : {}),
        ...(descriptor.reasoningTiers?.length ? { reasoningTiers: [...descriptor.reasoningTiers] } : {}),
      }));
  }
  const family = REGISTRY_FAMILY_FOR_PROVIDER[provider];
  if (!family) return [];
  return MODEL_REGISTRY
    .filter((model) => model.family === family && !model.deprecated)
    .map((model) => withProbe({
      id: model.providerModelId || model.shortId || model.id,
      label: model.displayName,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.reasoningTiers?.length ? { reasoningTiers: [...model.reasoningTiers] } : {}),
    }));
}

/** The whole catalog. Cheap: disk caches only, no network. */
export function listHarnessRouteCatalog(deps: { adeHome?: string } = {}): HarnessRouteCatalog {
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  const sources: HarnessRouteSource[] = [];

  // One store read gives every signed-in provider and its credential kind; the
  // kind follows the same first-row rule the launch resolver reads.
  for (const { providerId, signInKind } of readOpenCodeSignedInSources()) {
    const endpoints = KNOWN_SOURCE_ENDPOINTS[canonicalSourceProvider(providerId)] ?? {};
    if (Object.keys(endpoints).length === 0) continue;
    const source = { kind: "opencode" as const, providerId };
    const models = modelsForSource(source, adeHome);
    if (models.length === 0) continue;
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label: openCodeSourceLabel(providerId),
      detail: "via your OpenCode sign-in",
      logoProvider: providerId,
      endpoints,
      ...(signInKind ? { signInKind } : {}),
      models,
    });
  }

  let credentials: ReturnType<typeof listApiCredentials> = [];
  try {
    credentials = listApiCredentials();
  } catch {
    credentials = [];
  }
  for (const credential of credentials) {
    const provider = credential.provider.trim().toLowerCase();
    if (NON_ROUTABLE_KEY_PROVIDERS.has(provider)) continue;
    const endpoints = endpointsForSource({
      provider,
      baseUrl: credential.baseUrl,
      protocol: credential.protocol,
    });
    if (Object.keys(endpoints).length === 0) continue;
    const source = {
      kind: "key" as const,
      provider: credential.provider,
      credentialId: credential.credentialId,
      label: credential.label?.trim() || credential.provider,
    };
    const models = modelsForSource(source, adeHome, credential.models);
    if (models.length === 0 && !credential.baseUrl) continue;
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label: credential.label?.trim() && credential.label.trim() !== credential.provider
        ? credential.label.trim()
        : providerLabel(canonicalSourceProvider(provider)),
      detail: credential.maskedTail ? `API key ••••${credential.maskedTail}` : "API key",
      logoProvider: provider,
      endpoints,
      models,
    });
  }

  sources.push(...lentLoginSources(adeHome));

  return { sources, proxyAvailable: true };
}

/** The registry's models for a lent provider, until the proxy has served its own list. */
const LENT_REGISTRY_FAMILY: Record<BorrowableProvider, ProviderFamily> = {
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  kimi: "moonshot",
  devin: "devin",
  muse: "muse",
};

/**
 * The models a lent login answers for: what the proxy last served for it
 * (`borrowed-models.json`, written after each lend pass), else the registry.
 */
function lentModels(served: readonly { id: string; label: string }[], provider: BorrowableProvider): HarnessRouteModel[] {
  if (served.length > 0) return served.map((model) => ({ id: model.id, label: registryLabel(model.id) ?? model.label }));
  const family = LENT_REGISTRY_FAMILY[provider];
  if (!family) return [];
  return MODEL_REGISTRY
    .filter((model) => model.family === family && !model.deprecated)
    .map((model) => ({
      id: model.providerModelId || model.shortId || model.id,
      label: model.displayName,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.reasoningTiers?.length ? { reasoningTiers: [...model.reasoningTiers] } : {}),
    }));
}

function registryLabel(id: string): string | null {
  return MODEL_REGISTRY.find((model) => model.providerModelId === id || model.shortId === id)?.displayName ?? null;
}

/**
 * Every Claude and Codex account, and this machine's Grok, Kimi, Devin and Muse
 * logins: each runs in another harness through ADE's proxy on its own login, lent to the proxy
 * (`borrowedLogins.ts`). The editor builds its Claude/Codex rows from the
 * accounts it already loads, so it skips the `account` rows here; the CLI's
 * `harness routes` lists them.
 */
function lentLoginSources(adeHome: string): HarnessRouteSource[] {
  const sources: HarnessRouteSource[] = [];
  const served = readBorrowedModels(path.join(adeHome, "proxy"));
  let accounts: ReturnType<ReturnType<typeof getMachineProviderInstanceStore>["list"]> = [];
  try {
    accounts = getMachineProviderInstanceStore().list();
  } catch {
    accounts = [];
  }
  for (const account of accounts) {
    if (account.provider !== "claude" && account.provider !== "codex") continue;
    const source = { kind: "account" as const, provider: account.provider, instanceId: account.id };
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label: `${account.provider === "claude" ? "Claude" : "Codex"} · ${account.label}`,
      detail: "Your sign-in, no extra login",
      logoProvider: account.provider,
      endpoints: {},
      models: lentModels(served[account.provider], account.provider),
    });
  }
  for (const login of cliLoginBorrowableAccounts()) {
    const provider = login.provider;
    const source = { kind: "subscription" as const, provider };
    const models = lentModels(served[provider], provider);
    if (models.length === 0) continue;
    const label = harnessBodyLabel(provider);
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label,
      detail: `Your ${label} sign-in, no extra login`,
      logoProvider: provider,
      endpoints: {},
      models,
    });
  }
  return sources;
}

/**
 * Whether a key, OpenCode or subscription source can back a launch on this
 * machine. The machine inventory uses it so a Custom provider built on one
 * reads as usable here, not only account-sourced ones. A Claude or Codex
 * subscription runs on the machine's default account, which always exists;
 * Grok's needs this machine's Grok sign-in.
 */
export function isPresetSourceAvailableLocally(source: HarnessPresetSource): boolean {
  try {
    if (source.kind === "subscription") {
      return isHarnessPresetAccountProvider(source.provider)
        || cliLoginBorrowableAccounts().some((login) => login.provider === source.provider);
    }
    if (source.kind === "opencode") {
      return readOpenCodeSignedInProviderIds().includes(source.providerId.trim());
    }
    if (source.kind === "key") {
      return listApiCredentials(source.provider.trim()).some((entry) => entry.credentialId === source.credentialId.trim());
    }
  } catch {
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The terminal launcher: `eval "$(ade harness env <preset>)" && claude`
// ---------------------------------------------------------------------------

export type HarnessLaunchShell = "zsh" | "bash" | "pwsh";

/** The variable `ade harness env` exports the resolved model id in. */
export const HARNESS_MODEL_ENV = "ADE_HARNESS_MODEL";

export type HarnessLaunchEnvResult = {
  harness: HarnessPresetBody;
  /** The model id the harness must be started on. */
  model: string;
  /**
   * Shell lines that export the environment and define the harness's command
   * as ADE's pinned copy. Contains secrets — print, never persist.
   */
  script: string;
};

function shellQuote(value: string, shell: HarnessLaunchShell): string {
  if (shell === "pwsh") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The model word the harness's own CLI takes. OpenCode spells a model
 * `<provider>/<model>`: its own sign-ins come as ADE's registry id
 * (`opencode/<provider>/<model>`), and a key or subscription block names its
 * provider in the config ADE wrote. Every other harness takes the plan's id.
 */
function cliModelFor(result: Extract<HarnessPresetLaunchResult, { status: "ready" }>): string {
  const model = result.model.trim();
  if (result.provider !== "opencode") return model;
  if (result.openCodeProvider) return `${result.openCodeProvider.id}/${model}`;
  const decoded = decodeOpenCodeRegistryId(model);
  return decoded ? `${decoded.openCodeProviderId}/${decoded.openCodeModelId}` : model;
}

/**
 * The function line that makes the harness's own command word run ADE's
 * pinned copy in the shell that evaluates the script. Functions win over the
 * PATH in zsh, bash and PowerShell, so a launcher's `claude --model …` runs
 * the pin, never a CLI the user installed.
 */
function pinnedCliFunction(cli: PinnedProviderCli, shell: HarnessLaunchShell): string {
  const name = pinnedCliBinaries(cli.provider)[0]!;
  const prefix = [cli.command, ...cli.leadingArgs].map((part) => shellQuote(part, shell)).join(" ");
  return shell === "pwsh"
    ? `function ${name} { & ${prefix} @args }`
    : `${name}() { ${prefix} "$@"; }`;
}

/**
 * The environment, and the pinned CLI, for running a custom provider in the
 * user's own terminal. Waits for the harness's pinned copy when this machine
 * has not downloaded it yet; throws its state sentence (not available here, a
 * failed download) when there is none.
 */
export async function buildHarnessLaunchEnv(
  args: { presetId: string; shell?: HarnessLaunchShell },
  resolve: (presetId: string) => HarnessPresetLaunchResult | null,
): Promise<HarnessLaunchEnvResult> {
  // PowerShell by default on Windows, where `export` lines mean nothing.
  const shell = args.shell ?? (process.platform === "win32" ? "pwsh" : "zsh");
  const result = resolve(args.presetId);
  if (!result) throw new Error("That custom provider does not exist on this account.");
  // A route this machine cannot run (no proxy yet, a stopped proxy): the state, not a fault.
  if (result.status === "unsupported") throw new AdeExpectedError(result.unsupported, "environment");
  const cli = await requirePinnedProviderCli(result.provider);
  // The model rides along: a proxied route or a Droid route spells it in a way
  // only this resolution knows, and the copied launcher starts the harness on
  // `$ADE_HARNESS_MODEL`.
  const exports = { ...result.env, ...cli.env, [HARNESS_MODEL_ENV]: cliModelFor(result) };
  const lines = Object.entries(exports).map(([key, value]) => (shell === "pwsh"
    ? `$env:${key} = ${shellQuote(value, shell)}`
    : `export ${key}=${shellQuote(value, shell)}`));
  lines.push(pinnedCliFunction(cli, shell));
  return { harness: result.provider, model: result.model.trim(), script: `${lines.join("\n")}\n` };
}
