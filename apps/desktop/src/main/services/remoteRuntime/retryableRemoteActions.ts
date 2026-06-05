export const RETRYABLE_REMOTE_ACTION_PREFIXES = [
  "diagnosticsGet",
  "get",
  "list",
  "oauthGet",
  "oauthList",
  "portGet",
  "portList",
  "proxyGet",
  "read",
  "search",
] as const;

export const RETRYABLE_REMOTE_ACTIONS = new Set([
  "chat.codexFuzzyFileSearch",
  "chat.fileSearch",
  "chat.modelCatalog",
  "file.listTreeChildren",
  "file.quickOpen",
  "file.readFileRange",
  "file.refreshGitDecorations",
  "terminal.activeForChat",
  "terminal.preview",
]);

export function isRetryableRemoteAction(domain: string, action: string): boolean {
  if (RETRYABLE_REMOTE_ACTIONS.has(`${domain}.${action}`)) {
    return true;
  }
  return RETRYABLE_REMOTE_ACTION_PREFIXES.some((prefix) =>
    action.startsWith(prefix),
  );
}

