import type { ExternalSessionProvider } from "../../../../shared/types";
import { EXTERNAL_SESSION_DISCOVERERS } from "../discoverers";
import type { ExternalSessionDiscoveryRecord } from "../discoveryUtils";

/** Exact-id lookup of one session's discovery record, or null when it is gone. */
export async function discoverExternalSessionRecord(
  provider: ExternalSessionProvider,
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExternalSessionDiscoveryRecord | null> {
  const [record] = await EXTERNAL_SESSION_DISCOVERERS[provider]({
    sessionId,
    limit: 1,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  return record ?? null;
}
