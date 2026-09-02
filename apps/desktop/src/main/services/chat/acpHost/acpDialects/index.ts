/**
 * The dialect registry.
 *
 * The table is an exhaustive `Record`. Adding a member to `AcpProviderId`
 * without adding its dialect is a compile error, so no provider can reach the
 * host through a silent default branch.
 */

import type { AcpDialect, AcpProviderId } from "../acpHostTypes";
import { copilotDialect } from "./copilot";
import { grokDialect } from "./grok";
import { kimiDialect } from "./kimi";
import { qwenDialect } from "./qwen";

export const ACP_DIALECTS: Record<AcpProviderId, AcpDialect> = {
  qwen: qwenDialect,
  kimi: kimiDialect,
  grok: grokDialect,
  copilot: copilotDialect,
};

export function acpDialectFor(providerId: AcpProviderId): AcpDialect {
  return ACP_DIALECTS[providerId];
}

export { copilotDialect, grokDialect, kimiDialect, qwenDialect };
export { COPILOT_TUI_ONLY_COMMANDS, includeCopilotSlashCommand } from "./copilot";
export {
  GROK_CLAUDE_MARKER_OVERRIDE_ENV,
  GROK_MINIMUM_VERSION,
  GROK_SESSION_NOTIFICATION_METHOD,
  GROK_YOLO_MODE_CHANGED_METHOD,
  grokPermissionModeFlags,
  grokSupervisionEnv,
  readGrokPromptUsage,
} from "./grok";
export { KIMI_USAGE_DEGRADATION_NOTE, KIMI_WINDOWS_DEGRADATION_NOTE } from "./kimi";
export { QWEN_CONFIG_OPTION_IDS } from "./qwen";
