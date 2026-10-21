import type { AiChatConfig } from "./types/config";
import type { JevFeature } from "./types/jev";

/**
 * Settings › Chat › Smart decisions: one master switch, then one switch per
 * group of Jev features. A group switched off answers `null` for its
 * features, so they use ADE's built-in rules, exactly as when Jev is down.
 */
export type JevSettingsGroup = "chatStatus" | "settleNudge" | "modelHint" | "palette" | "laneEmoji";

export const JEV_FEATURE_GROUP: Record<JevFeature, JevSettingsGroup> = {
  turn_end: "chatStatus",
  cli_status: "chatStatus",
  status_line: "chatStatus",
  settle_nudge: "settleNudge",
  model_hint: "modelHint",
  palette: "palette",
  lane_emoji: "laneEmoji",
};

/** The `ai.chat` switch of each group; the model hint's is `modelHintMode`. */
export const JEV_GROUP_CONFIG_KEY = {
  chatStatus: "smartChatStatusEnabled",
  settleNudge: "smartSettleNudgeEnabled",
  palette: "smartPaletteEnabled",
  laneEmoji: "smartLaneEmojiEnabled",
} as const satisfies Record<Exclude<JevSettingsGroup, "modelHint">, keyof AiChatConfig>;

/** Whether Jev may be asked: the master switch, and with a feature, its group's switch. Everything is on unless set off. */
export function jevEnabled(chat: AiChatConfig | null | undefined, feature?: JevFeature): boolean {
  if (chat?.smartDecisionsEnabled === false) return false;
  if (!feature) return true;
  const group = JEV_FEATURE_GROUP[feature];
  if (group === "modelHint") return chat?.modelHintMode !== "off";
  return chat?.[JEV_GROUP_CONFIG_KEY[group]] !== false;
}
