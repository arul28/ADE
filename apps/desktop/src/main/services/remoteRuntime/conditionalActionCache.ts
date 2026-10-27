import type { RemoteRuntimeActionRequest } from "../../../shared/types/remoteRuntime";

/**
 * What is kept, the oldest going first: at most this many results, and at most
 * this much of them as JSON. Only results of 8 KB and up are kept at all.
 */
const MAX_ENTRIES = 48;
const MAX_TOTAL_CHARS = 16 * 1024 * 1024;

type Entry = { targetId: string; etag: string; chars: number; record: Record<string, unknown> };

/**
 * The caller side of a conditional `run_ade_action` read (see
 * `shared/conditionalActionResult.ts`): the last large result of each call, by
 * target, project, action and arguments, with the etag its host gave it.
 */
export class ConditionalActionCache {
  private readonly entries = new Map<string, Entry>();
  private totalChars = 0;

  key(targetId: string, projectId: string, request: RemoteRuntimeActionRequest): string {
    return JSON.stringify([
      targetId,
      projectId,
      request.domain,
      request.action,
      request.args ?? null,
      Object.prototype.hasOwnProperty.call(request, "arg") ? request.arg : null,
      request.argsList ?? null,
    ]);
  }

  etagFor(key: string): string | null {
    return this.entries.get(key)?.etag ?? null;
  }

  /**
   * The record to hand back for a reply: the kept result when the host said it
   * has not changed, the reply itself otherwise (kept when it carries an etag).
   * Null when the host said "not modified" for a result this side no longer has.
   */
  resolve(targetId: string, key: string, reply: Record<string, unknown>): Record<string, unknown> | null {
    const etag = typeof reply.etag === "string" ? reply.etag : null;
    if (reply.notModified === true) {
      const kept = this.entries.get(key);
      if (!kept || !etag || kept.etag !== etag) return null;
      // Read again: it moves to the newest end.
      this.entries.delete(key);
      this.entries.set(key, kept);
      // Status hints describe this moment, not the kept result.
      return { ...kept.record, ...(reply.statusHints !== undefined ? { statusHints: reply.statusHints } : {}) };
    }
    this.remove(key);
    const chars = typeof reply.etagChars === "number" && Number.isFinite(reply.etagChars) ? reply.etagChars : 0;
    if (etag && "result" in reply && chars <= MAX_TOTAL_CHARS) {
      this.entries.set(key, { targetId, etag, chars, record: reply });
      this.totalChars += chars;
      while (this.entries.size > MAX_ENTRIES || this.totalChars > MAX_TOTAL_CHARS) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.remove(oldest);
      }
    }
    return reply;
  }

  forgetTarget(targetId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.targetId === targetId) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalChars -= entry.chars;
  }
}
