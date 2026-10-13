import { museRecordsFromLogLine, museTurnFromRecord } from "../discoverMuse";
import { EnvelopeSink, isRecord, type JsonlConverter } from "./common";

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
      const turn = museTurnFromRecord(record);
      if (!turn?.text) return;
      const key = `muse:${ctx.lineKeys[index] ?? index}:${childIndex}`;
      const timestamp = new Date(turn.atMs ?? ctx.fallbackMs(index)).toISOString();
      if (turn.role === "user") sink.user(turn.text, timestamp, key);
      else sink.text(turn.text, timestamp, turn.messageId ?? key);
    });
  });
  return sink.out;
};
