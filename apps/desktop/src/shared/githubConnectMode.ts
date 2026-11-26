/** The account setting that selects the GitHub credentials ADE may use. */
export const GITHUB_CONNECT_MODE_SETTING_KEY = "github.connectMode";

export type GithubConnectMode = "app_or_token" | "cli_only";

export function githubConnectMode(value: unknown): GithubConnectMode {
  return value === "cli_only" ? "cli_only" : "app_or_token";
}
