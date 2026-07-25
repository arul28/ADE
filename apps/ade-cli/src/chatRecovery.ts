import {
  isUnsupportedAgentChatRecoveryActionError,
  type AgentChatRecoverCodexTurnArgs,
  type AgentChatRecoverTurnArgs,
} from "../../desktop/src/shared/types/chat";

export {
  isUnsupportedAgentChatRecoveryActionError as isUnsupportedRecoveryActionError,
};

export const LEGACY_RECOVERY_ACTION_BY_NEUTRAL: Readonly<Record<
  AgentChatRecoverTurnArgs["action"],
  AgentChatRecoverCodexTurnArgs["action"]
>> = {
  wait: "wait",
  nudge: "steer",
  retry_same_runtime: "interrupt_retry_same_thread",
  restart_resume: "restart_resume_thread",
};
