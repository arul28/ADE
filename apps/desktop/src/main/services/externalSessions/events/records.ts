import type { ExternalSessionProvider } from "../../../../shared/types";
import { discoverClaudeSessions } from "../discoverClaude";
import { discoverCodexSessions } from "../discoverCodex";
import { discoverCopilotSessions } from "../discoverCopilot";
import { discoverCursorSessions } from "../discoverCursor";
import { discoverDroidSessions } from "../discoverDroid";
import { discoverGrokSessions } from "../discoverGrok";
import { discoverKimiSessions } from "../discoverKimi";
import { discoverOpenCodeSessions } from "../discoverOpenCode";
import { discoverPiSessions } from "../discoverPi";
import { discoverQwenSessions } from "../discoverQwen";
import type { ExternalSessionDiscoveryArgs, ExternalSessionDiscoveryRecord } from "../discoveryUtils";

/** The one provider-to-discoverer table; listing, import, and detail lookup all use it. */
export const EXTERNAL_SESSION_DISCOVERERS: Record<
  ExternalSessionProvider,
  (args: ExternalSessionDiscoveryArgs) => Promise<ExternalSessionDiscoveryRecord[]>
> = {
  claude: discoverClaudeSessions,
  codex: discoverCodexSessions,
  cursor: discoverCursorSessions,
  droid: discoverDroidSessions,
  opencode: discoverOpenCodeSessions,
  pi: discoverPiSessions,
  qwen: discoverQwenSessions,
  kimi: discoverKimiSessions,
  grok: discoverGrokSessions,
  copilot: discoverCopilotSessions,
};

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
