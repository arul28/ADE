import {
  EncryptedFileCredentialStore,
  type SyncCredentialStore,
} from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { assertPluginSecretName, pluginSecretStoreKey } from "../../../shared/plugins/sdk";

/**
 * Index of the secret NAMES one plugin holds.
 *
 * `SyncCredentialStore` has no key-enumeration method — deliberately, since the
 * machine store also holds account tokens no caller should be able to sweep —
 * so the plugin namespace keeps its own index entry. `_` is outside
 * `PLUGIN_SECRET_NAME_PATTERN`, which starts with a letter, so this key can
 * never collide with a real secret name.
 */
const PLUGIN_SECRET_INDEX_NAME = "_names_v1";

export type PluginSecretStore = {
  get(pluginId: string, name: string): Promise<string | null>;
  set(pluginId: string, name: string, value: string): Promise<void>;
  delete(pluginId: string, name: string): Promise<void>;
  /** Names only, never values — this is what the settings UI is allowed to see. */
  listNames(pluginId: string): Promise<string[]>;
};

function indexKey(pluginId: string): string {
  return pluginSecretStoreKey(pluginId, PLUGIN_SECRET_INDEX_NAME);
}

function parseNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const decoded = JSON.parse(raw) as unknown;
    return Array.isArray(decoded) ? decoded.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function createPluginSecretStore(
  deps: { store?: SyncCredentialStore; secretsDir?: string } = {},
): PluginSecretStore {
  // Same construction as `projectSecretService`, but against the MACHINE store:
  // plugin installs are machine-scoped, so their secrets follow the install and
  // not whichever project happened to be open when they were set.
  const store = deps.store
    ?? new EncryptedFileCredentialStore(deps.secretsDir ? { secretsDir: deps.secretsDir } : {});

  const readNames = async (pluginId: string): Promise<string[]> => parseNames(await store.get(indexKey(pluginId)));

  const writeNames = async (pluginId: string, names: readonly string[]): Promise<void> => {
    const unique = [...new Set(names)].sort();
    if (unique.length === 0) {
      await store.delete(indexKey(pluginId));
      return;
    }
    await store.set(indexKey(pluginId), JSON.stringify(unique));
  };

  return {
    async get(pluginId, name) {
      return await store.get(pluginSecretStoreKey(pluginId, assertPluginSecretName(name)));
    },
    async set(pluginId, name, value) {
      const secretName = assertPluginSecretName(name);
      // Index first: a crash between the two writes then leaves a listed name
      // whose `get` returns null, which the UI already renders. The reverse
      // order would leave a stored secret invisible to the UI that must be able
      // to delete it.
      await writeNames(pluginId, [...(await readNames(pluginId)), secretName]);
      await store.set(pluginSecretStoreKey(pluginId, secretName), value);
    },
    async delete(pluginId, name) {
      const secretName = assertPluginSecretName(name);
      await store.delete(pluginSecretStoreKey(pluginId, secretName));
      await writeNames(pluginId, (await readNames(pluginId)).filter((entry) => entry !== secretName));
    },
    async listNames(pluginId) {
      return await readNames(pluginId);
    },
  };
}
