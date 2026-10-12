/**
 * True for a `session_meta_updated` event that carries `field` and nothing
 * else (apart from its `type` and the keys in `alsoAllowed`). Such an event patches one piece of client
 * state; it is not chat activity, so it moves no chat up a list.
 */
export function isSessionMetaOnly(event: { type: string }, field: string, alsoAllowed: readonly string[] = []): boolean {
  if (event.type !== "session_meta_updated" || (event as Record<string, unknown>)[field] === undefined) return false;
  return Object.keys(event).every((key) => key === "type" || key === field || alsoAllowed.includes(key));
}
