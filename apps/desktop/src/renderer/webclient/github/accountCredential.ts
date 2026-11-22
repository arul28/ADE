import { GITHUB_APP_PATHS } from "../../../../../account-directory/src/githubApp/contract";
import { createAccountAppTokenClient } from "../../../shared/github/accountAppTokenClient";
import { accountAppDirectCredential, type GithubDirectCredential } from "../../../shared/github/directClient";

/**
 * The web client's GitHub credential: the ADE account's GitHub App token, in
 * memory only (spec C10). A reload asks the account directory again (one
 * request). Nothing goes to localStorage, IndexedDB or a cookie.
 *
 * The same token client the machines use, with no store: one in-flight
 * request per tab, the 60 s rejected-token guard, timed negative answers.
 * Its `fetch` is fenced to one call, `POST {directory}/github/app/token`,
 * sent with this browser's own account token, no cookies and no referrer.
 * The directory allows that route from the web client's exact origin (CORS)
 * and never from another.
 */
export type WebGithubAccountSource = {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  getDirectoryBaseUrl: () => string | null;
  captureSessionLease: () => { userId: string } | null;
};

export function createWebGithubAccountCredential(
  account: WebGithubAccountSource,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): { credential: GithubDirectCredential; clear: () => void; clearNegative: () => void } {
  const directoryBase = (): string | null => account.getDirectoryBaseUrl()?.replace(/\/+$/, "") || null;

  const fencedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const base = directoryBase();
    const method = (init?.method ?? "GET").toUpperCase();
    if (!base || url !== `${base}${GITHUB_APP_PATHS.token}` || method !== "POST") {
      throw new Error("The web client asks the account directory only for the GitHub token.");
    }
    return await fetchImpl(url, {
      ...init,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  };

  const getUserId = (): string | null => account.captureSessionLease()?.userId ?? null;

  const tokenClient = createAccountAppTokenClient({
    fetchImpl: fencedFetch,
    getAccountAccessToken: async (options) => {
      try {
        return await account.getAccessToken(options);
      } catch {
        return null;
      }
    },
    getAccountUserId: getUserId,
    getDirectoryBaseUrl: directoryBase,
    store: null,
    holderId: "web",
    clientKind: "web",
  });

  return {
    credential: accountAppDirectCredential(tokenClient, getUserId),
    clear: () => tokenClient.clearCache(),
    clearNegative: () => tokenClient.clearNegative(),
  };
}
