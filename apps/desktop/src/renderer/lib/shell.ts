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

function quoteWindowsArg(arg: string): string {
  if (!arg.length) return '""';
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
  if (!arg.length) return '""';
  if (isWindowsPlatform(options.platform)) {
    return quoteWindowsArg(arg);
  }
  if (/^[a-zA-Z0-9_.:@%+=,-]+$/.test(arg)) return arg;
  // If the argument contains line terminators or other ANSI control bytes,
  // use ANSI-C quoting (`$'...'`). Plain double-quoting preserves them
  // literally to the receiving program, but when the resulting line is
  // injected into an interactive PTY shell via `pty.write` the terminal's
  // line discipline fires on every embedded \n, producing PS2 continuation
  // noise mid-command. ANSI-C quoting keeps the line single-line on the wire
  // and lets the shell expand the escapes back into the original bytes.
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
  return out;
}

function parseWindowsCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (ch === "\\") {
      let end = i;
      while (input[end] === "\\") end += 1;
      const count = end - i;
      if (input[end] === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 0) {
          if (inQuotes && input[end + 1] === '"') {
            current += '"';
            i = end + 1;
          } else {
            inQuotes = !inQuotes;
            i = end;
          }
        } else {
          current += '"';
          i = end;
        }
      } else {
        current += "\\".repeat(count);
        i = end - 1;
      }
      continue;
    }

    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
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
  return out;
}
