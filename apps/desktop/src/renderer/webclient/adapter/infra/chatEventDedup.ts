import type { SyncChatEventPayload } from "../../../../shared/types/sync";
import { stableCacheKey } from "./cacheKey";

export function chatEventDedupKey(payload: SyncChatEventPayload): string {
  if (typeof payload.seq === "number") {
    return `${payload.sessionId}:sync-seq:${payload.seq}:${eventFingerprint(payload)}`;
  }

  const sourceSequence = typeof payload.sequence === "number"
    ? `:${payload.sequence}`
    : "";
  return `${payload.sessionId}:source${sourceSequence}:${eventFingerprint(payload)}`;
}

function eventFingerprint(payload: SyncChatEventPayload): string {
  const serialized = stableCacheKey({
    timestamp: payload.timestamp,
    event: payload.event,
    provenance: payload.provenance ?? null,
  });
  let first = 2_166_136_261;
  let second = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 1_597_334_677);
  }
  return `${serialized.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}
