import type { ExternalSessionProvider } from "../../../../shared/types";
import { EXTERNAL_SESSION_DISCOVERERS } from "../discoverers";
import type { ExternalSessionDiscoveryRecord } from "../discoveryUtils";
import { isWellFormedExternalSessionId } from "../sessionIds";

/** Exact-id lookup of one session's discovery record, or null when it is gone. */
export async function discoverExternalSessionRecord(
  provider: ExternalSessionProvider,
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExternalSessionDiscoveryRecord | null> {
  // Detail and replay take the id straight from the caller (a remote viewer
  // included); refuse anything the list and import paths would refuse.
  if (!isWellFormedExternalSessionId(provider, sessionId)) return null;
  const [record] = await EXTERNAL_SESSION_DISCOVERERS[provider]({
    sessionId,
    limit: 1,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  return record ?? null;
}
