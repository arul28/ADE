/**
 * Every model a harness could draw on outside its own sign-in.
 *
 * Sources are the machine's OpenCode sign-ins (OpenCode Go, Zen, and anything
 * signed in inside OpenCode) and its stored API keys. Model lists come from
 * what ADE already knows — a key's own declared models, OpenCode's cached
 * inventory for the same provider, then the static registry — so listing never
 * spends a request. Routes are computed in the renderer from the pure
 * `resolveHarnessRoute`, which is why each source ships its endpoints and each
 * model its probe verdict rather than a pre-decided route.
 *
 * The live check behind the Test button lives with the verdicts it records, in
 * `harnessRouteProbes.ts`.
 */

import {
  canonicalSourceProvider,
  endpointsForSource,
  harnessRouteSourceKey,
  KNOWN_SOURCE_ENDPOINTS,
  type HarnessRouteCatalog,
  type HarnessRouteModel,
  type HarnessRouteSource,
} from "../../../shared/harnessRoutes";
import { openCodeSourceLabel, type HarnessPresetBody, type HarnessPresetSource } from "../../../shared/harnessPresets";
import { providerLabel } from "../../../shared/modelCatalog";
import { decodeOpenCodeRegistryId, MODEL_REGISTRY, type ProviderFamily } from "../../../shared/modelRegistry";
import { listApiCredentials } from "../ai/apiKeyStore";
import { readOpenCodeSignedInProviderIds } from "../opencode/openCodeCredentials";
import { listPersistedOpenCodeProviderModels } from "../opencode/openCodeInventory";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { HarnessPresetLaunchResult } from "./harnessPresetLaunch";
import { readRouteProbe } from "./harnessRouteProbes";
import { routeSourceKey } from "./harnessRouteLaunch";

/** Key-store providers whose keys never route: they sign their own tool in. */
const NON_ROUTABLE_KEY_PROVIDERS = new Set(["cursor", "devin", "factory", "droid", "copilot", "github-copilot"]);

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
  source: HarnessRouteSource["source"],
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

  for (const providerId of readOpenCodeSignedInProviderIds()) {
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

  return { sources, proxyAvailable: true };
}

/**
 * Whether a key or OpenCode source can back a launch on this machine. The
 * machine inventory uses it so a Custom provider built on a stored key or an
 * OpenCode sign-in reads as usable here, not only account-sourced ones.
 */
export function isPresetSourceAvailableLocally(source: HarnessPresetSource): boolean {
  try {
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
  /** Shell lines that export the environment. Contains secrets — print, never persist. */
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

export function buildHarnessLaunchEnv(
  args: { presetId: string; shell?: HarnessLaunchShell },
  resolve: (presetId: string) => HarnessPresetLaunchResult | null,
): HarnessLaunchEnvResult {
  // PowerShell by default on Windows, where `export` lines mean nothing.
  const shell = args.shell ?? (process.platform === "win32" ? "pwsh" : "zsh");
  const result = resolve(args.presetId);
  if (!result) throw new Error("That custom provider does not exist on this account.");
  if (result.status === "unsupported") throw new Error(result.unsupported);
  // The model rides along: a proxied route or a Droid route spells it in a way
  // only this resolution knows, and the copied launcher starts the harness on
  // `$ADE_HARNESS_MODEL`.
  const exports = { ...result.env, [HARNESS_MODEL_ENV]: cliModelFor(result) };
  const lines = Object.entries(exports).map(([key, value]) => (shell === "pwsh"
    ? `$env:${key} = ${shellQuote(value, shell)}`
    : `export ${key}=${shellQuote(value, shell)}`));
  return { harness: result.provider, model: result.model.trim(), script: `${lines.join("\n")}\n` };
}
