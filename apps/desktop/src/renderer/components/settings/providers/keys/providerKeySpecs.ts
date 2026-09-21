/**
 * What each provider can actually do with an API key.
 *
 * The add-key sheet used to be one form with every field on it, which is how a
 * user ended up typing an endpoint for a provider that ignores endpoints and an
 * npm package name for a provider that has no plugin. A field that does nothing
 * is worse than a missing one: it reads as a promise. So each provider declares
 * exactly the fields its harness reads, and the sheet renders that and nothing
 * else.
 *
 * `credentialProvider` is the id the key is FILED under in the store, which is
 * not always the id of the page it is entered on. Claude Code reads an
 * Anthropic key, Codex reads an OpenAI key, Kimi reads a Moonshot key — filing
 * them under the vendor name is what makes an already-set `ANTHROPIC_API_KEY`
 * show up as an Environment row, and what makes Verify reach a probe that
 * exists.
 */
import type { SettingsProviderId } from "../types";
import type { ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import { HARNESS_CREDENTIAL_STORE_PROVIDER } from "../../../../../shared/harnessCredentialProviders";

export type ProviderKeyProtocol = NonNullable<ApiCredentialSummary["protocol"]>;

export const PROTOCOL_OPTIONS: ReadonlyArray<{ value: ProviderKeyProtocol; label: string }> = [
  { value: "openai-compatible", label: "OpenAI-compatible (chat)" },
  { value: "openai-responses", label: "OpenAI (responses)" },
  { value: "anthropic", label: "Anthropic" },
];

export type ProviderKeyEndpointSpec = {
  /** The variable the endpoint is exported as, when the harness reads one. */
  envVar: string | null;
  placeholder: string;
  help: string;
};

export type ProviderKeySpec = {
  provider: SettingsProviderId;
  /** The store id every key on this page is filed under. */
  credentialProvider: string;
  /** The variable a direct vendor key is exported as. Null when there is none. */
  keyEnvVar: string | null;
  /**
   * The variable a key with a custom endpoint is exported as instead.
   *
   * Claude Code is the only provider that distinguishes the two: a key for
   * Anthropic itself is `ANTHROPIC_API_KEY`, and a key for a gateway in front
   * of it is `ANTHROPIC_AUTH_TOKEN` alongside `ANTHROPIC_BASE_URL`.
   */
  gatewayKeyEnvVar?: string;
  keyHelp: string;
  endpoint: ProviderKeyEndpointSpec | null;
  /** Only where the harness can speak more than one wire protocol. */
  protocol: boolean;
  /** Only where a key can serve a declared subset of model ids. */
  models: boolean;
  /** OpenCode names every custom provider, so its sheet asks for an id. */
  providerId: boolean;
  /** True where `authDetector.buildApiVerificationRequest` has a probe. */
  verifiable: boolean;
  /**
   * Route the write through the legacy single-slot `ai.storeApiKey` instead.
   * Cursor's SDK auth reads that slot, and a key written anywhere else leaves
   * Cursor signed out while the panel says a key is saved.
   */
  legacyDefaultSlot: boolean;
  /** One line under the fields, for a provider whose key works unusually. */
  note: string | null;
};

const SPECS: Record<SettingsProviderId, ProviderKeySpec> = {
  claude: {
    provider: "claude",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.claude,
    keyEnvVar: "ANTHROPIC_API_KEY",
    gatewayKeyEnvVar: "ANTHROPIC_AUTH_TOKEN",
    keyHelp: "Claude Code runs API-key chats with this key instead of your subscription.",
    endpoint: {
      envVar: "ANTHROPIC_BASE_URL",
      placeholder: "https://openrouter.ai/api",
      help: "Leave empty to use Anthropic directly. No /v1 at the end.",
    },
    protocol: false,
    models: true,
    providerId: false,
    verifiable: true,
    legacyDefaultSlot: false,
    note: null,
  },
  codex: {
    provider: "codex",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.codex,
    keyEnvVar: "OPENAI_API_KEY",
    keyHelp: "Codex runs API-key chats with this key instead of your ChatGPT sign-in.",
    endpoint: {
      envVar: "OPENAI_BASE_URL",
      placeholder: "https://api.openai.com/v1",
      help: "Leave empty to use OpenAI directly.",
    },
    protocol: false,
    models: true,
    providerId: false,
    verifiable: true,
    legacyDefaultSlot: false,
    note: null,
  },
  cursor: {
    provider: "cursor",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.cursor,
    keyEnvVar: "CURSOR_API_KEY",
    keyHelp: "A key from the Cursor dashboard API page. Cursor's SDK signs in with it.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: true,
    legacyDefaultSlot: true,
    note: "Cursor holds one key at a time. Saving replaces the key its SDK signs in with.",
  },
  droid: {
    provider: "droid",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.droid,
    keyEnvVar: "FACTORY_API_KEY",
    keyHelp: "Factory's Droid CLI signs in with this key when it has no local session.",
    endpoint: {
      envVar: null,
      placeholder: "https://api.example.com/v1",
      help: "Leave empty to use Factory directly.",
    },
    protocol: true,
    models: true,
    providerId: false,
    verifiable: false,
    legacyDefaultSlot: false,
    note: null,
  },
  pi: {
    provider: "pi",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.pi,
    keyEnvVar: null,
    keyHelp: "Stored for Pi's own providers.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: false,
    legacyDefaultSlot: false,
    note: "Pi reads its own models.json for endpoints and model ids, so there is no endpoint to set here.",
  },
  opencode: {
    provider: "opencode",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.opencode,
    keyEnvVar: null,
    keyHelp: "OpenCode uses this key for the provider id above.",
    endpoint: {
      envVar: null,
      placeholder: "https://api.example.com/v1",
      help: "The provider's base URL. OpenCode calls this endpoint with the key.",
    },
    protocol: true,
    models: true,
    providerId: true,
    verifiable: false,
    legacyDefaultSlot: false,
    note: null,
  },
  qwen: {
    provider: "qwen",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.qwen,
    keyEnvVar: "OPENAI_API_KEY",
    keyHelp: "Qwen Code signs in with this key when its own auth is not configured.",
    endpoint: {
      envVar: "OPENAI_BASE_URL",
      placeholder: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      help: "Leave empty to use Qwen's default OpenAI-compatible endpoint.",
    },
    protocol: false,
    models: false,
    providerId: false,
    verifiable: false,
    legacyDefaultSlot: false,
    note: null,
  },
  kimi: {
    provider: "kimi",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.kimi,
    keyEnvVar: "MOONSHOT_API_KEY",
    keyHelp: "A Moonshot platform key. Kimi CLI signs in with it.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: true,
    legacyDefaultSlot: false,
    note: null,
  },
  grok: {
    provider: "grok",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.grok,
    keyEnvVar: "XAI_API_KEY",
    keyHelp: "An xAI console key. Grok CLI signs in with it.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: true,
    legacyDefaultSlot: false,
    note: null,
  },
  copilot: {
    provider: "copilot",
    credentialProvider: HARNESS_CREDENTIAL_STORE_PROVIDER.copilot,
    keyEnvVar: "GITHUB_TOKEN",
    keyHelp: "A GitHub token with Copilot access. The Copilot CLI signs in with it.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: false,
    legacyDefaultSlot: false,
    note: null,
  },
  devin: {
    provider: "devin",
    credentialProvider: "devin",
    keyEnvVar: "WINDSURF_API_KEY",
    keyHelp: "A Windsurf API key. The Devin CLI signs in with it when `devin auth login` has not run.",
    endpoint: null,
    protocol: false,
    models: false,
    providerId: false,
    verifiable: false,
    legacyDefaultSlot: false,
    note: "Devin's browser sign-in (`devin auth login`) covers every account and needs no key. Only headless setups need WINDSURF_API_KEY.",
  },
};

export function providerKeySpec(provider: SettingsProviderId): ProviderKeySpec {
  return SPECS[provider];
}

/** Every spec, in page order. Exported for the docs table and its test. */
export function allProviderKeySpecs(): ProviderKeySpec[] {
  return Object.values(SPECS);
}

/**
 * The variable this key is exported as.
 *
 * An endpoint turns a direct vendor key into a gateway key for the one provider
 * that names them differently, so this is derived rather than typed: nobody
 * should have to know that `ANTHROPIC_AUTH_TOKEN` is the gateway spelling.
 */
export function resolveKeyEnvVar(spec: ProviderKeySpec, baseUrl: string | null | undefined): string | null {
  const hasEndpoint = Boolean(baseUrl && baseUrl.trim().length > 0);
  if (hasEndpoint && spec.gatewayKeyEnvVar) return spec.gatewayKeyEnvVar;
  return spec.keyEnvVar;
}

/** `https://openrouter.ai/api` → `openrouter.ai`. The row shows the host only. */
export function endpointHost(baseUrl: string | null | undefined): string | null {
  const value = (baseUrl ?? "").trim();
  if (!value) return null;
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/**
 * Store ids whose keys belong on this provider's page but are not its own.
 *
 * OpenCode is the only one: each custom provider block files its key under its
 * own provider id, and those keys are not visible anywhere else.
 */
export function extraKeyProviders(
  provider: SettingsProviderId,
  customProviders: ReadonlyArray<{ id: string }> | undefined,
): string[] {
  if (provider !== "opencode") return [];
  return (customProviders ?? []).map((entry) => entry.id).filter(Boolean);
}
