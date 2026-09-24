import type { ExternalSessionProvider } from "../../../shared/types";

const UUID_EXTERNAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLI_EXTERNAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

/** The id's shape only: no separators, so it cannot address a path outside the store. */
export function isWellFormedExternalSessionId(provider: ExternalSessionProvider, id: string): boolean {
  const pattern = provider === "claude" || provider === "codex"
    ? UUID_EXTERNAL_SESSION_ID
    : CLI_EXTERNAL_SESSION_ID;
  return pattern.test(id.trim());
}

/**
 * The check for an id that is listed by exact id or imported. Discoverers join
 * the id into a store path, so an id with a separator could read a file outside
 * the provider's store. Detail lookups use {@link isWellFormedExternalSessionId}.
 */
export function validateExternalSessionId(provider: ExternalSessionProvider, id: string): string {
  const trimmed = id.trim();
  if (provider === "cursor" && trimmed.startsWith("agent-")) {
    throw new Error(
      "cursor external session id is not resumable by cursor-agent; refusing to import SDK-origin transcript.",
    );
  }
  if (!isWellFormedExternalSessionId(provider, trimmed)) {
    throw new Error(
      `${provider} external session id is invalid; refusing to import '${trimmed || "(empty)"}'.`,
    );
  }
  return trimmed;
}
