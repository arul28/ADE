/**
 * Secrets kept on this computer only: saved here, never synced, and kept
 * whatever the account does (a sign-out, a reset, Passwords off). They are
 * the person's deliberate "this computer only", so nothing deletes them but
 * the person.
 *
 * Several processes share this store (the desktop brain, `ade` commands, a
 * project runtime), so nothing here is remembered between calls: each read
 * asks the store (whose own read is cached by the file's stat), and each
 * write runs under the store's cross-process lock when it has one.
 */
import crypto from "node:crypto";
import type { PasswordSecretSecret } from "../../../../desktop/src/shared/types/passwords";
import type { CredentialStore, SyncCredentialStore } from "../credentials/credentialStore";
import { ITEM_ID_BYTES } from "./passwordItems";
import type { PasswordsLogger } from "./passwordService";

export type DeviceSecret = PasswordSecretSecret & { id: string };

/** Machine-sealed like the account cache, never sent anywhere. */
const DEVICE_SECRETS_KEY = "passwords.device-secrets.v1";
/** Ids of this-computer-only secrets, so a call by id knows which store holds it. */
const DEVICE_ID_PREFIX = "dev_";

export function isDeviceId(id: string): boolean {
  return id.startsWith(DEVICE_ID_PREFIX);
}

export function newDeviceSecretId(): string {
  return `${DEVICE_ID_PREFIX}${crypto.randomBytes(ITEM_ID_BYTES).toString("base64url")}`;
}

export type DeviceSecretStore = {
  read(): Promise<DeviceSecret[]>;
  /** Without waiting; empty when the store has no synchronous read. */
  readSync(): DeviceSecret[];
  /** Read, change and write as one step. `change` returns the new list, or undefined to write nothing. */
  update(change: (items: DeviceSecret[]) => DeviceSecret[] | undefined): Promise<void>;
};

export function createDeviceSecretStore(store: CredentialStore, logger: PasswordsLogger): DeviceSecretStore {
  const syncStore = store as Partial<SyncCredentialStore>;

  const parse = (raw: string | null): DeviceSecret[] => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw ?? "null");
    } catch {
      logger.warn("passwords.device_secrets_unreadable", {});
    }
    const items = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];
    return items.filter((item): item is DeviceSecret => {
      const candidate = item as Partial<DeviceSecret> | null;
      return Boolean(candidate && typeof candidate.id === "string" && isDeviceId(candidate.id)
        && typeof candidate.name === "string" && typeof candidate.value === "string");
    }).map((item) => ({
      ...item,
      kind: "secret",
      projectScope: typeof item.projectScope === "string" ? item.projectScope : null,
      notes: typeof item.notes === "string" ? item.notes : "",
    }));
  };
  const serialize = (items: DeviceSecret[]): string => JSON.stringify({ v: 1, items });

  // One write at a time in this process; the store's lock covers other processes.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async read() {
      return parse(await store.get(DEVICE_SECRETS_KEY));
    },

    readSync() {
      if (typeof syncStore.getSync !== "function") return [];
      try {
        return parse(syncStore.getSync(DEVICE_SECRETS_KEY));
      } catch (error) {
        logger.warn("passwords.device_secrets_unreadable", { error: error instanceof Error ? error.name : "unknown" });
        return [];
      }
    },

    update(change) {
      const run = async (): Promise<void> => {
        if (typeof syncStore.updateKeySync === "function") {
          let failure: unknown = null;
          syncStore.updateKeySync(DEVICE_SECRETS_KEY, (current) => {
            try {
              const next = change(parse(current));
              return next === undefined ? undefined : serialize(next);
            } catch (error) {
              failure = error;
              return undefined;
            }
          });
          if (failure) throw failure;
          return;
        }
        const next = change(parse(await store.get(DEVICE_SECRETS_KEY)));
        if (next !== undefined) await store.set(DEVICE_SECRETS_KEY, serialize(next));
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
