import type { ExternalSessionProvider } from "../../../shared/types";
import { discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCopilotSessions } from "./discoverCopilot";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverGrokSessions } from "./discoverGrok";
import { discoverKimiSessions } from "./discoverKimi";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import { discoverPiSessions } from "./discoverPi";
import { discoverQwenSessions } from "./discoverQwen";
import type { ExternalSessionDiscoveryArgs, ExternalSessionDiscoveryRecord } from "./discoveryUtils";

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
