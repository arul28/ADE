/** Shared shell-quoting and command-line parsing utilities. */

/** Quote a single shell argument, adding double quotes if needed. */
export function quoteShellArg(arg: string): string {
  if (!arg.length) return '""';
  if (/^[a-zA-Z0-9_.:@%+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Join an array of command args into a shell-safe command line. */
export function commandArrayToLine(command: string[]): string {
  if (!command.length) return "";
  return command.map(quoteShellArg).join(" ");
}

/** Parse a shell-like command line into an array of arguments. */
export function parseCommandLine(input: string): string[] {
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
