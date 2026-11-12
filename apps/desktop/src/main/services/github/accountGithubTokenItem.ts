/**
 * The ADE account vault items that hold a GitHub token: kind `integration`,
 * scope `all`, value `{ v: 1, token }` (or `{ v: 1, removed: true }` after
 * "Remove from my account"). One place for the keys and the value format, so
 * the writers and the readers (`githubPatAccountSync.ts`,
 * `adeCloud/cloudGitCredential.ts`) never retype them.
 */

export const ACCOUNT_GITHUB_VAULT_KIND = "integration";

/** A pasted GitHub token (PAT). Written by `githubPatAccountSync.ts`. */
export const GITHUB_PAT_VAULT_KEY = "github";

/**
 * A `gh` CLI login copied to the account. Written by `githubGhAccountSync.ts`
 * in the same `{ v: 1, token }` / `{ v: 1, removed: true }` format.
 */
export const GITHUB_CLI_VAULT_KEY = "github-cli";

/** The token in a `{ v: 1, token }` value, trimmed; null for anything else (`removed`, another format, unreadable JSON). */
export function decodeAccountGithubToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}
