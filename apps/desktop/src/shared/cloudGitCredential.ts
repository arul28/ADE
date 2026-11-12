/**
 * Contract C4: does this ADE account have a credential git can use on a new
 * cloud computer? A cloud computer has no GitHub sign-in of its own; it
 * clones with what follows the account (`main/services/adeCloud/cloudGitCredential.ts`).
 */

/** Where the account's git-capable credential comes from. */
export type AccountGitCredentialSource =
  /** A pasted GitHub token (vault `integration/github`, `githubPatAccountSync.ts`). */
  | "pat"
  /** A `gh` CLI login copied to the account (vault `integration/github-cli`, written once PR #2186 lands). */
  | "gh";

export type AccountGitCredential =
  | { ok: true; source: AccountGitCredentialSource }
  | {
    ok: false;
    /** `none`: no git-capable sign-in follows the account. `unreadable`: ADE couldn't read the account's. */
    reason: "none" | "unreadable";
    /** Plain words, with the way out. */
    message: string;
  };

/** What a new cloud computer's clone needs, checked before the computer is made. */
export type CloudGitPreflight =
  /** It can clone: the account has a credential, or the repository is public. */
  | { ok: true; via: AccountGitCredentialSource | "public"; warning?: undefined }
  /** ADE couldn't tell (GitHub didn't answer): the launch goes on, and `warning` says what may happen. */
  | { ok: true; via: "unknown"; warning: string }
  /** A private repository and no credential that follows the account: refused before anything is made. */
  | { ok: false; reason: "none" | "unreadable"; message: string };

/** The way out a refusal names. */
export const CONNECT_GITHUB_HINT = "Connect GitHub in Settings › GitHub so your sign-in follows your ADE account, then send again.";
