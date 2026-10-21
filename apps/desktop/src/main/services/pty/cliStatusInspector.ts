import type { JevAnswer, JevQuestions } from "../../../shared/types/jev";
import { stripAnsi } from "../../utils/ansiStrip";
import { redactSecrets } from "../../utils/redaction";

/**
 * The pure half of the idle-terminal check: what an idle terminal's screen
 * becomes before it goes to Jev (an external service), and what Jev's answer
 * means. ptyService keeps the orchestration (idle checks, dedupe, the call,
 * the re-validation race).
 */

const CLI_STATUS_CONFIDENCE_FLOOR = 0.85;
const CLI_STATUS_VISIBLE_LINES = 40;
/** Raw output read from the live tail before ANSI stripping; 40 lines fit easily. */
const CLI_STATUS_RAW_OUTPUT_CHARS = 16_000;
const CLI_STATUS_MAX_LINE_CHARS = 200;
const CLI_STATUS_MAX_TAIL_CHARS = 4_000;

export const CLI_STATUS_QUESTIONS = {
  status: {
    type: "choice",
    instructions: "Classify the current terminal screen. Choose waiting_for_input only when it clearly asks the user to answer, confirm, approve, enter a password, choose a menu item, or press a key. Choose working for visible ongoing work or progress, finished for a completed result with no pending request, errored for a clear failure or crash, and shell_prompt only for a plain shell prompt with no command running.",
    criteria: {
      working: "The program is still doing work, streaming, or visibly progressing; it is not asking the user and has not returned to a shell prompt.",
      waiting_for_input: "The screen clearly needs a user response: a question, yes/no confirmation, permission or approval, password, menu choice, or instruction to press a key or Enter.",
      finished: "The command or task printed its result and is done; there is no unresolved question, approval, or input request.",
      errored: "The command clearly failed, crashed, or printed a fatal error; there is no unresolved request the user can answer to continue it.",
      shell_prompt: "A plain interactive shell prompt is visible and no command is running.",
    },
  },
} satisfies JevQuestions;

export function isRecognizedShellPromptLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  return /^(?:[$#%❯›➜>]|-?[A-Za-z_][\w.-]*[$#%]|[A-Za-z_][\w.-]*@[\w.-]+(?:\s+.*)?\s*[$#%]|[A-Za-z_][\w.-]*\s+.*\s*[$#%]|PS\s+.+>|[A-Za-z]:\\[^>]*>)$/u.test(text);
}

/**
 * Screen text from the raw live output tail (up to 2M chars). Cuts to the
 * last few KB before stripping ANSI, and drops the first partial line, which
 * may start inside an escape sequence.
 */
export function cliStatusScreenTextFromOutputTail(rawTail: string): string {
  let raw = rawTail;
  if (raw.length > CLI_STATUS_RAW_OUTPUT_CHARS) {
    raw = raw.slice(raw.length - CLI_STATUS_RAW_OUTPUT_CHARS);
    const firstBreak = raw.search(/[\r\n]/u);
    raw = firstBreak >= 0 ? raw.slice(firstBreak + 1) : raw;
  }
  return stripAnsi(raw).replace(/\r\n?/gu, "\n");
}

function capLine(line: string): string {
  if (line.length <= CLI_STATUS_MAX_LINE_CHARS) return line;
  let head = line.slice(0, CLI_STATUS_MAX_LINE_CHARS);
  // Do not leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

function commandName(resumeCommand: string | null | undefined): string {
  const rawCommand = resumeCommand?.trim() ?? "";
  const commandToken = rawCommand.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  return (commandToken?.[1] ?? commandToken?.[2] ?? commandToken?.[3] ?? "")
    .split(/[\\/]/u)
    .at(-1) ?? "";
}

export type CliStatusRequest = {
  /** The Jev state text: session kind, command, and `tail`. */
  state: string;
  /** The bounded, redacted screen tail sent to Jev. Hash this for dedupe. */
  tail: string;
  /** Last non-empty line of `tail` (bounded and redacted). */
  lastLine: string;
};

/**
 * What to send Jev for an idle terminal, or null when there is nothing to ask:
 * an empty screen, or a plain shell sitting at a recognized prompt. The tail
 * is the last 40 lines, secrets redacted, each line capped at 200 chars and
 * the whole tail at 4,000 chars.
 */
export function buildCliStatusRequest(
  screenText: string,
  facts: { isTrackedCli: boolean; toolTypeHint: string | null; resumeCommand: string | null },
): CliStatusRequest | null {
  const visible = screenText
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .slice(-CLI_STATUS_VISIBLE_LINES)
    .join("\n");
  const lines = redactSecrets(visible).split("\n").map(capLine);
  let tail = lines.join("\n").trim();
  if (tail.length > CLI_STATUS_MAX_TAIL_CHARS) {
    // Drop whole leading lines; the bottom of the screen is what matters.
    const cut = tail.slice(tail.length - CLI_STATUS_MAX_TAIL_CHARS);
    const firstBreak = cut.indexOf("\n");
    tail = (firstBreak >= 0 ? cut.slice(firstBreak + 1) : cut).trim();
  }
  if (!tail) return null;
  const lastLine = tail.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (!facts.isTrackedCli && isRecognizedShellPromptLine(lastLine)) return null;

  const command = commandName(facts.resumeCommand);
  const sessionKind = facts.isTrackedCli
    ? `tracked provider CLI (${facts.toolTypeHint})`
    : `plain shell or terminal (${facts.toolTypeHint ?? "unknown"})`;
  const state = [
    `Session kind: ${sessionKind}`,
    ...(command ? [`Command: ${command}`] : []),
    "Last visible terminal lines:",
    tail,
  ].join("\n");
  return { state, tail, lastLine };
}

/** What a Jev answer means for the session; below the confidence floor, nothing. */
export function classifyCliStatus(answer: JevAnswer | null | undefined): "waiting" | "errored" | "ignore" {
  if (answer?.type !== "choice" || !(answer.confidence >= CLI_STATUS_CONFIDENCE_FLOOR)) return "ignore";
  if (answer.choice === "waiting_for_input") return "waiting";
  if (answer.choice === "errored") return "errored";
  return "ignore";
}
