import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { readGitOriginUrl } from "../projects/recentProjectSummary";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AccountVaultBridge } from "./accountVaultBridge";
import type { AccountBridge } from "./accountBridge";
import {
  runAccountMigration,
  type AccountMigrationSourceResult,
} from "./accountMigration";
import type { CredentialProvenance } from "../../../shared/types/credentialProvenance";

type AccountMigrationLogger = {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
};

export type AccountMigrationContext = {
  project?: { rootPath?: string | null } | null;
  linearCredentialService?: {
    getRefreshToken(): string | null;
    getRefreshTokenProvenance(): CredentialProvenance;
    hydrateFromVault(): Promise<void>;
    purgeAccountCredentials?(): void;
  } | null;
  projectSecretService?: {
    list(): { secrets: Array<{ name: string; storage: string }> };
    getSecretProvenance(name: string): CredentialProvenance | null | undefined;
    get(args: { name: string }): { value: string };
    hydrateFromVault(): Promise<void>;
    purgeAccountCredentials?(): void;
  } | null;
};

export type AccountMigrationOwnerToken = {
  userId: string;
  generation: number;
};

export type AccountMigrationRunnerOptions = {
  accountBridge: Pick<AccountBridge, "status">;
  accountVaultBridge: Pick<AccountVaultBridge, "list" | "get" | "set">;
  getContexts: () => ReadonlyArray<AccountMigrationContext>;
  getLogger: () => AccountMigrationLogger;
  getReceiptDir?: () => string;
  /** Bumped by the account lifecycle whenever its vault ownership is purged. */
  getAccountMigrationGeneration?: () => number;
};

export function getOpenAccountContexts<T extends AccountMigrationContext>(
  contexts: ReadonlyArray<T>,
): T[] {
  const byRoot = new Map<string, T>();
  for (const context of contexts) {
    const root = context.project?.rootPath;
    if (root) byRoot.set(root, context);
  }
  return [...byRoot.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the best-effort account hydration and legacy-secret migration lifecycle. */
export function createAccountMigrationRunner(options: AccountMigrationRunnerOptions) {
  const openAccountContexts = (): AccountMigrationContext[] => {
    return getOpenAccountContexts(options.getContexts());
  };

  const listVaultItems = async (scope: string) => {
    const result = await options.accountVaultBridge.list(scope);
    return result.ok ? result.value : null;
  };

  const setVaultItem = async (
    isCurrent: () => boolean,
    scope: string,
    kind: string,
    key: string,
    value: string,
  ) => {
    if (!isCurrent()) return null;
    const saved = await options.accountVaultBridge.set(scope, kind, key, value);
    return isCurrent() ? saved : null;
  };

  const migrateProviderApiKeys = async (
    isCurrent: () => boolean,
  ): Promise<AccountMigrationSourceResult> => {
    let keys: Record<string, string>;
    try {
      const { getAllApiKeys, getApiKeyProvenance } = await import("../ai/apiKeyStore");
      keys = Object.fromEntries(
        Object.entries(getAllApiKeys()).filter(([provider]) => getApiKeyProvenance(provider).source === "device"),
      );
    } catch {
      // API keys are initialized with the first project context. Defer this
      // source when sign-in happens before any project has opened.
      return { moved: 0, skipped: 0, complete: false };
    }
    const listed = await listVaultItems("all");
    if (!listed) return { moved: 0, skipped: 0, complete: false };
    if (!isCurrent()) return { moved: 0, skipped: 0, complete: false };
    const present = new Set(
      listed
        .filter((item) => item.scope === "all" && item.kind === "provider_api_key")
        .map((item) => item.key),
    );
    let moved = 0;
    let skipped = 0;
    for (const [provider, value] of Object.entries(keys)) {
      const existing = await options.accountVaultBridge.get("all", "provider_api_key", provider);
      if (!existing.ok) return { moved, skipped, complete: false };
      if (existing.value !== null || present.has(provider)) {
        skipped += 1;
        continue;
      }
      const saved = await setVaultItem(isCurrent, "all", "provider_api_key", provider, value);
      if (!saved?.ok) return { moved, skipped, complete: false };
      moved += 1;
    }
    return { moved, skipped };
  };

  const migrateLinearRefreshToken = async (
    isCurrent: () => boolean,
  ): Promise<AccountMigrationSourceResult> => {
    const services = openAccountContexts()
      .map((context) => context.linearCredentialService)
      .filter((service): service is NonNullable<AccountMigrationContext["linearCredentialService"]> => Boolean(service));
    if (services.length === 0) return { moved: 0, skipped: 0, complete: false };
    const refreshToken = services
      .map((service) => ({
        value: service.getRefreshToken(),
        provenance: service.getRefreshTokenProvenance(),
      }))
      .find((entry) => Boolean(entry.value) && entry.provenance.source === "device")?.value ?? null;
    if (!refreshToken) return { moved: 0, skipped: 0 };

    const listed = await listVaultItems("all");
    if (!listed) return { moved: 0, skipped: 0, complete: false };
    if (!isCurrent()) return { moved: 0, skipped: 0, complete: false };
    const present = listed.some(
      (item) => item.scope === "all" && item.kind === "linear_refresh_token" && item.key === "default",
    );
    const existing = await options.accountVaultBridge.get("all", "linear_refresh_token", "default");
    if (!existing.ok) return { moved: 0, skipped: 0, complete: false };
    if (existing.value !== null || present) return { moved: 0, skipped: 1 };
    const saved = await setVaultItem(
      isCurrent,
      "all",
      "linear_refresh_token",
      "default",
      refreshToken,
    );
    return saved?.ok
      ? { moved: 1, skipped: 0 }
      : { moved: 0, skipped: 0, complete: false };
  };

  const migrateProjectSecrets = async (
    context: AccountMigrationContext,
    isCurrent: () => boolean,
  ): Promise<AccountMigrationSourceResult> => {
    const service = context.projectSecretService;
    const root = context.project?.rootPath;
    if (!root || !service) return { moved: 0, skipped: 0, complete: false };
    const scope = accountRepoScopeKey(readGitOriginUrl(root));
    if (!scope) return { moved: 0, skipped: 0, complete: false };
    let moved = 0;
    let skipped = 0;
    const listed = await listVaultItems(scope);
    if (!listed) return { moved, skipped, complete: false };
    if (!isCurrent()) return { moved, skipped, complete: false };
    const present = new Set(
      listed
        .filter((item) => item.scope === scope && item.kind === "project_secret")
        .map((item) => item.key),
    );
    for (const secret of service.list().secrets) {
      if (secret.storage !== "account") continue;
      if (service.getSecretProvenance(secret.name)?.source !== "device") continue;
      const local = service.get({ name: secret.name });
      const existing = await options.accountVaultBridge.get(scope, "project_secret", secret.name);
      if (!existing.ok) return { moved, skipped, complete: false };
      if (existing.value !== null || present.has(secret.name)) {
        skipped += 1;
        continue;
      }
      const saved = await setVaultItem(isCurrent, scope, "project_secret", secret.name, local.value);
      if (!saved?.ok) return { moved, skipped, complete: false };
      moved += 1;
    }
    return { moved, skipped };
  };

  let accountMigrationInFlight: Promise<void> | null = null;

  const start = (): void => {
    let status: ReturnType<AccountBridge["status"]>;
    try {
      status = options.accountBridge.status();
    } catch {
      return;
    }
    const userId = status.userId?.trim() || null;
    if (!status.signedIn || !userId || accountMigrationInFlight) return;
    let ownerToken: AccountMigrationOwnerToken;
    try {
      ownerToken = {
        userId,
        generation: options.getAccountMigrationGeneration?.() ?? 0,
      };
    } catch {
      return;
    }
    const isCurrent = (): boolean => {
      try {
        const current = options.accountBridge.status();
        return current.signedIn
          && (current.userId?.trim() || null) === ownerToken.userId
          && (options.getAccountMigrationGeneration?.() ?? 0) === ownerToken.generation;
      } catch {
        return false;
      }
    };
    accountMigrationInFlight = (async () => {
      try {
        const { hydrateApiKeysFromVault } = await import("../ai/apiKeyStore");
        await hydrateApiKeysFromVault();
      } catch (error) {
        options.getLogger().warn?.("account.vault_hydrate_failed", {
          source: "provider_api_keys",
          error: errorMessage(error),
        });
      }
      if (!isCurrent()) return;
      for (const context of openAccountContexts()) {
        if (!isCurrent()) return;
        try {
          await context.linearCredentialService?.hydrateFromVault();
          await context.projectSecretService?.hydrateFromVault();
        } catch (error) {
          options.getLogger().warn?.("account.vault_hydrate_failed", {
            source: "project_context",
            error: errorMessage(error),
          });
        }
        if (!isCurrent()) return;
      }
      const migrationOptions = () => ({
        receiptDir: options.getReceiptDir?.() ?? resolveMachineAdeLayout().adeDir,
        getAccountUserId: () => isCurrent() ? ownerToken.userId : null,
        isCurrent,
        logger: {
          info: (message: string, meta?: Record<string, unknown>) => options.getLogger().info?.(message, meta),
          warn: (message: string, meta?: Record<string, unknown>) => options.getLogger().warn?.(message, meta),
        },
      });
      if (!isCurrent()) return;
      await runAccountMigration({
        ...migrationOptions(),
        sources: {
          provider_api_keys: () => migrateProviderApiKeys(isCurrent),
          linear_credentials: () => migrateLinearRefreshToken(isCurrent),
        },
      });
      for (const context of openAccountContexts()) {
        if (!isCurrent()) return;
        const projectRoot = context.project?.rootPath;
        if (!projectRoot) continue;
        await runAccountMigration({
          ...migrationOptions(),
          projectRoot,
          sources: { project_secrets: () => migrateProjectSecrets(context, isCurrent) },
        });
      }
    })()
      .catch((error) => {
        options.getLogger().warn?.("account.migration_failed", {
          error: errorMessage(error),
        });
      })
      .finally(() => {
        accountMigrationInFlight = null;
      });
  };

  return { start };
}
