/** Shared shell-quoting and command-line parsing utilities. */

type ShellPlatform = NodeJS.Platform | "browser";

function currentShellPlatform(): ShellPlatform {
  if (typeof process !== "undefined" && typeof process.platform === "string") return process.platform;
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) return "win32";
  return "browser";
}

function isWindowsPlatform(platform: ShellPlatform = currentShellPlatform()): boolean {
  return platform === "win32";
}

function quoteWindowsArg(arg: string): string {
  if (!arg.length) return "\"\"";
  if (!/[\s"]/.test(arg)) return arg;
  let quoted = "\"";
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2);
      quoted += "\"\"";
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
    }
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

/** Quote a single shell argument, adding double quotes if needed. */
export function quoteShellArg(arg: string, options: { platform?: ShellPlatform } = {}): string {
  if (!arg.length) return "\"\"";
  if (isWindowsPlatform(options.platform)) {
    return quoteWindowsArg(arg);
  }
  if (/^[a-zA-Z0-9_.:@%+=,-]+$/.test(arg)) return arg;
  if (/[\n\r\t\v\f]/.test(arg)) {
    const escaped = arg
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\v/g, "\\v")
      .replace(/\f/g, "\\f");
    return `$'${escaped}'`;
  }
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Join an array of command args into a shell-safe command line. */
export function commandArrayToLine(command: string[], options: { platform?: ShellPlatform } = {}): string {
  if (!command.length) return "";
  return command.map((arg) => quoteShellArg(arg, options)).join(" ");
}

/**
 * The native Windows shells ADE can land in have mutually incompatible quoting
 * rules, so a command line is only meaningful together with the shell that will
 * receive it. `kind` picks the ruleset; `shellPath` and `command` refine the two
 * places where PowerShell's behaviour depends on more than the shell family.
 */
export type WindowsShellLineTarget = {
  kind: "powershell" | "cmd" | "git-bash";
  /** The shell executable, used to tell Windows PowerShell 5.1 from pwsh 7+. */
  shellPath?: string | null;
};

function isWindowsPowerShellFive(shellPath: string | null | undefined): boolean {
  const basename = String(shellPath ?? "powershell.exe")
    .replace(/\//g, "\\")
    .split("\\")
    .pop()
    ?.toLowerCase() ?? "";
  // pwsh is PowerShell 7+, which builds native command lines correctly.
  // Anything else reaching the powershell kind is Windows PowerShell 5.1.
  return basename !== "pwsh" && basename !== "pwsh.exe";
}

/**
 * Windows PowerShell 5.1 builds a native process's command line by wrapping
 * arguments that contain whitespace in double quotes, *without* escaping quotes
 * already inside the value — so `-c model_reasoning_effort="high"` reaches the
 * callee as `model_reasoning_effort=high`. Pre-escaping to CRT rules makes the
 * value survive that pass. pwsh 7+ escapes correctly on its own and must not be
 * pre-escaped, except when the target is a `.cmd`/`.bat` shim, for which it
 * deliberately reverts to the 5.1 behaviour.
 */
function powerShellLegacyNativeValue(value: string): string {
  const escaped = value.replace(/(\\*)"/gu, "$1$1\\\"");
  return /\s/u.test(escaped) ? escaped.replace(/(\\*)$/u, "$1$1") : escaped;
}

function quotePowerShellArg(value: string, legacy: boolean): string {
  // PowerShell 5.1 drops a bare "" native argument; a literal '""' survives.
  if (!value.length) return legacy ? "'\"\"'" : "\"\"";
  const native = legacy ? powerShellLegacyNativeValue(value) : value;
  const escaped = native
    .replace(/`/gu, "``")
    .replace(/\$/gu, "`$")
    .replace(/"/gu, "`\"")
    .replace(/\r/gu, "`r")
    .replace(/\n/gu, "`n")
    .replace(/\t/gu, "`t");
  return `"${escaped}"`;
}

/**
 * A quoted path is a string expression in PowerShell, not an invocation, so
 * `'C:\…\opencode.exe' serve` is a parse error rather than a launch. Anything
 * that has to be quoted therefore needs the call operator.
 */
function needsPowerShellCallOperator(command: string): boolean {
  return !/^[A-Za-z0-9_.:@+=,\\/-]+$/u.test(command);
}

function commandArrayToPowerShellLine(command: readonly string[], shellPath: string | null | undefined): string {
  const [executable, ...rest] = command;
  if (executable == null) return "";
  const legacy = isWindowsPowerShellFive(shellPath) || /\.(?:cmd|bat)$/iu.test(executable);
  const head = needsPowerShellCallOperator(executable)
    ? `& ${quotePowerShellArg(executable, legacy)}`
    : executable;
  return [head, ...rest.map((arg) => quotePowerShellArg(arg, legacy))].join(" ");
}

/**
 * cmd.exe expands `%NAME%` before the callee sees argv and offers no escape for
 * `%` inside a quoted argument — `%%` and `%^` both survive literally there, so
 * neither can suppress the expansion. Newlines cannot be represented on a cmd
 * command line at all. cmd is ADE's last-resort shell, reached only when both
 * powershell.exe and pwsh.exe fail to spawn, and callers keep user prompts off
 * the command line for exactly this reason; what remains is quoted to CRT rules
 * so at least spaces, quotes and backslashes survive.
 */
function commandArrayToCmdLine(command: readonly string[]): string {
  return command.map((arg) => quoteWindowsArg(arg.replace(/[\r\n]/gu, " "))).join(" ");
}

/**
 * Render an argv array as a command line for one specific native Windows shell.
 * Use this at the point the line is written into a terminal, where the receiving
 * shell is known — never against a platform constant.
 */
export function commandArrayToWindowsShellLine(
  command: readonly string[],
  target: WindowsShellLineTarget,
): string {
  if (!command.length) return "";
  if (target.kind === "cmd") return commandArrayToCmdLine(command);
  if (target.kind === "git-bash") return commandArrayToLine([...command], { platform: "linux" });
  return commandArrayToPowerShellLine(command, target.shellPath);
}

/**
 * A startup command is ADE's canonical POSIX rendering of a launch: it is what
 * gets persisted, displayed, and — on macOS — handed to `/bin/bash -lc`, whose
 * quoting rules it matches. This recovers the argv behind such a line so a
 * caller can spawn it directly instead of typing it at a shell whose rules it
 * does not match.
 *
 * The line is only accepted when re-rendering the recovered argv reproduces it
 * byte for byte. That makes the recovery lossless by construction and rejects
 * anything that is not plain argv — pipelines, redirections, `&&` chains — as
 * well as any line a producer emitted under some other quoting ruleset, rather
 * than silently mis-splitting it.
 */
export type CanonicalCommandLineLaunch = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;

export function resolveCanonicalCommandLineLaunch(commandLine: string): CanonicalCommandLineLaunch | null {
  const trimmed = commandLine.trim();
  if (!trimmed) return null;

  let parsed: string[];
  try {
    parsed = parseCommandLine(trimmed, { platform: "linux" });
  } catch {
    return null;
  }

  // A POSIX line may open with `NAME=value` assignments that scope environment
  // to the command. Those are shell syntax, not argv, so lift them out.
  const env: Record<string, string> = {};
  let index = 0;
  while (index < parsed.length) {
    const match = ENV_ASSIGNMENT.exec(parsed[index]!);
    if (!match) break;
    env[match[1]!] = match[2]!;
    index += 1;
  }
  const argv = parsed.slice(index);
  const executable = argv[0];
  if (!executable) return null;

  const rendered = [
    ...Object.entries(env).map(([key, value]) => `${key}=${quoteShellArg(value, { platform: "linux" })}`),
    commandArrayToLine(argv, { platform: "linux" }),
  ].join(" ");
  if (rendered !== trimmed) return null;

  return {
    command: executable,
    args: argv.slice(1),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Parse a shell-like command line into an array of arguments. */
export function parseCommandLine(input: string, options: { platform?: ShellPlatform } = {}): string[] {
  if (isWindowsPlatform(options.platform)) return parseWindowsCommandLine(input);

  const out: string[] = [];
  let current = "";
  let currentStarted = false;
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += ch;
      currentStarted = true;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if (ch === "\\") {
        const next = input[i + 1];
        if (next == null) current += "\\";
        else {
          i += 1;
          current += next;
        }
        currentStarted = true;
      } else {
        current += ch;
        currentStarted = true;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      currentStarted = true;
      continue;
    }
    // ANSI-C quoting. quoteShellArg emits this for any argument containing a
    // control character, so a parser that cannot read it back cannot round-trip
    // the very arguments — multi-line prompts — that most need recovering.
    if (ch === "$" && input[i + 1] === "'") {
      const decoded = parseAnsiCQuoted(input, i + 2);
      current += decoded.value;
      currentStarted = true;
      i = decoded.end;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      currentStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (currentStarted) {
        out.push(current);
        current = "";
        currentStarted = false;
      }
      continue;
    }
    current += ch;
    currentStarted = true;
  }

  if (escaped) current += "\\";
  if (quote != null) throw new Error("Unclosed quote in command line");
  if (currentStarted) out.push(current);
  return out;
}

const ANSI_C_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  f: "\f",
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  "0": "\0",
};

/** Decode a `$'…'` body starting at `start`; returns the index of its closing quote. */
function parseAnsiCQuoted(input: string, start: number): { value: string; end: number } {
  let value = "";
  let index = start;
  while (index < input.length) {
    const ch = input[index]!;
    if (ch === "\\") {
      const next = input[index + 1];
      if (next == null) {
        value += "\\";
        index += 1;
        continue;
      }
      value += ANSI_C_ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    if (ch === "'") return { value, end: index };
    value += ch;
    index += 1;
  }
  throw new Error("Unclosed quote in command line");
}

function parseWindowsCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let currentStarted = false;
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (ch === "\\") {
      let end = i;
      while (input[end] === "\\") end += 1;
      const count = end - i;
      if (input[end] === "\"") {
        current += "\\".repeat(Math.floor(count / 2));
        currentStarted = true;
        if (count % 2 === 0) {
          if (inQuotes && input[end + 1] === "\"") {
            current += "\"";
            i = end + 1;
          } else {
            inQuotes = !inQuotes;
            i = end;
          }
        } else {
          current += "\"";
          i = end;
        }
      } else {
        current += "\\".repeat(count);
        currentStarted = true;
        i = end - 1;
      }
      continue;
    }

    if (ch === "\"") {
      if (inQuotes && input[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
        currentStarted = true;
      }
      continue;
    }

    if (!inQuotes && /\s/.test(ch)) {
      if (currentStarted) {
        out.push(current);
        current = "";
        currentStarted = false;
      }
      continue;
    }

    current += ch;
    currentStarted = true;
  }

  if (inQuotes) throw new Error("Unclosed quote in command line");
  if (currentStarted) out.push(current);
  return out;
}
