import type { JevService } from "../jev/jevService";
import type { Logger } from "../logging/logger";
import { clipTail } from "../shared/utils";

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
    `Status line: ${clipTail(args.statusLine, MAX_STATUS_LINE_CHARS)}`,
    ...(args.userMessage?.trim() ? [`The user's last message: ${clipTail(args.userMessage, MAX_USER_MESSAGE_CHARS)}`] : []),
    "The agent's final reply:",
    clipTail(args.reply, MAX_REPLY_CHARS),
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

export type StatusLineStaleRegenDeps = {
  decide: JevService["decide"] | null | undefined;
  logger: Logger;
  /** The chat's current status line, read again before regenerating. */
  readStatusLine: (sessionId: string) => string | null | undefined;
  /** The same refresh "Generate status line" runs. */
  regenerate: (sessionId: string) => Promise<unknown>;
};

/**
 * The agent wrote its own status line during the turn, so ADE kept it. Ask
 * Jev, once, whether the turn's final reply has moved past it; if so, run
 * the same refresh "Generate status line" does. No answer keeps the line.
 */
export function createStatusLineStaleRegen(deps: StatusLineStaleRegenDeps) {
  const { logger } = deps;
  return (args: {
    sessionId: string;
    /** Read only once there is a status line to judge. */
    readTurn: () => { reply: string; userMessage: string | null };
    /** True only while nothing moved: same live chat, still idle, no new turn since. */
    isUnchanged: () => boolean;
  }): void => {
    const { decide } = deps;
    if (!decide) return;
    const { sessionId } = args;
    const statusLine = deps.readStatusLine(sessionId)?.trim();
    if (!statusLine) return;
    const { reply, userMessage } = args.readTurn();
    if (!reply.trim()) return;
    void statusLineLooksStale({ decide, statusLine, userMessage, reply })
      .then((stale) => {
        if (stale !== true || !args.isUnchanged()) return;
        // And the same line: a newer one is the agent's or the user's to keep.
        if (deps.readStatusLine(sessionId)?.trim() !== statusLine) return;
        logger.info("agent_chat.status_line_stale", { sessionId });
        return deps.regenerate(sessionId).then(() => undefined);
      })
      .catch((error) => {
        logger.warn("agent_chat.status_line_check_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}
