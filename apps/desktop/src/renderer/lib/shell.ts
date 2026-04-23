/** Shared shell-quoting and command-line parsing utilities. */

type ShellPlatform = NodeJS.Platform | "browser";

function currentShellPlatform(): ShellPlatform {
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) return "win32";
  if (typeof process !== "undefined" && typeof process.platform === "string") return process.platform;
  return "browser";
}

function isWindowsPlatform(platform: ShellPlatform = currentShellPlatform()): boolean {
  return platform === "win32";
}

/** Quote a single shell argument, adding double quotes if needed. */
export function quoteShellArg(arg: string, options: { platform?: ShellPlatform } = {}): string {
  if (!arg.length) return '""';
  if (isWindowsPlatform(options.platform)) {
    if (/^[a-zA-Z0-9_.:@%+=,\\/-]+$/.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\\\"")}"`;
  }
  if (/^[a-zA-Z0-9_.:@%+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Join an array of command args into a shell-safe command line. */
export function commandArrayToLine(command: string[], options: { platform?: ShellPlatform } = {}): string {
  if (!command.length) return "";
  return command.map((arg) => quoteShellArg(arg, options)).join(" ");
}

/** Parse a shell-like command line into an array of arguments. */
export function parseCommandLine(input: string, options: { platform?: ShellPlatform } = {}): string[] {
  if (isWindowsPlatform(options.platform)) return parseWindowsCommandLine(input);

  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        const next = input[i + 1];
        if (next == null) current += "\\";
        else {
          i += 1;
          current += next;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped) current += "\\";
  if (quote != null) throw new Error("Unclosed quote in command line");
  if (current.length) out.push(current);
  if (!out.length) throw new Error("Command line must not be empty");
  return out;
}

function parseWindowsCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "\\" && input[i + 1] === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (!inQuotes && /\s/.test(ch)) {
      if (current.length) {
        out.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (inQuotes) throw new Error("Unclosed quote in command line");
  if (current.length) out.push(current);
  if (!out.length) throw new Error("Command line must not be empty");
  return out;
}
