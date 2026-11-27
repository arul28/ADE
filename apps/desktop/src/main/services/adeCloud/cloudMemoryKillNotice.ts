import { scrubString } from "../../../shared/sentry/scrub";
import { BRAND } from "../../../shared/brand";

/**
 * What a chat is told when ADE Cloud's memory guard stopped a process
 * (`ade-cli/src/services/power/cloudMemoryGuard.ts`): a notice the person
 * sees in the chat, and a one-time note the agent reads ahead of its next
 * turn (the restart-note channel). Without them the agent saw only "Killed".
 */
export type CloudMemoryKillReport = {
  /**
   * The chat whose command it was: the `ADE_CHAT_SESSION_ID` in the stopped
   * process's environment. Null when it had none: every chat with a running
   * turn on this computer is told instead.
   */
  sessionId: string | null;
  pid: number;
  rssMb: number;
  /** This computer's memory. */
  totalMb: number;
  /** The stopped process's command line (the guard keeps 160 characters). */
  command: string;
};

/**
 * What one project's chat service did with a kill (`reportCloudMemoryKill`):
 * the chats it told, and `notAChat` when the process's `ADE_CHAT_SESSION_ID`
 * names a session of this project that is not an agent chat. A tracked agent
 * CLI's terminal carries its own terminal session id there, so the owner is
 * known and no chat is told; the terminal gets no notice (its own output
 * shows "Killed").
 */
export type CloudMemoryKillAnswer = { told: number; notAChat: boolean };

const COMMAND_LABEL_CHARS = 80;
const COMMAND_LABEL_WORDS = 4;

/**
 * The stopped command as a person reads it: the program and the words before
 * its first option, each path shortened to its last part
 * (`/usr/bin/node /w/node_modules/.bin/next build --token=…` reads
 * `node next build`). Options are left out, so an option's value (a token, a
 * password) never reaches the chat; what is left goes through the secret
 * scrubber too. At most 80 characters.
 */
export function cloudMemoryKillCommandLabel(command: string): string {
  const words: string[] = [];
  for (const word of command.trim().split(/\s+/).filter(Boolean)) {
    if (words.length >= COMMAND_LABEL_WORDS || (words.length > 0 && (word.startsWith("-") || word.includes("=")))) break;
    if (word.includes("=")) continue;
    words.push(word.includes("/") ? word.split("/").filter(Boolean).at(-1) ?? word : word);
  }
  const label = scrubString(words.join(" ")).replace(/["`]/g, "'");
  if (!label) return "a process";
  return label.length > COMMAND_LABEL_CHARS ? `${label.slice(0, COMMAND_LABEL_CHARS - 1).trimEnd()}…` : label;
}

function memoryText(mb: number): string {
  if (mb < 1024) return `${Math.max(0, Math.round(mb))} MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

const totalText = (totalMb: number) => `${Math.max(1, Math.round(totalMb / 1024))} GB`;

/** The chat notice: what was stopped, why, and how to get more memory. */
export function formatCloudMemoryKillNotice(kill: CloudMemoryKillReport): string {
  return `This ${BRAND.CLOUD_NAME} computer ran out of memory (${totalText(kill.totalMb)}, no swap), so ${BRAND.NAME} stopped its biggest process, "${cloudMemoryKillCommandLabel(kill.command)}" (${memoryText(kill.rssMb)}), before the computer had to restart. `
    + "For more memory, move the lane to a bigger size: the agent can ask you for one.";
}

/** The agent's one-time note ahead of its next turn. */
export function buildCloudMemoryKillNote(kill: CloudMemoryKillReport): string {
  return [
    `This ADE Cloud computer (${totalText(kill.totalMb)} memory, no swap) ran out of memory, so ADE's memory guard killed its biggest process, "${cloudMemoryKillCommandLabel(kill.command)}" (pid ${kill.pid}, ${memoryText(kill.rssMb)}).`,
    kill.sessionId ? "It was started from this chat; a command that ended with \"Killed\" was stopped this way." : "A command of yours that ended with \"Killed\" was stopped this way.",
    "Use less memory (fewer parallel jobs, a smaller build), or ask the user for a bigger size: `ade cloud resize --request --size <size> --reason \"…\"`.",
  ].join(" ");
}
