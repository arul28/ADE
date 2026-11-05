import type { Logger } from "../logging/logger";

/**
 * `github.token_validation_failed`, once per credential source and cause.
 *
 * Every status read probes each credential, and a credential that keeps
 * failing the same way (a repository that answers 404, no network) failed
 * that way on every read: hundreds of identical warn lines an hour, all
 * saying the first one again. A new cause warns; a repeat goes to the local
 * log at info; a probe that passes clears the source.
 */
export function createTokenValidationFailureLog(logger: Pick<Logger, "warn" | "info">) {
  const lastCause = new Map<string, string>();
  return {
    failed(meta: { source: string; error: string | null | undefined; kind: string; retryAt: string | null | undefined }): void {
      const cause = `${meta.kind}:${meta.error ?? ""}`;
      const repeated = lastCause.get(meta.source) === cause;
      lastCause.set(meta.source, cause);
      logger[repeated ? "info" : "warn"]("github.token_validation_failed", meta);
    },
    validated(source: string): void {
      lastCause.delete(source);
    },
  };
}
