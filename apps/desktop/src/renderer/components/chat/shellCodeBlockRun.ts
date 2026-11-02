import { stripAnsiWithOptions } from "../../../shared/ansiStrip";

/**
 * Running a shell code block from a chat reply: which blocks can run, what
 * runs, and what the agent is told afterwards. Pure, so the rules can be read
 * (and tested) without a terminal.
 *
 * A block runs through its interpreter directly (`bash -c <script>`,
 * `powershell.exe -EncodedCommand <script>`), not typed into an interactive
 * shell. The script reaches the interpreter byte for byte whatever the user's
 * login shell is (zsh, fish, PowerShell, cmd), heredocs and multi-line scripts
 * included, and the terminal's exit is the command's exit, with its code.
 */

/** How a fenced language runs, or null when it is not a shell block at all. */
export type ShellBlockDialect = "posix" | "powershell" | "cmd";

const POSIX_LANGUAGES: Readonly<Record<string, string>> = {
  bash: "bash",
  sh: "sh",
  zsh: "zsh",
  shell: "bash",
  console: "bash",
};

const POWERSHELL_LANGUAGES = new Set(["powershell", "pwsh", "ps1", "ps"]);
const CMD_LANGUAGES = new Set(["cmd", "bat", "batch"]);

export function shellBlockDialect(language: string): ShellBlockDialect | null {
  const lang = language.trim().toLowerCase();
  if (lang in POSIX_LANGUAGES) return "posix";
  if (POWERSHELL_LANGUAGES.has(lang)) return "powershell";
  if (CMD_LANGUAGES.has(lang)) return "cmd";
  return null;
}

/**
 * The commands of a `console` block: its prompt lines (`$ ` or `% `) without
 * the prompt, and nothing it shows as output. A prompt line ending in `\`
 * continues on the next line, which may carry a `> ` continuation prompt.
 */
export function consoleBlockCommands(code: string): string {
  const commands: string[] = [];
  let continuing = false;
  for (const line of code.split("\n")) {
    if (continuing) {
      const continued = line.replace(/^\s*> ?/, "");
      commands.push(continued);
      continuing = continued.endsWith("\\");
      continue;
    }
    const prompt = /^\s*[$%](?: (.*))?$/.exec(line);
    if (!prompt) continue;
    const command = prompt[1] ?? "";
    if (!command.trim()) continue;
    commands.push(command);
    continuing = command.endsWith("\\");
  }
  return commands.join("\n");
}

/** The text a block would run, before any machine is considered. Empty when nothing would. */
export function shellBlockScript(code: string, language: string): string {
  const normalized = code.replace(/\r\n?/g, "\n");
  const script = language.trim().toLowerCase() === "console" ? consoleBlockCommands(normalized) : normalized;
  return script.trim().length > 0 ? script.replace(/\n+$/, "") : "";
}

/*
 * Command-line ceilings. Windows caps a whole command line at 32,767 UTF-16
 * units, and the encoded script grows to 8/3 of its length plus the
 * interpreter's own words. Linux caps one argument at 128 KiB.
 */
const MAX_WINDOWS_SCRIPT_CHARS = 10_000;
const MAX_POSIX_SCRIPT_BYTES = 120_000;

export type ShellBlockRunPlan =
  | {
      ok: true;
      /** What runs, after the `console` prompt lines are taken out. */
      script: string;
      /** The interpreter, resolved on the chat's machine. */
      command: string;
      args: string[];
      /** The interpreter's name, for the confirm and the terminal tab. */
      shellLabel: string;
    }
  | { ok: false; reason: string };

/**
 * What a block runs on a machine, or why it cannot.
 *
 * `machineIsWindows` is the chat's machine, not this computer: a bash block
 * from a chat on a Windows PC would reach PowerShell, and a PowerShell block
 * from a chat on a Mac would reach a shell that has no PowerShell.
 */
export function planShellBlockRun(args: { code: string; language: string; machineIsWindows: boolean }): ShellBlockRunPlan | null {
  const dialect = shellBlockDialect(args.language);
  if (!dialect) return null;
  const script = shellBlockScript(args.code, args.language);
  if (!script) return null;
  // Control and invisible format characters (bidi overrides, zero-width
  // spaces) can make the block read differently from what would run.
  if (/[\p{Cc}\p{Cf}]/u.test(script.replace(/[\n\t]/g, ""))) {
    return { ok: false, reason: "This block has hidden characters, so what it shows may not be what runs." };
  }
  if (dialect === "cmd") {
    return {
      ok: false,
      reason: args.machineIsWindows
        ? "cmd and batch blocks don't run from chat. PowerShell blocks do."
        : "cmd and batch blocks need Windows, and this chat runs on another system.",
    };
  }
  if (dialect === "powershell") {
    if (!args.machineIsWindows) {
      return { ok: false, reason: "PowerShell blocks run only when the chat's machine is Windows." };
    }
    if (script.length > MAX_WINDOWS_SCRIPT_CHARS) {
      return { ok: false, reason: "This script is too long to run from chat. Copy it into a terminal." };
    }
    return {
      ok: true,
      script,
      // Windows PowerShell ships with every Windows; `pwsh` may not be installed.
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShellCommand(script)],
      shellLabel: "PowerShell",
    };
  }
  if (args.machineIsWindows) {
    return { ok: false, reason: "This chat runs on Windows, which has no bash. Ask the agent for PowerShell." };
  }
  if (new TextEncoder().encode(script).length > MAX_POSIX_SCRIPT_BYTES) {
    return { ok: false, reason: "This script is too long to run from chat. Copy it into a terminal." };
  }
  const interpreter = POSIX_LANGUAGES[args.language.trim().toLowerCase()] ?? "bash";
  return { ok: true, script, command: interpreter, args: ["-c", script], shellLabel: interpreter };
}

/** `-EncodedCommand` takes base64 of UTF-16LE: no quoting, any script survives. */
export function encodePowerShellCommand(script: string): string {
  let binary = "";
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index);
    binary += String.fromCharCode(unit & 0xff, unit >> 8);
  }
  return btoa(binary);
}

/** A terminal tab's name for a run: the first line, shortened. */
export function shellRunTerminalTitle(script: string): string {
  const firstLine = script.split("\n").find((line) => line.trim())?.trim() ?? "Run";
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
}

/**
 * A finished terminal's raw output as a person read it: no escape sequences,
 * and carriage-return redraws (progress bars, spinners) keep only their last
 * state.
 */
export function plainTerminalOutput(raw: string): string {
  return stripAnsiWithOptions(raw, { preserveCarriageReturns: true })
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(/\n+$/, "");
}

const MAX_SENT_OUTPUT_CHARS = 20_000;

/** A fence that no run of backticks inside `text` can close early. */
function fenceFor(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(longest + 1);
}

/** The message "Send output to the agent" sends: where it ran, what ran, how it ended, and its raw output, cleaned. */
export function shellRunResultMessage(args: {
  script: string;
  language: string;
  machineName: string;
  folder: string;
  exitCode: number | null;
  output: string;
}): string {
  const output = plainTerminalOutput(args.output);
  const kept = output.length > MAX_SENT_OUTPUT_CHARS ? output.slice(-MAX_SENT_OUTPUT_CHARS) : output;
  const commandFence = fenceFor(args.script);
  const outputFence = fenceFor(kept);
  const language = args.language.trim().toLowerCase() === "console" ? "bash" : args.language.trim().toLowerCase();
  return [
    `I ran your code block in a terminal on ${args.machineName}, in \`${args.folder}\`.`,
    "",
    `${commandFence}${language}`,
    args.script,
    commandFence,
    "",
    args.exitCode === null ? "It ended without an exit code." : `Exit code: ${args.exitCode}`,
    "",
    kept.length === 0
      ? "It printed nothing."
      : kept.length < output.length
        ? `Output (the last ${kept.length.toLocaleString("en-US")} characters):`
        : "Output:",
    ...(kept.length === 0 ? [] : [`${outputFence}text`, kept, outputFence]),
  ].join("\n");
}
