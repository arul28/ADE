import type { Logger } from "../logging/logger";

/**
 * The one skill-delivery telemetry point.
 *
 * ADE had none: no log line recorded which skill roots resolved, how many
 * skills were advertised, whether the Claude plugin registered, or whether
 * Codex accepted the extra roots. Every one of those failures is silent at
 * runtime, so the only way to tell a working install from a broken one was to
 * read agent transcripts and infer it from behaviour.
 *
 * It lives here, next to the other skill services, rather than as a closure in
 * `agentChatService` — the mechanism union is part of the log contract, and a
 * `skill_delivery` row that names a mechanism nothing emits is exactly the kind
 * of silent breakage this event exists to expose.
 */
export type SkillDeliveryMechanism =
  | "claude-plugin"
  | "claude-listing"
  | "codex-extra-roots"
  | "pi-additional-paths"
  | "opencode-skill-paths"
  | "qwen-skill-directories"
  | "cursor-workspace-dirs";

export type SkillDeliveryDetail = {
  mechanism: SkillDeliveryMechanism;
  rootCount?: number;
  delivered: boolean;
  skillCount?: number;
  nativeCount?: number;
  omittedCount?: number;
  bytes?: number;
  reason?: string;
};

export type SkillDeliverySession = {
  id: string;
  provider: string;
};

export function logSkillDelivery(
  logger: Logger,
  session: SkillDeliverySession,
  detail: SkillDeliveryDetail,
): void {
  logger.info("agent_chat.skill_delivery", {
    sessionId: session.id,
    provider: session.provider,
    ...detail,
  });
}
