import { appendEvent, initPerfRunFromEnv } from "./perfLog";

/**
 * Zero-cost when `ADE_PERF_RUN_ID` is unset: the maps are never allocated and
 * every entry point returns on a single boolean check without allocating.
 *
 * Which processes emit `chatTextFlush`
 * ------------------------------------
 * `agentChatService` is not Electron-only. It is imported by the desktop main
 * process AND by the `ade` CLI sync host (`apps/ade-cli/src/services/sync/
 * syncHostService.ts`), which is what runs inside the runtime daemon — a
 * separate process listening on `/tmp/ade-runtime-dev.sock` in dev. In a normal
 * dev session the daemon, not Electron main, hosts the chat sessions, so it is
 * the process that must emit these events.
 *
 * Two things have to be true there, and only the first is free:
 *   1. `ADE_PERF_RUN_ID` must be in the daemon's environment. The dev launcher
 *      spawns the daemon with the full parent env (`detachedDevRuntimeEnv` in
 *      scripts/dev-shared.mjs), so a run id exported for `npm run dev:desktop`
 *      reaches it — but ONLY when the launcher actually spawns one. An already
 *      listening, non-stale daemon is reused as-is and keeps whatever env it
 *      was born with, so a perf run must stop it first (perf-launch.mjs does).
 *   2. Something must call `initPerfRunFromEnv()`. Only `main.ts` does, and the
 *      daemon never loads it, so `appendEvent` silently no-opped there. Hence
 *      the lazy init below: perfLog is plain `node:fs` with no Electron imports,
 *      so it works unchanged in the CLI daemon.
 *
 * Both processes can be live at once (Electron main hosts some sessions while
 * the daemon hosts others) and they append to the same `events.jsonl`.
 * `appendEvent` uses a single `appendFileSync` of one already-terminated line,
 * i.e. one O_APPEND write per event, so interleaved writers cannot split a line.
 */
export type ChatTextFlushReason = "timer" | "identityBreak" | "interleave" | "other";

const enabled = (process.env.ADE_PERF_RUN_ID ?? "").length > 0;
const MAX_TRACKED_SESSIONS = 512;
let runInitialized = false;

const deltasBySession: Map<string, number> | null = enabled ? new Map() : null;
const lastFlushAtBySession: Map<string, number> | null = enabled ? new Map() : null;

export function isChatTextProbeEnabled(): boolean {
  return enabled;
}

/** Called once per assistant text delta that enters the coalescer. */
export function noteChatTextDelta(sessionId: string): void {
  if (!deltasBySession) return;
  if (deltasBySession.size > MAX_TRACKED_SESSIONS) deltasBySession.clear();
  deltasBySession.set(sessionId, (deltasBySession.get(sessionId) ?? 0) + 1);
}

/** Called once per coalescer flush that actually commits text. */
export function recordChatTextFlush(
  sessionId: string,
  chars: number,
  reason: ChatTextFlushReason,
): void {
  if (!deltasBySession || !lastFlushAtBySession) return;
  if (!runInitialized) {
    // Idempotent: in Electron main the run is already active and this returns
    // it unchanged; in the CLI runtime daemon this is what activates the log.
    runInitialized = true;
    initPerfRunFromEnv();
  }
  const deltasCoalesced = deltasBySession.get(sessionId) ?? 0;
  deltasBySession.delete(sessionId);
  const ts = Date.now();
  const previousFlushAt = lastFlushAtBySession.get(sessionId);
  if (lastFlushAtBySession.size > MAX_TRACKED_SESSIONS) lastFlushAtBySession.clear();
  lastFlushAtBySession.set(sessionId, ts);
  appendEvent({
    ts,
    kind: "chatTextFlush",
    sessionId,
    chars,
    deltasCoalesced,
    msSinceLastFlush: previousFlushAt === undefined ? null : ts - previousFlushAt,
    reason,
    // Which host process produced this flush (Electron main vs runtime daemon).
    pid: process.pid,
  });
}
