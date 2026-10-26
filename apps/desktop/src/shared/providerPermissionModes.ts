import type { ShippedProvider } from "./providers";
import { AGENT_CHAT_PERMISSION_MODE_VALUES, type AgentChatPermissionMode } from "./types/chat";

/** The generic mode vocabulary validated by every chat creation path. */
export function providerPermissionModes(_provider: ShippedProvider): readonly AgentChatPermissionMode[] {
  return AGENT_CHAT_PERMISSION_MODE_VALUES;
}
