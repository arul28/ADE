/**
 * A project's Jira site connection.
 *
 * Each ADE project has its own (`<project>/.ade/secrets`), and it follows the
 * project to every machine on the owner's ADE account: one vault item per
 * project, scope `repo:<host>/<owner>/<repo>`, kind `integration`, key `jira`.
 * A project with no remote has no scope another machine would recognise, so
 * its connection stays here and the status says so.
 *
 * Jira used to be one connection per machine (`~/.ade/secrets`). A project
 * with no connection of its own adopts that one on first read, so nobody is
 * signed out by the move. The machine copy is left where it is: there is no
 * way to know when every project this machine will ever open has adopted it,
 * and an older ADE still reads it there.
 */

import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { JiraConnectArgs } from "../../../shared/types/jira";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import { readAccountVaultItem, safeVault } from "../account/accountVaultRead";
import { describeVaultFailure, fireAndForgetVaultWrite } from "../account/vaultWrite";
import {
  describeIntegrationCredentialStorage,
  projectCredentialAccountScope,
  type IntegrationCredentialStorage,
} from "../account/integrationCredentialStorage";

export const JIRA_SITE_URL_KEY = "jira.siteUrl";
export const JIRA_EMAIL_KEY = "jira.email";
export const JIRA_API_TOKEN_KEY = "jira.apiToken";
/** Where the project's connection came from: "device", "account" (the vault) or "legacy" (the machine copy). */
const JIRA_SOURCE_KEY = "jira.credentialSource.v1";
/** Set once a project has looked at the machine copy, so a disconnect is not undone by re-adopting it. */
const JIRA_LEGACY_ADOPTED_KEY = "jira.legacyAdopted.v1"; // gitleaks:allow — a store key name, not a secret
export const JIRA_ACCOUNT_VAULT_KIND = "integration";
export const JIRA_ACCOUNT_VAULT_KEY = "jira";

type JiraCredentialSource = "device" | "account" | "legacy";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

export type JiraCredentialService = ReturnType<typeof createJiraCredentialService>;

function encodeJiraCredential(credentials: JiraConnectArgs): string {
  return JSON.stringify({ v: 1, siteUrl: credentials.siteUrl, email: credentials.email, apiToken: credentials.apiToken });
}

function decodeJiraCredential(raw: string | null | undefined): JiraConnectArgs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    const siteUrl = typeof parsed.siteUrl === "string" ? parsed.siteUrl.trim() : "";
    const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
    const apiToken = typeof parsed.apiToken === "string" ? parsed.apiToken : "";
    return siteUrl && email && apiToken ? { siteUrl, email, apiToken } : null;
  } catch {
    return null;
  }
}

function sameJiraCredential(left: JiraConnectArgs, right: JiraConnectArgs): boolean {
  return left.siteUrl === right.siteUrl && left.email === right.email && left.apiToken === right.apiToken;
}

function readFrom(store: SyncCredentialStore): JiraConnectArgs | null {
  const siteUrl = store.getSync(JIRA_SITE_URL_KEY)?.trim();
  const email = store.getSync(JIRA_EMAIL_KEY)?.trim();
  const apiToken = store.getSync(JIRA_API_TOKEN_KEY);
  return siteUrl && email && apiToken ? { siteUrl, email, apiToken } : null;
}

export function createJiraCredentialService(args: {
  /** This project's store (`<project>/.ade/secrets`). */
  credentialStore: SyncCredentialStore;
  /** The machine store that held the one Jira connection before it was per project. */
  legacyCredentialStore?: SyncCredentialStore | null;
  /** The project, for its account scope. Without it the connection never leaves this machine. */
  projectRoot?: string | null;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  logger?: Logger;
}) {
  const store = args.credentialStore;
  const accountUserId = (): string | null => args.getAccountUserId?.()?.trim() || null;
  const scope = (): string | null => (args.projectRoot ? projectCredentialAccountScope(args.projectRoot) : null);
  const logFailure = (operation: string, detail: unknown): void => {
    args.logger?.warn?.("jira.account_vault_sync_failed", { operation, error: describeVaultFailure(detail) });
  };
  const resolveVault = (): AccountVaultBridge | null =>
    safeVault(args.getAccountVault, (error) => logFailure("resolve_vault", error));

  const readSource = (): JiraCredentialSource => {
    const raw = store.getSync(JIRA_SOURCE_KEY);
    return raw === "account" || raw === "legacy" ? raw : "device";
  };

  const writeLocal = (credentials: JiraConnectArgs | null, source: JiraCredentialSource): void => {
    const apply = (values: Record<string, string>): void => {
      if (credentials) {
        values[JIRA_SITE_URL_KEY] = credentials.siteUrl;
        values[JIRA_EMAIL_KEY] = credentials.email;
        values[JIRA_API_TOKEN_KEY] = credentials.apiToken;
        values[JIRA_SOURCE_KEY] = source;
      } else {
        delete values[JIRA_SITE_URL_KEY];
        delete values[JIRA_EMAIL_KEY];
        delete values[JIRA_API_TOKEN_KEY];
        delete values[JIRA_SOURCE_KEY];
      }
      values[JIRA_LEGACY_ADOPTED_KEY] = "1";
    };
    if (store.updateSync) {
      store.updateSync(apply);
      return;
    }
    const values: Record<string, string> = {};
    apply(values);
    if (credentials) {
      for (const key of [JIRA_SITE_URL_KEY, JIRA_EMAIL_KEY, JIRA_API_TOKEN_KEY, JIRA_SOURCE_KEY]) store.setSync(key, values[key]!);
    } else {
      for (const key of [JIRA_SITE_URL_KEY, JIRA_EMAIL_KEY, JIRA_API_TOKEN_KEY, JIRA_SOURCE_KEY]) store.deleteSync(key);
    }
    store.setSync(JIRA_LEGACY_ADOPTED_KEY, "1");
  };

  /** The project's connection, adopting the machine's old one the first time a project has none. */
  const readLocal = (): JiraConnectArgs | null => {
    const own = readFrom(store);
    if (own) return own;
    const legacyStore = args.legacyCredentialStore;
    if (!legacyStore || store.getSync(JIRA_LEGACY_ADOPTED_KEY)) return null;
    let legacy: JiraConnectArgs | null = null;
    try {
      legacy = readFrom(legacyStore);
    } catch (error) {
      args.logger?.warn?.("jira.legacy_machine_credential_read_failed", { error: describeVaultFailure(error) });
      return null;
    }
    try {
      writeLocal(legacy, "legacy");
      if (legacy) args.logger?.info?.("jira.legacy_machine_credential_adopted", {});
    } catch (error) {
      args.logger?.warn?.("jira.legacy_machine_credential_adopt_failed", { error: describeVaultFailure(error) });
    }
    return legacy;
  };

  const vaultOptions = { getAccountVault: args.getAccountVault, logger: args.logger, logEvent: "jira.account_vault_sync_failed" };

  const publish = (credentials: JiraConnectArgs | null): void => {
    const accountScope = scope();
    if (!accountScope || !accountUserId()) return;
    if (!credentials) {
      fireAndForgetVaultWrite(vaultOptions, "remove", (vault) => vault.remove(accountScope, JIRA_ACCOUNT_VAULT_KIND, JIRA_ACCOUNT_VAULT_KEY));
      return;
    }
    fireAndForgetVaultWrite(vaultOptions, "set", (vault) => vault.set(
      accountScope,
      JIRA_ACCOUNT_VAULT_KIND,
      JIRA_ACCOUNT_VAULT_KEY,
      encodeJiraCredential(credentials),
    ));
  };

  /**
   * Reconcile with the vault, at account sign-in and on vault sync ticks.
   * The vault's copy replaces one this project got from the account or from
   * the machine's old connection; a connection made in this project on this
   * machine is never overwritten (a collision is logged, without values).
   */
  const hydrateFromVault = async (): Promise<void> => {
    const userId = accountUserId();
    const accountScope = scope();
    const vault = resolveVault();
    if (!userId || !accountScope || !vault) return;
    const read = await readAccountVaultItem(
      vault,
      { scope: accountScope, kind: JIRA_ACCOUNT_VAULT_KIND, key: JIRA_ACCOUNT_VAULT_KEY },
      decodeJiraCredential,
      logFailure,
    );
    if (!read) return;
    if (accountUserId() !== userId) return;
    const { item, raw: remoteRaw, value: remote } = read;

    try {
      const local = readLocal();
      const source = local ? readSource() : "device";
      if (item?.deleted === true) {
        if (local && source === "account") {
          writeLocal(null, "device");
          args.logger?.info?.("jira.account_vault_removed_elsewhere", {});
        }
        return;
      }
      if (!remote) {
        // An item ADE cannot read may be a newer format; never write over it.
        if (item && remoteRaw !== null) return;
        if (local && source !== "account") publish(local);
        return;
      }
      if (!local) {
        writeLocal(remote, "account");
        args.logger?.info?.("jira.account_vault_adopted", {});
        return;
      }
      if (sameJiraCredential(local, remote)) {
        if (source === "legacy") writeLocal(local, "account");
        return;
      }
      if (source === "account" || source === "legacy") {
        writeLocal(remote, "account");
        args.logger?.info?.("jira.account_vault_adopted", {});
        return;
      }
      args.logger?.warn?.("jira.account_vault_collision", {});
    } catch (error) {
      logFailure("hydrate", error);
    }
  };

  return {
    getCredentials(): JiraConnectArgs | null {
      return readLocal();
    },
    setCredentials(credentials: JiraConnectArgs): void {
      writeLocal(credentials, "device");
      publish(credentials);
    },
    clearCredentials(): void {
      writeLocal(null, "device");
      publish(null);
    },
    hydrateFromVault,
    /** Drop a connection that came from the account, at sign-out; keep this machine's own. */
    purgeAccountCredentials(): void {
      if (readFrom(store) && readSource() === "account") writeLocal(null, "device");
    },
    storage(): IntegrationCredentialStorage {
      return describeIntegrationCredentialStorage({
        scope: scope(),
        perProject: true,
        signedIn: Boolean(accountUserId()),
        hasVault: Boolean(resolveVault()),
      });
    },
  };
}
