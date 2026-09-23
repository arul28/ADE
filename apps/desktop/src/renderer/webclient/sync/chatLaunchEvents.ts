import type { ChatLaunchEvent } from "../../../shared/types";

/**
 * Validate a pushed `chat_launch_event` envelope's payload, which is the
 * `ChatLaunchEvent` itself (the sync host sends it unwrapped). Anything else —
 * a malformed or future event shape — is dropped.
 */
export function decodeChatLaunchEventPayload(payload: unknown): ChatLaunchEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as { type?: unknown; launch?: unknown; launchId?: unknown };
  if (event.type === "launch-updated" && event.launch && typeof event.launch === "object") {
    return payload as ChatLaunchEvent;
  }
  if (event.type === "launch-removed" && typeof event.launchId === "string") {
    return payload as ChatLaunchEvent;
  }
  return null;
}
