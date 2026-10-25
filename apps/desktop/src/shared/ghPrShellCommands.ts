/**
 * Reads what a chat's own shell command did to a pull request: `gh pr create`
 * (the PR URL it printed) and `gh pr merge` (the PR it named). ADE links the
 * PR to the chat that ran the command, so an agent that skips `ade prs create`
 * still gets its PR on the chat and its chat settled when the PR merges.
 *
 * Pure and conservative. Wrong links are worse than missed ones, so anything
 * ambiguous reads as nothing: a `gh pr create` inside a quoted string, a
 * heredoc body or a comment is not a command; a URL the command names itself
 * (`gh pr view 120 && gh pr create`) is not the new PR; more PR URLs on their
 * own line than create commands (`gh pr create && gh pr list`) is no answer
 * at all. The caller still checks every PR with GitHub against the chat's
 * lane before linking it.
 */

export type GhPrShellAction = {
  kind: "create" | "merge";
  /** From the URL or `--repo`; null when only a number is known. */
  owner: string | null;
  repo: string | null;
  number: number;
};

/** Cheap pre-check so the parser only runs on commands that can matter. */
export function mightTouchGhPr(command: string): boolean {
  return /\bgh(?:\.exe)?\b/i.test(command) && /\bpr\b/.test(command);
}

type Token = { kind: "word"; value: string } | { kind: "sep" };

/**
 * Split a POSIX-ish shell line into words and command separators. Quotes are
 * honoured (a quoted string is one word, never a command position), `#` at a
 * word start runs to the end of the line, and heredoc bodies are skipped.
 * PowerShell and cmd lines tokenize close enough for the `gh pr ...` shape.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: string[] = [];
  let word = "";
  let inWord = false;
  const pushWord = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };
  const pushSep = () => {
    pushWord();
    if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== "sep") tokens.push({ kind: "sep" });
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\n") {
      pushSep();
      i += 1;
      // Skip each pending heredoc body, line by line, through its delimiter.
      while (heredocs.length > 0 && i <= input.length) {
        const delimiter = heredocs[0]!;
        const end = input.indexOf("\n", i);
        const line = input.slice(i, end < 0 ? input.length : end);
        i = end < 0 ? input.length : end + 1;
        if (line.replace(/^\t+/, "").trimEnd() === delimiter) heredocs.shift();
        if (end < 0) break;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      // A line continuation joins lines. A backslash before a letter or digit
      // is a Windows path (`C:\tools\gh.exe`), not an escape.
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += /[A-Za-z0-9]/.test(input[i + 1]!) ? `\\${input[i + 1]}` : input[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      word += input.slice(i + 1, end < 0 ? input.length : end);
      inWord = true;
      i = end < 0 ? input.length : end + 1;
      continue;
    }
    if (ch === "\"") {
      let j = i + 1;
      while (j < input.length && input[j] !== "\"") {
        // Inside double quotes a backslash escapes only these (POSIX).
        if (input[j] === "\\" && j + 1 < input.length && "$`\"\\\n".includes(input[j + 1]!)) {
          word += input[j + 1];
          j += 2;
          continue;
        }
        word += input[j];
        j += 1;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "#" && !inWord) {
      const end = input.indexOf("\n", i);
      i = end < 0 ? input.length : end;
      continue;
    }
    if (ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      pushWord();
      let j = i + 2;
      if (input[j] === "-") j += 1;
      while (input[j] === " " || input[j] === "\t") j += 1;
      const match = /^(['"]?)([A-Za-z_][\w-]*)\1/.exec(input.slice(j));
      if (match) {
        heredocs.push(match[2]!);
        i = j + match[0].length;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "`" || ch === "{" || ch === "}") {
      pushSep();
      i += 1;
      continue;
    }
    if (ch === "$" && input[i + 1] === "(") {
      pushSep();
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i += 1;
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  pushWord();
  return tokens;
}

/** `bash -lc '…'`, `/bin/zsh -c "…"`: the shell a harness wraps a command in. */
function unwrapShell(command: string): string {
  let current = command;
  for (let depth = 0; depth < 3; depth += 1) {
    const words = tokenize(current);
    if (words.length !== 3 || words.some((token) => token.kind !== "word")) return current;
    const [shell, flag, body] = words as Array<{ kind: "word"; value: string }>;
    const name = shell!.value.split(/[\\/]/).pop()!.toLowerCase();
    if (!/^(?:ba|z|da|k)?sh(?:\.exe)?$/.test(name) || !/^-[a-z]*c[a-z]*$/.test(flag!.value)) return current;
    current = body!.value;
  }
  return current;
}

/** Simple commands: runs of words between separators. */
function simpleCommands(tokens: Token[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.kind === "sep") {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(token.value);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

const COMMAND_PREFIXES = new Set(["command", "exec", "env", "time", "nohup", "noglob", "builtin"]);
const GH_FLAGS_WITH_VALUE = new Set(["-R", "--repo", "--hostname"]);
/** `gh pr merge` flags that take a value, so the value is not read as the PR. */
const MERGE_FLAGS_WITH_VALUE = new Set([
  "-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "-A", "--author-email", "-R", "--repo",
]);

type GhPrInvocation = { verb: string; args: string[]; repoFlag: string | null };

function readGhPrInvocation(words: string[]): GhPrInvocation | null {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || COMMAND_PREFIXES.has(word)) {
      index += 1;
      continue;
    }
    break;
  }
  const program = (words[index] ?? "").split(/[\\/]/).pop()!.toLowerCase();
  if (program !== "gh" && program !== "gh.exe") return null;
  index += 1;
  let repoFlag: string | null = null;
  // Global flags may come before `pr`: `gh -R owner/repo pr create`.
  while (index < words.length && words[index]!.startsWith("-")) {
    const flag = words[index]!;
    const [name, inline] = flag.split("=", 2);
    if (GH_FLAGS_WITH_VALUE.has(name!)) {
      const value = inline ?? words[index + 1] ?? null;
      if (name === "-R" || name === "--repo") repoFlag = value;
      index += inline === undefined ? 2 : 1;
    } else {
      index += 1;
    }
  }
  if (words[index] !== "pr") return null;
  const verb = words[index + 1];
  if (!verb) return null;
  const args = words.slice(index + 2);
  for (let i = 0; i < args.length; i += 1) {
    const [name, inline] = args[i]!.split("=", 2);
    if ((name === "-R" || name === "--repo") && (inline ?? args[i + 1])) repoFlag = inline ?? args[i + 1]!;
  }
  return { verb, args, repoFlag };
}

const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/;

function parsePrRef(value: string): { owner: string | null; repo: string | null; number: number } | null {
  const url = PR_URL_RE.exec(value.trim());
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };
  const bare = /^#?(\d{1,9})$/.exec(value.trim());
  if (bare) return { owner: null, repo: null, number: Number(bare[1]) };
  return null;
}

function splitRepoFlag(value: string | null): { owner: string | null; repo: string | null } {
  const match = value ? /^(?:https:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(value.trim()) : null;
  return match ? { owner: match[1]!, repo: match[2]! } : { owner: null, repo: null };
}

/**
 * What the command did to pull requests. `exitCode` is the command's when the
 * harness reports one; a merge only counts when it did not fail.
 */
export function readGhPrShellActions(args: {
  command: string;
  output: string;
  exitCode?: number | null;
}): GhPrShellAction[] {
  if (!mightTouchGhPr(args.command)) return [];
  const commands = simpleCommands(tokenize(unwrapShell(args.command)));
  const invocations = commands.map(readGhPrInvocation).filter((entry): entry is GhPrInvocation => entry !== null);
  if (invocations.length === 0) return [];

  const creates = invocations.filter((entry) => entry.verb === "create" || entry.verb === "new");
  // Every PR the command names itself, by number or URL, in any `gh pr` call.
  const named = new Set<number>();
  for (const entry of invocations) {
    for (const arg of entry.args) {
      const ref = parsePrRef(arg);
      if (ref) named.add(ref.number);
    }
  }

  const actions: GhPrShellAction[] = [];
  if (creates.length > 0) {
    // `gh pr create` prints the new PR's URL on a line of its own.
    const urls = args.output
      .split(/\r?\n/)
      .map((line) => PR_URL_RE.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ owner: match[1]!, repo: match[2]!, number: Number(match[3]) }));
    const unique = [...new Map(urls.map((url) => [`${url.owner}/${url.repo}#${url.number}`.toLowerCase(), url])).values()];
    const fresh = unique.filter((url) => !named.has(url.number));
    if (fresh.length > 0 && unique.length <= creates.length) {
      for (const url of fresh) actions.push({ kind: "create", ...url });
    }
  }

  if (args.exitCode == null || args.exitCode === 0) {
    for (const entry of invocations) {
      if (entry.verb !== "merge") continue;
      let target: { owner: string | null; repo: string | null; number: number } | null = null;
      for (let i = 0; i < entry.args.length; i += 1) {
        const arg = entry.args[i]!;
        if (arg.startsWith("-")) {
          if (MERGE_FLAGS_WITH_VALUE.has(arg)) i += 1;
          continue;
        }
        target = parsePrRef(arg);
        // A branch name is not something this reader resolves.
        break;
      }
      if (!target) {
        // No argument merges the current branch's PR; gh names it in its output.
        const said = /pull request (?:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+))?#(\d{1,9})/i.exec(args.output);
        if (said) target = { owner: said[1] ?? null, repo: said[2] ?? null, number: Number(said[3]) };
      }
      if (!target) continue;
      if (!target.owner) Object.assign(target, splitRepoFlag(entry.repoFlag));
      actions.push({ kind: "merge", ...target });
    }
  }
  return actions;
}

/** A harness's tool result as text: a string, text blocks, or a stdout/output object. */
export function shellToolResultText(result: unknown, depth = 0): string {
  if (result == null || depth > 3) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((entry) => shellToolResultText(entry, depth + 1)).filter(Boolean).join("\n");
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const parts = ["stdout", "output", "text", "content", "aggregated_output", "formatted_output"]
      .map((key) => shellToolResultText(record[key], depth + 1))
      .filter(Boolean);
    return parts.join("\n");
  }
  return "";
}

/** The shell command a tool call runs, when it is one. */
export function shellToolCallCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const value = record.command ?? record.cmd ?? record.script;
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length > 0) {
    return (value as string[]).map((part) => (/[\s'"]/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part)).join(" ");
  }
  return null;
}
