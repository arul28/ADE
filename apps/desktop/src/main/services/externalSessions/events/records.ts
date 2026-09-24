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
import type { ExternalSessionDiscoveryRecord } from "../discoveryUtils";

/** Exact-id lookup of one session's discovery record, or null when it is gone. */
export async function discoverExternalSessionRecord(
  provider: ExternalSessionProvider,
  sessionId: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExternalSessionDiscoveryRecord | null> {
  const args = {
    sessionId,
    limit: 1,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  switch (provider) {
    case "claude":
      return (await discoverClaudeSessions(args))[0] ?? null;
    case "codex":
      return (await discoverCodexSessions(args))[0] ?? null;
    case "cursor":
      return (await discoverCursorSessions(args))[0] ?? null;
    case "droid":
      return (await discoverDroidSessions(args))[0] ?? null;
    case "opencode":
      return (await discoverOpenCodeSessions(args))[0] ?? null;
    case "pi":
      return (await discoverPiSessions(args))[0] ?? null;
    case "qwen":
      return (await discoverQwenSessions(args))[0] ?? null;
    case "kimi":
      return (await discoverKimiSessions(args))[0] ?? null;
    case "grok":
      return (await discoverGrokSessions(args))[0] ?? null;
    case "copilot":
      return (await discoverCopilotSessions(args))[0] ?? null;
    default: {
      const _never: never = provider;
      return _never;
    }
  }
}
