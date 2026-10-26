import { randomUUID } from "node:crypto";
import type { AdeRuntime } from "../../bootstrap";
import { ACCOUNT_SCOPE_ALL } from "../../../../desktop/src/shared/accountSettingsScope";
import {
  HARNESS_PRESETS_SETTING_KEY,
  HARNESS_PRESETS_SYNC_MAX_CHARS,
  normalizeHarnessPreset,
  normalizeHarnessPresetList,
  validateHarnessPreset,
  type HarnessPreset,
} from "../../../../desktop/src/shared/harnessPresets";
import { asObject, requiredString } from "./rpcArgs";

/**
 * The settings an SDK host manages for its end user, behind the
 * `providerAccounts.call`, `credentials.call` and `presets.call` machine RPC
 * methods: provider accounts and their sign-ins, stored API keys, and harness
 * presets. Each reuses the store ADE's own Settings uses; a key value never
 * leaves this process.
 *
 * Who may call is decided by the RPC server (`callerIsEmbeddedHost`), not here.
 */
export class EmbeddedHostSettings {
  private providerInstancesServicePromise: Promise<Record<string, (args?: unknown) => unknown>> | null = null;

  constructor(private readonly getRuntime: () => Promise<AdeRuntime>) {}

  async providerAccounts(actionValue: unknown, argsValue: unknown): Promise<unknown> {
    const action = requiredString(actionValue, "action");
    const allowed = ["list", "create", "remove", "signOut", "rename", "setDefault", "refresh", "loginStart", "loginStatus", "loginSubmitCode", "loginCancel"];
    if (!allowed.includes(action)) throw new Error(`Unsupported provider account action: ${action}.`);
    const runtime = await this.getRuntime();
    if (!this.providerInstancesServicePromise) {
      this.providerInstancesServicePromise = import("../../../../desktop/src/main/services/adeActions/registry")
        .then(({ buildProviderInstancesDomainService }) =>
          buildProviderInstancesDomainService(runtime) as Record<string, (args?: unknown) => unknown>);
    }
    let service: Record<string, (args?: unknown) => unknown>;
    try {
      service = await this.providerInstancesServicePromise;
    } catch (error) {
      this.providerInstancesServicePromise = null;
      throw error;
    }
    const handler = service[action];
    if (typeof handler !== "function") throw new Error(`Provider account action '${action}' is unavailable.`);
    return await handler(asObject(argsValue));
  }

  async credentials(actionValue: unknown, argsValue: unknown): Promise<unknown> {
    const action = requiredString(actionValue, "action");
    if (!["list", "store", "remove", "verify"].includes(action)) {
      throw new Error(`Unsupported credential action: ${action}.`);
    }
    const args = asObject(argsValue);
    const runtime = await this.getRuntime();
    const credentialStore = await import("../../../../desktop/src/main/services/ai/apiKeyStore");
    if (action === "list") {
      const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : undefined;
      return { credentials: credentialStore.listApiCredentials(provider) };
    }
    if (action === "remove") {
      // Never a default id: a call that names no key must not delete one.
      const credentialId = requiredString(args.credentialId, "credentialId");
      const named = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : null;
      // The SDK lets a host remove a key by id alone. Ids are unique per
      // provider, not overall, so an id two providers share needs the provider.
      const matches = named
        ? [named]
        : credentialStore.listApiCredentials()
          .filter((summary) => summary.credentialId === credentialId && summary.source === "store")
          .map((summary) => summary.provider);
      if (matches.length > 1) {
        throw new Error(`Credential '${credentialId}' exists for ${matches.join(", ")}; pass the provider to remove one.`);
      }
      const provider = matches[0];
      if (!provider) return { credentialId, removed: false };
      const existing = credentialStore.getApiCredentialSummary(provider, credentialId);
      credentialStore.removeApiCredential(provider, credentialId);
      return {
        credentialId,
        provider,
        removed: existing?.source === "store" && credentialStore.getApiCredentialSummary(provider, credentialId) === null,
      };
    }
    const provider = requiredString(args.provider, "provider");
    if (action === "store") {
      if (typeof args.key !== "string" || !args.key.trim()) throw new Error("key is required.");
      const credentialId = credentialStore.storeApiCredential({
        provider,
        key: args.key,
        label: requiredString(args.label, "label"),
        ...(typeof args.credentialId === "string" ? { credentialId: args.credentialId } : {}),
        ...(typeof args.envVar === "string" ? { envVar: args.envVar } : {}),
        ...(typeof args.baseUrl === "string" ? { baseUrl: args.baseUrl } : {}),
        ...(args.protocol === "openai-compatible" || args.protocol === "openai-responses" || args.protocol === "anthropic"
          ? { protocol: args.protocol }
          : {}),
        ...(Array.isArray(args.models) && args.models.every((entry) => typeof entry === "string")
          ? { models: args.models as string[] }
          : {}),
        ...(typeof args.deviceOnly === "boolean" ? { deviceOnly: args.deviceOnly } : {}),
      });
      const credential = credentialStore.getApiCredentialSummary(provider, credentialId);
      if (!credential) throw new Error("The credential was stored but its summary could not be read.");
      return { credential };
    }
    if (!runtime.aiIntegrationService) throw new Error("API key verification is unavailable.");
    return await runtime.aiIntegrationService.verifyApiKeyConnection(provider);
  }

  async presets(actionValue: unknown, argsValue: unknown): Promise<unknown> {
    const action = requiredString(actionValue, "action");
    if (!["list", "create", "update", "remove"].includes(action)) {
      throw new Error(`Unsupported harness preset action: ${action}.`);
    }
    const args = asObject(argsValue);
    const runtime = await this.getRuntime();
    const settings = runtime.accountSettingsStore;
    if (!settings) throw new Error("Harness preset storage is unavailable in this runtime.");
    const readPresets = (): HarnessPreset[] => {
      const stored = settings.get(ACCOUNT_SCOPE_ALL, HARNESS_PRESETS_SETTING_KEY);
      if (stored === undefined) return [];
      if (!Array.isArray(stored)) throw new Error("Harness presets could not be loaded; the stored value is unreadable.");
      const presets = normalizeHarnessPresetList(stored);
      if (presets.length !== stored.length) {
        throw new Error("Harness presets could not be loaded; update ADE to read every saved preset.");
      }
      return presets;
    };
    const writePresets = (presets: HarnessPreset[]): void => {
      if (JSON.stringify(presets).length > HARNESS_PRESETS_SYNC_MAX_CHARS) {
        throw new Error("Harness presets exceed the account storage limit.");
      }
      if (!settings.set(ACCOUNT_SCOPE_ALL, HARNESS_PRESETS_SETTING_KEY, presets)) {
        throw new Error("Harness presets could not be saved.");
      }
    };
    const presets = readPresets();
    if (action === "list") return { presets };
    if (action === "remove") {
      const id = requiredString(args.id ?? args.presetId, "id");
      const next = presets.filter((preset) => preset.id !== id);
      const removed = next.length !== presets.length;
      if (removed) writePresets(next);
      return { removed };
    }
    const now = new Date().toISOString();
    if (action === "create") {
      const draft = asObject(args.preset ?? args);
      const errors = validateHarnessPreset(draft);
      if (Object.keys(errors).length) throw new Error(`Invalid harness preset: ${JSON.stringify(errors)}`);
      const preset = normalizeHarnessPreset({ ...draft, id: randomUUID(), createdAt: now, updatedAt: now });
      if (!preset) throw new Error("Invalid harness preset.");
      writePresets([...presets, preset]);
      return { preset };
    }
    const update = asObject(args.preset ?? args);
    const id = requiredString(update.id ?? args.id ?? args.presetId, "id");
    const index = presets.findIndex((preset) => preset.id === id);
    if (index < 0) throw new Error(`Harness preset '${id}' was not found.`);
    const current = presets[index]!;
    const draft = { ...current, ...update, id, createdAt: current.createdAt, updatedAt: now };
    const errors = validateHarnessPreset(draft);
    if (Object.keys(errors).length) throw new Error(`Invalid harness preset: ${JSON.stringify(errors)}`);
    const preset = normalizeHarnessPreset(draft);
    if (!preset) throw new Error("Invalid harness preset.");
    const next = [...presets];
    next[index] = preset;
    writePresets(next);
    return { preset };
  }
}
