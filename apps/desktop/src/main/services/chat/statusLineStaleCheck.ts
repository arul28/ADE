import type { JevService } from "../jev/jevService";

/**
 * Jev's "outdated" bar. Measured on free Jev: notes the final reply had moved
 * past scored 0.70–0.95, notes that still held 0.06–0.14. A wrong "outdated"
 * only costs one regeneration, the same one "Generate status line" runs.
 */
const STALE_BAR = 0.65;
const MAX_STATUS_LINE_CHARS = 200;
const MAX_USER_MESSAGE_CHARS = 600;
const MAX_REPLY_CHARS = 2_000;

const STATUS_LINE_QUESTIONS = {
  stale: {
    type: "noul",
    instructions: "The status line is a short note shown in a list of chats to say where this chat stands now. Given the agent's final reply, is the status line outdated: it names work the reply shows is finished or abandoned, a step the reply has moved past, a different task, or a state the reply contradicts (for example it says testing or in progress while the reply says the work is done, or it says done while the reply says it is blocked or asking)? A status line that is short or vague but still true is not outdated.",
  },
} as const;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * Whether a status line the agent wrote during its turn no longer matches the
 * turn's final reply. `null` when Jev did not answer: keep the line, as today.
 */
export async function statusLineLooksStale(args: {
  decide: JevService["decide"];
  statusLine: string;
  userMessage: string | null;
  reply: string;
}): Promise<boolean | null> {
  const state = [
    `Status line: ${clip(args.statusLine, MAX_STATUS_LINE_CHARS)}`,
    ...(args.userMessage?.trim() ? [`The user's last message: ${clip(args.userMessage, MAX_USER_MESSAGE_CHARS)}`] : []),
    "The agent's final reply:",
    clip(args.reply, MAX_REPLY_CHARS),
  ].join("\n");
  const answers = await args.decide({
    feature: "status_line",
    priority: "background",
    state,
    questions: STATUS_LINE_QUESTIONS,
  });
  if (!answers) return null;
  return answers.stale.noul >= STALE_BAR;
}
