export type GithubStackApiErrorKind = "forbidden" | "missing" | "other";

export function githubHttpStatusFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const http = message.match(/HTTP (\d{3})/i);
  if (http) return Number(http[1]);
  const trimmed = message.trim();
  if (/^not found$/i.test(trimmed)) return 404;
  if (/^method not allowed$/i.test(trimmed)) return 405;
  if (/^forbidden$/i.test(trimmed) || /resource not accessible/i.test(message)) return 403;
  return null;
}

export function githubStackApiErrorKind(error: unknown): GithubStackApiErrorKind {
  const status = githubHttpStatusFromError(error);
  if (status === 403) return "forbidden";
  if (status === 404 || status === 405) return "missing";
  return "other";
}

export function githubStackApiUnavailableReason(error: unknown, action: "merge" | "rebase"): string {
  const kind = githubStackApiErrorKind(error);
  if (kind === "missing") {
    return action === "merge"
      ? "GitHub does not expose stack merge for this repository yet."
      : "GitHub does not expose stack rebase for this repository yet.";
  }
  if (kind === "forbidden") {
    return action === "merge"
      ? "This credential cannot merge GitHub stacks."
      : "This credential cannot rebase GitHub stacks.";
  }
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  return message || (action === "merge" ? "GitHub could not merge this stack." : "GitHub could not rebase this stack.");
}
