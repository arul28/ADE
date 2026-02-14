import type { CiScanDiff } from "../../../shared/types";

export function hasShellMetacharacters(cmd: string): boolean {
  // ADE runs commands via spawn(shell=false). Shell pipelines won't behave as users expect.
  return /(\|\||&&|[|><;`])/.test(cmd);
}

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
  return out;
}

export function chooseSuggestedCommand(args: {
  commands: string[];
  warnings: string[];
}): { suggestedCommandLine: string | null; suggestedCommand: string[] | null } {
  const interesting = (cmd: string) =>
    /(npm|pnpm|yarn)\s+(test|run\s+test|lint|run\s+lint|typecheck|run\s+typecheck|build|run\s+build)\b|go\s+test\b|cargo\s+test\b|pytest\b|make\s+test\b/i.test(
      cmd
    );

  const candidates = args.commands
    .map((cmd) => cmd.trim())
    .filter(Boolean)
    .filter((cmd) => !hasShellMetacharacters(cmd));

  const pick = (cmd: string): { line: string; argv: string[] } | null => {
    try {
      const argv = parseCommandLine(cmd);
      if (!argv.length) return null;
      return { line: cmd, argv };
    } catch (err) {
      args.warnings.push(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  for (const cmd of candidates) {
    if (!interesting(cmd)) continue;
    const parsed = pick(cmd);
    if (parsed) return { suggestedCommandLine: parsed.line, suggestedCommand: parsed.argv };
  }

  for (const cmd of candidates) {
    const parsed = pick(cmd);
    if (parsed) return { suggestedCommandLine: parsed.line, suggestedCommand: parsed.argv };
  }

  return { suggestedCommandLine: null, suggestedCommand: null };
}

export function computeCiScanDiff(prev: Record<string, string>, next: Record<string, string>): CiScanDiff {
  const prevIds = new Set(Object.keys(prev));
  const currIds = new Set(Object.keys(next));

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const id of currIds) {
    if (!prevIds.has(id)) {
      added += 1;
      continue;
    }
    if (prev[id] !== next[id]) changed += 1;
    else unchanged += 1;
  }
  for (const id of prevIds) {
    if (!currIds.has(id)) removed += 1;
  }
  return { added, removed, changed, unchanged };
}

