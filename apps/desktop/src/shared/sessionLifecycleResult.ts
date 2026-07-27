/**
 * Session lifecycle mutations answer in two different shapes depending on the
 * transport that carried them:
 *
 *   - the local IPC handlers (`sessions:snooze`, `sessions:wake`,
 *     `sessions:setSettleOverride`, `sessions:clearWokeMarker`) return a bare
 *     `boolean`;
 *   - the ADE action registry and the sync remote-command handlers return an
 *     envelope — `{ ok: true, sessionId, snoozedUntil }`, `{ ok, sessionId,
 *     reason }`, and friends — because those surfaces are also consumed by
 *     agents and the CLI, which want the echoed ids.
 *
 * Callers only ever want the boolean. Comparing the envelope to `true` (which
 * is what both boundaries used to do) silently reports every runtime-bound or
 * remote mutation as "did not apply", so ADE Web rolls its optimistic patch
 * back and a runtime-bound window shows the row unchanged.
 *
 * Normalize here, at the transport boundary, and leave the registry/sync
 * return shapes alone — other consumers depend on them.
 */
export function sessionLifecycleApplied(result: unknown): boolean {
  if (typeof result === "boolean") return result;
  if (result && typeof result === "object" && "ok" in result) {
    return (result as { ok?: unknown }).ok === true;
  }
  return false;
}
