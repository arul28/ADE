/**
 * The dialect registry.
 *
 * The table is an exhaustive `Record`. Adding a member to `AcpProviderId`
 * without adding its dialect is a compile error, so no provider can reach the
 * host through a silent default branch.
 */

import type { AcpDialect, AcpProviderId } from "../acpHostTypes";
import { devinDialect } from "./devin";
import { devinCloudDialect } from "./devinCloud";
import { grokDialect } from "./grok";
import { kimiDialect } from "./kimi";
import { qwenDialect } from "./qwen";

export const ACP_DIALECTS: Record<AcpProviderId, AcpDialect> = {
  qwen: qwenDialect,
  kimi: kimiDialect,
  grok: grokDialect,
  devin: devinDialect,
};

/**
 * The dialect for a provider. `cloud` selects a provider's hosted variant; only
 * Devin has one (`devin acp --cloud`), and every other provider ignores it.
 */
export function acpDialectFor(providerId: AcpProviderId, options?: { cloud?: boolean }): AcpDialect {
  if (options?.cloud && providerId === "devin") return devinCloudDialect;
  return ACP_DIALECTS[providerId];
}

export { devinCloudDialect, devinDialect, grokDialect, kimiDialect, qwenDialect };
export {
  GROK_CLAUDE_MARKER_OVERRIDE_ENV,
  GROK_CONFIG_OPTION_IDS,
  GROK_YOLO_MODE_CHANGED_METHOD,
  grokPermissionModeFlags,
  grokSupervisionEnv,
} from "./grok";
export { readGrokPromptUsage } from "./grokTelemetry";
export {
  KIMI_CONFIG_OPTION_IDS,
  KIMI_WINDOWS_DEGRADATION_NOTE,
} from "./kimi";
export { QWEN_CONFIG_OPTION_IDS, QWEN_DEFAULT_REASONING_EFFORT } from "./qwen";
export {
  buildQwenAdeSkillDefaults,
  ensureQwenAdeSkillDefaultsFile,
  qwenAdeSkillDefaultsPath,
  qwenNativeSystemDefaultsPath,
  QWEN_SYSTEM_DEFAULTS_PATH_ENV,
  QWEN_SYSTEM_SETTINGS_PATH_ENV,
  type QwenSkillDefaultsResult,
} from "./qwenSkillDefaults";

export { DEVIN_CLOUD_CONFIG_OPTION_IDS, devinCloudAcpSessionId, devinCloudBareSessionId } from "./devinCloud";
