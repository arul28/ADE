import type { GitHubCredentialSource } from "../../../shared/types/git";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { GITHUB_CONNECT_MODE_SETTING_KEY } from "../../../shared/githubConnectMode";
import { accountSettingsCacheValue, readAccountSettingsCacheRows } from "../account/accountSettingsCacheFile";

/** For callers outside the brain's project runtime, which owns the in-memory store. */
export function githubCliOnlyFromCache(adeDir: string, getAccountUserId?: () => string | null): () => boolean {
  let cachedOwner: string | null = null;
  let expiresAt = 0;
  let cliOnly = false;
  return () => {
    const owner = getAccountUserId?.() ?? null;
    if (!owner) return false;
    const now = Date.now();
    if (owner === cachedOwner && now < expiresAt) return cliOnly;
    const rows = readAccountSettingsCacheRows(adeDir, owner);
    cliOnly = rows !== null && accountSettingsCacheValue(rows, ACCOUNT_SCOPE_ALL, GITHUB_CONNECT_MODE_SETTING_KEY) === "cli_only";
    cachedOwner = owner;
    expiresAt = now + 1_000;
    return cliOnly;
  };
}

export const GITHUB_CLI_SIGN_IN_REQUIRED = "Sign in with the GitHub CLI on this computer. Run `gh auth login -h github.com -s repo -s workflow`.";

/** Only existing gh logins participate in credential selection in CLI-only mode. */
export function githubCliCredentialInventory(
  gh: { token: string | null; ghCliPath: string | null; ghAuthError: string | null },
  accountGhToken: string | null,
) {
  const capabilities = ["read", "write", "issue-write"] as const;
  const candidates = [
    ...(gh.token ? [{ ...gh, token: gh.token, source: "gh" as const, patTokenStored: false, capabilities }] : []),
    ...(accountGhToken ? [{
      token: accountGhToken,
      source: "account_gh" as const,
      ghCliPath: null,
      ghAuthError: null,
      patTokenStored: false,
      capabilities,
    }] : []),
  ];
  return {
    candidates,
    availableSources: new Set<GitHubCredentialSource>(candidates.map((candidate) => candidate.source)),
    failures: [],
    appTokenStored: false,
    patTokenStored: false,
    ghCliPath: gh.ghCliPath,
    ghAuthError: gh.ghAuthError,
    credentialStoreUnreadable: false,
  };
}

/** Ask gh for its own login even if the process inherited a separate token. */
export function githubCliLoginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}
