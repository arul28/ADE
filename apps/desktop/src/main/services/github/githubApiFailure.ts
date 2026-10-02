// No electron (or other main-only) imports here: the brain runtime bundles the
// PR services, which read GitHub failures through this helper.

/**
 * The HTTP status and parsed body of a failed GitHub REST call, or null.
 * Reads the fields `GithubCredentialAttemptError` carries by shape, so an
 * error that crossed a process or test boundary still matches.
 */
export function githubApiFailure(error: unknown): { status: number; body: unknown } | null {
  if (!(error instanceof Error)) return null;
  const { status, responseBody } = error as Error & { status?: unknown; responseBody?: unknown };
  return typeof status === "number" ? { status, body: responseBody ?? null } : null;
}
