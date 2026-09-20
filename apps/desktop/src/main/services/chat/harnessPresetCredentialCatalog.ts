import {
  credentialStoreProviderForHarness,
} from "../../../shared/harnessCredentialProviders";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import type { HarnessPresetBody } from "../../../shared/harnessPresets";
import {
  getApiCredentialKey,
  getApiCredentialSummary,
  listApiCredentials,
} from "../ai/apiKeyStore";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  buildKeySourceLaunch,
  type HarnessPresetLaunchDeps,
  type HarnessPresetLaunchResult,
} from "./harnessPresetLaunch";

const OPEN_CODE_CUSTOM_CREDENTIAL_PREFIX = "custom:";

export function encodeOpenCodeCustomCredentialId(providerId: string, credentialId: string): string {
  return `${OPEN_CODE_CUSTOM_CREDENTIAL_PREFIX}${providerId}:${credentialId}`;
}

function decodeOpenCodeCustomCredentialId(
  value: string,
): { providerId: string; credentialId: string } | null {
  if (!value.startsWith(OPEN_CODE_CUSTOM_CREDENTIAL_PREFIX)) return null;
  const remainder = value.slice(OPEN_CODE_CUSTOM_CREDENTIAL_PREFIX.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) return null;
  const providerId = remainder.slice(0, separator);
  const credentialId = remainder.slice(separator + 1);
  if (!isSafeIdentifier(providerId) || !isSafeIdentifier(credentialId)) return null;
  return { providerId, credentialId };
}

/**
 * The same key plumbing, for a provider-card key that has no preset.
 *
 * A key saved on a provider page is launchable on its own — its `models[]` are
 * listed under that provider in the picker, and choosing one has to reach the
 * same endpoint the preset path would. Routing both through
 * {@link buildKeySourceLaunch} keeps the two launch sources from drifting.
 */
export function resolveCredentialForLaunch(
  harness: HarnessPresetBody,
  credentialId: string | null | undefined,
  deps: HarnessPresetLaunchDeps = {},
): HarnessPresetLaunchResult | null {
  const encodedId = typeof credentialId === "string" ? credentialId.trim() : "";
  if (!encodedId) return null;
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  const custom = harness === "opencode" ? decodeOpenCodeCustomCredentialId(encodedId) : null;
  if (harness === "opencode" && encodedId.startsWith(OPEN_CODE_CUSTOM_CREDENTIAL_PREFIX) && !custom) {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: "That OpenCode credential id is unsafe or malformed.",
    };
  }
  const id = custom?.credentialId ?? encodedId;
  if (!isSafeIdentifier(id)) {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: "That credential id is unsafe; use only letters, digits, dot, underscore, and dash.",
    };
  }
  const storeProvider = custom?.providerId ?? credentialStoreProviderForHarness(harness);
  if (!isSafeIdentifier(storeProvider)) {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: "That credential provider id is unsafe; use only letters, digits, dot, underscore, and dash.",
    };
  }
  const getSummary = deps.getCredentialSummary ?? getApiCredentialSummary;
  const credential = getSummary(storeProvider, id);
  if (!credential) {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: "That API key is not on this machine.",
    };
  }
  const getKey = deps.getCredentialKey ?? getApiCredentialKey;
  const key = getKey(storeProvider, id)?.trim();
  if (!key) {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: "That API key could not be read from this machine's key store.",
    };
  }
  const keySource = buildKeySourceLaunch({
    harness,
    credential,
    key,
    adeHome,
    configHomeId: id,
    configHomeKind: "credential",
    configHomeProvider: storeProvider,
    platform: deps.platform,
    aclRunner: deps.aclRunner,
    currentWindowsUser: deps.currentWindowsUser,
    writeConfig: deps.writeConfig,
  });
  if (keySource.status === "unsupported") {
    return {
      status: "unsupported",
      presetId: null,
      provider: harness,
      unsupported: keySource.unsupported,
    };
  }
  return {
    status: "ready",
    presetId: null,
    provider: harness,
    env: keySource.env,
    model: "",
    passthroughModelId: true,
    ...(keySource.codexConfigHome ? { codexConfigHome: keySource.codexConfigHome } : {}),
    ...(keySource.openCodeProvider ? { openCodeProvider: keySource.openCodeProvider } : {}),
    ...(keySource.openCodeConfigPath ? { openCodeConfigPath: keySource.openCodeConfigPath } : {}),
    ...(keySource.notes?.length ? { notes: keySource.notes } : {}),
  };
}

/** Every credential that can back a launch for one harness, for the catalog. */
export function listLaunchableCredentials(
  harness: HarnessPresetBody,
  deps: Pick<HarnessPresetLaunchDeps, "listCredentials" | "customProviderIds"> = {},
): ApiCredentialSummary[] {
  const list = deps.listCredentials ?? listApiCredentials;
  const providers = harness === "opencode"
    ? [credentialStoreProviderForHarness(harness), ...(deps.customProviderIds ?? [])]
    : [credentialStoreProviderForHarness(harness)];
  const seen = new Set<string>();
  return providers
    .filter((provider) => isSafeIdentifier(provider))
    .flatMap((provider) => list(provider))
    .filter((entry) => {
      const key = `${entry.provider}\u0000${entry.credentialId}`;
      if (seen.has(key) || (entry.models?.length ?? 0) === 0) return false;
      seen.add(key);
      return true;
    });
}

/** A registry-independent descriptor for a model declared by a stored key. */
export function createCredentialModelDescriptorBase(
  modelId: string,
  harness: HarnessPresetBody,
): Omit<ModelDescriptor, "id" | "credentialId" | "credentialLabel"> {
  return {
    shortId: modelId,
    displayName: modelId,
    family: CREDENTIAL_DESCRIPTOR_FAMILY[harness],
    authTypes: ["api-key"],
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: { reasoning: false, tools: true, vision: false, streaming: true },
    color: "#8b8b8b",
    providerRoute: harness,
    providerModelId: modelId,
    isCliWrapped: true,
  };
}

const CREDENTIAL_DESCRIPTOR_FAMILY: Record<HarnessPresetBody, ModelDescriptor["family"]> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  droid: "factory",
  pi: "pi",
  opencode: "opencode",
  qwen: "qwen",
  kimi: "moonshot",
  grok: "xai",
  copilot: "github-copilot",
};
