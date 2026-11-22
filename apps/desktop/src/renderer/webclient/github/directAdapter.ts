import type {
  GithubDirectClientState,
  GithubDirectData,
  GithubDirectOp,
  GithubDirectRequest,
  GithubDirectRequestOptions,
  GithubDirectResult,
} from "../../../shared/types";
import { createGithubDirectClient } from "../../../shared/github/directClient";
import { createWebGithubAccountCredential, type WebGithubAccountSource } from "./accountCredential";

/**
 * `window.ade.githubDirect` on the web client: the same contract as the
 * desktop's, run in the browser. The browser calls api.github.com itself
 * with the account's GitHub App token, which lives in this module's memory
 * only (see accountCredential.ts). GitHub's REST API allows any origin with
 * a bearer token (CORS), and the page's CSP already allows `https:` in
 * `connect-src`.
 */
export function createWebGithubDirectNamespace(account: WebGithubAccountSource) {
  const { credential, clear, clearNegative } = createWebGithubAccountCredential(account);
  const client = createGithubDirectClient({ credential, browser: true });
  return {
    namespace: {
      request: <O extends GithubDirectOp>(
        request: Extract<GithubDirectRequest, { op: O }>,
        options?: GithubDirectRequestOptions,
      ): Promise<GithubDirectResult<GithubDirectData[O]>> => client.request<O>(request, options ?? {}),
      getState: async (): Promise<GithubDirectClientState> => client.state(),
    },
    /**
     * The account's GitHub sign-in changed. Disconnected or a new grant: drop
     * the token, the stored pages and the diagnoses. Connected: drop only a
     * "not connected" or "sign in again" answer.
     * The desktop needs no hook: there, one token client serves the sign-in
     * and the reads, and a finished sign-in clears it.
     */
    onGrantChanged: (change: "connected" | "disconnected"): void => {
      if (change === "connected") {
        clearNegative();
        return;
      }
      clear();
      client.clear();
    },
  };
}
