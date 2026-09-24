import { claudeRecordsToContentEvents } from "../../chat/externalChatHistoryImport";
import type { JsonlConverter } from "./common";

/**
 * Claude Code JSONL (`~/.claude/projects/<slug>/<id>.jsonl`) and Factory Droid
 * JSONL (`~/.factory/sessions/<slug>/<id>.jsonl`). Droid writes the same
 * message shape — `{ type: "message", timestamp, message: { role, content } }`
 * with `text` / `tool_use` / `tool_result` / `thinking` blocks — so both go
 * through the import converter. Thinking blocks are dropped, as on import.
 */
export const claudeRecordsToEvents: JsonlConverter = (records, ctx) =>
  claudeRecordsToContentEvents(records, ctx.options, ctx.fallbackMs);
