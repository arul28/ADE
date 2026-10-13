import { museRecordsFromLogLine } from "../discoverMuse";
import { EnvelopeSink, isRecord, str, type JsonlConverter } from "./common";

/**
 * Muse Code session log (`~/.local/share/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`).
 * A line is a record or a frame wrapping several; see `discoverMuse.ts`. User
 * turns are `runtime.user_intent.accepted` on the main surface, replies are
 * `assistant_message_committed` run events. Everything else (task lifecycle,
 * context diagnostics, reminders) is runtime bookkeeping, not conversation.
 */
export const museRecordsToEvents: JsonlConverter = (records, ctx) => {
  const sink = new EnvelopeSink(ctx.options);
  records.forEach((line, index) => {
    if (!isRecord(line)) return;
    museRecordsFromLogLine(line).forEach((record, childIndex) => {
      const key = `muse:${ctx.lineKeys[index] ?? index}:${childIndex}`;
      const recordedAt = typeof record.recorded_at === "number" && record.recorded_at > 0
        ? Math.floor(record.recorded_at / 1000)
        : ctx.fallbackMs(index);
      const timestamp = new Date(recordedAt).toISOString();
      const payload = isRecord(record.payload) ? record.payload : null;
      if (!payload) return;
      if (record.payload_type === "runtime.user_intent.accepted") {
        if (str(payload.surface) && payload.surface !== "main") return;
        const kind = isRecord(payload.semantic_kind) ? str(payload.semantic_kind.kind) : null;
        if (kind && kind !== "chat") return;
        const blocks = Array.isArray(payload.refill_blocks) ? payload.refill_blocks : [];
        const text = blocks
          .map((block) => (isRecord(block) && block.kind === "text" ? str(block.text) : null))
          .filter((part): part is string => part != null)
          .join("\n");
        if (text) sink.user(text, timestamp, key);
        return;
      }
      if (record.payload_type === "runtime.session" && payload.kind === "run" && isRecord(payload.event)) {
        const event = payload.event;
        if (event.kind === "assistant_message_committed") {
          const text = str(event.text);
          if (text) sink.text(text, timestamp, str(event.message_id) ?? key);
        }
      }
    });
  });
  return sink.out;
};
