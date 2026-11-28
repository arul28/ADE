/**
 * Whether a shell command only reads.
 *
 * Plan mode and side chats are read-only, and both still need the agent to
 * look things up from a shell: `git log`, `rg`, and above all ADE's own
 * reads, such as `ade linear issue ADE-296 --text` for the issue the chat
 * was started on. A command passes only when every part of it is a reader
 * from the lists below, so a wrong answer can only refuse a read, never let a
 * write through.
 *
 * What passes: one or more commands joined by `|`, `&&`, `||`, `;` or a
 * newline, each a known reader with no option that writes or runs something,
 * plus `cd`. Output may go to the null device (`2>&1`, `2>/dev/null`,
 * `>$null`). What never passes: command substitution, backticks,
 * subshells and groups, background jobs, here-docs, input redirection, a
 * redirection to a file, an environment assignment in front of a command,
 * and, for PowerShell, script blocks and `(...)` expressions.
 */

export type ReadOnlyShellDialect = "bash" | "powershell";

/**
 * Narrows a check to commands whose every program is in `programs` (and still
 * reads). Codex uses it to leave its sandbox only for the programs that need
 * to (`ade`, `gh`), never for a read the sandbox itself refused.
 */
export type ReadOnlyShellOptions = { programs?: ReadonlySet<string> };

/** Programs that only read (their writing options are refused separately). */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "which", "where",
  "stat", "tree", "du", "df", "find", "sort", "uniq", "cut", "jq", "date", "basename",
  "dirname", "realpath", "nl", "cd", "true", "whoami", "uname",
]);

/** PowerShell readers and their read-only aliases, lowercased. */
const POWERSHELL_READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "get-content", "gc", "type", "get-childitem", "gci", "dir", "select-string", "sls",
  "get-location", "gl", "set-location", "sl", "chdir", "test-path", "get-item", "gi",
  "resolve-path", "rvpa", "get-command", "gcm", "measure-object", "measure", "select-object", "select",
  "sort-object", "format-table", "ft", "format-list", "fl", "write-output", "write-host",
  "out-string", "get-date",
]);

/** Git subcommands that only read. */
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep",
  "merge-base", "cat-file", "ls-tree", "rev-list", "whatchanged",
]);
/** Git subcommands that read when given only these options (or none). */
const GIT_READ_ONLY_WITH_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  branch: new Set(["--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color"]),
  remote: new Set(["-v", "--verbose"]),
  worktree: new Set(["list", "--porcelain", "-v"]),
  stash: new Set(["list", "show", "-p", "--stat"]),
  reflog: new Set(["show", "-n", "--oneline"]),
  tag: new Set(["--list", "-l", "-n"]),
};
/**
 * Git subcommands whose bare form writes: `git stash` is `git stash push`.
 * They read only with one of these as their first word.
 */
const GIT_READ_ONLY_FIRST_WORD: Readonly<Record<string, ReadonlySet<string>>> = {
  stash: new Set(["list", "show"]),
  worktree: new Set(["list"]),
};
/** Git options that run another program or change config for the call. */
const GIT_RUNNING_OPTIONS = /^(-c|--ext-diff|-O|--open-files-in-pager|--exec|--upload-pack|--receive-pack|--config-env)/;

/** `gh` reads: `<group> <verb>`. `gh api` is a read only without a body or method. */
const READ_ONLY_GH: ReadonlySet<string> = new Set([
  "issue view", "issue list", "issue status", "pr view", "pr list", "pr checks", "pr diff", "pr status",
  "repo view", "run view", "run list", "auth status", "release list", "release view", "search issues",
  "search prs", "search repos", "search code",
]);
const GH_API_WRITING_OPTIONS = /^(-X|--method|-f|-F|--field|--raw-field|--input)/;

/**
 * ADE CLI reads: `<group> <verb>` (`<group> <sub> <verb>` for `github`).
 * Every `--help` is a read too. Anything not listed (comment, set-state, create,
 * send, run, ...) is refused.
 */
const READ_ONLY_ADE: ReadonlySet<string> = new Set([
  "linear issue", "linear issues", "linear issue-comments", "linear picker-data", "linear inbox",
  "issue list", "issue view",
  "github issue list", "github issue view",
  "jira status", "jira projects", "jira list", "jira issue",
  "prs list", "prs show", "prs checks", "prs view", "prs comments", "prs status",
  "lanes list", "lanes show",
  "git status", "git log", "git diff",
  "diff changes", "diff file", "diff patch",
  "files tree", "files read", "files search",
  "history list", "history show", "history commits",
  "chat list", "chat show", "chat read", "chat transcript",
  "session show",
  "operations status",
  "skill list", "skill show",
  "machines list", "machines show",
  "projects list",
  "usage limits", "usage snapshot", "usage stats",
  "models catalog", "models sheet",
  "settings find",
  "integrations status",
  "mcp servers", "mcp status",
  "archive list", "archive summary",
  "automations list", "automations runs",
  "tests list", "tests runs", "tests logs",
  "proof status", "proof list",
  "work-tools state",
  "terminal list", "terminal read",
  "actions list", "actions describe", "actions status",
  "sync status",
  "brain status",
  "auth status",
  "passwords list", "passwords status",
  "secrets list",
]);
/** ADE commands that read whatever follows them (`ade search "x"`, `ade help linear`). */
const ADE_READ_ANY_ARGS: ReadonlySet<string> = new Set(["help", "search"]);
/** ADE commands that read only on their own (`ade devices`, not `ade devices use ...`). */
const ADE_READ_BARE: ReadonlySet<string> = new Set(["status", "doctor", "health", "devices"]);
/** Groups that take a second word (`github issue`) before the verb. */
const ADE_NESTED_GROUPS: ReadonlySet<string> = new Set(["github"]);
/** ADE global options that take a value, skipped before the group. */
const ADE_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--project-root", "--workspace-root", "--socket"]);

/**
 * Options that turn a reader into a writer or a runner: `git diff --output`,
 * `sort -o`, `tree -o`, `rg --pre`. `-o` is refused for every program (grep's
 * harmless `-o` included); a narrow list errs toward refusing.
 */
const WRITING_OPTIONS = /^(--ou|--pre|-o)/;
/**
 * `sort` clusters short options (`-uo out`) and takes any unambiguous prefix
 * of a long one (`--outp=out`, `--com=./x`).
 */
const SORT_WRITING_OPTIONS = /^(-[A-Za-z]*o|--o|--co)/;
/** `find` options that write, delete or run something. */
const FIND_WRITING_OPTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
/** Null-device targets a redirection may name. */
const NULL_TARGETS: Readonly<Record<ReadOnlyShellDialect, ReadonlySet<string>>> = {
  bash: new Set(["/dev/null"]),
  // `NUL` is a file name on a POSIX host; only Windows makes it the null device.
  powershell: new Set(["$null", "nul", "NUL"]),
};
/** Options that make a reader run another program: GNU `sort --compress-program=./x`. */
const PROGRAM_RUNNING_OPTIONS = /^--compress-program/;
/** Trusted directories a shell wrapper's absolute path may name (`/bin/zsh -lc ...`). */
const TRUSTED_SHELL_DIRS = /^(\/(usr\/)?(local\/)?bin\/|\/opt\/homebrew\/bin\/|[a-z]:[\\/](windows|program files[\\/]powershell)[\\/])/i;

/**
 * One word of a command. `unsafe` marks a word the shell would rewrite before
 * the program sees it, so its text cannot be judged: a `$` expansion outside
 * single quotes, or a glob (`*`, `?`, `[`). A glob could expand to a file named
 * `-delete`, or to `.ade/secrets/...` past a guard that reads the literal
 * path. Bash expands only unquoted globs; PowerShell readers expand wildcards
 * in quoted paths too, so there every glob character counts.
 */
type Word = { text: string; unsafe: boolean };
type Segment = Word[];

/**
 * Splits a command into its commands' words, honoring quotes. Returns null
 * for any construct this check refuses outright.
 */
function splitCommand(command: string, dialect: ReadOnlyShellDialect): Segment[] | null {
  // Substitution and backticks are refused anywhere, quoted or not: the
  // check never tries to judge what a nested command would do.
  if (/`|\$\(|\$\{[^}]*[=:]/.test(command)) return null;
  // `$'-delete'` and `$"..."` are quoting forms this check does not parse.
  if (/\$['"]/.test(command)) return null;
  if (dialect === "powershell" && /@\(|@\{/.test(command)) return null;

  const segments: Segment[] = [];
  let words: Word[] = [];
  let word = "";
  let wordStarted = false;
  let wordUnsafe = false;
  let quote: "'" | '"' | null = null;
  // A redirection's target is the next word; it must name the null device.
  let pendingRedirect = false;

  const endWord = (): boolean => {
    if (!wordStarted) return true;
    if (pendingRedirect) {
      if (!NULL_TARGETS[dialect].has(word)) return false;
      pendingRedirect = false;
    } else {
      words.push({ text: word, unsafe: wordUnsafe });
    }
    word = "";
    wordStarted = false;
    wordUnsafe = false;
    return true;
  };
  const endSegment = (): boolean => {
    if (!endWord() || pendingRedirect) return false;
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      // Inside bash double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline.
      else if (char === "\\" && quote === '"' && dialect === "bash" && /[$`"\\\n]/.test(command[i + 1] ?? "")) word += command[++i];
      else {
        if (char === "$" && quote === '"') wordUnsafe = true;
        if (dialect === "powershell" && (char === "*" || char === "?" || char === "[")) wordUnsafe = true;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === "\\" && dialect === "bash") {
      if (i + 1 >= command.length) return null;
      const next = command[++i]!;
      if (next === "\n") continue;
      word += next;
      wordStarted = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (!endWord()) return null;
      continue;
    }
    if (char === "\n" || char === "\r" || char === ";") {
      if (char === "\r" && command[i + 1] === "\n") i += 1;
      if (words.length === 0 && !wordStarted) continue;
      if (!endSegment()) return null;
      continue;
    }
    if (char === "|") {
      if (command[i + 1] === "|") i += 1;
      if (!endSegment()) return null;
      continue;
    }
    if (char === "&") {
      if (command[i + 1] === "&") {
        i += 1;
        if (!endSegment()) return null;
        continue;
      }
      // PowerShell's call operator, `& "$env:ADE_CLI_PATH" linear issue`.
      if (dialect === "powershell" && words.length === 0 && !wordStarted) continue;
      return null; // a background job
    }
    if (char === ">") {
      // `>`, `>>`, `2>`, `2>&1`, `*>`: the word so far may be a fd number.
      if (wordStarted && !/^[0-9*]$/.test(word)) return null;
      word = "";
      wordStarted = false;
      wordUnsafe = false;
      if (command[i + 1] === ">") i += 1;
      if (command[i + 1] === "&") {
        const fd = command[i + 2];
        if (fd !== "1" && fd !== "2") return null;
        i += 2;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (char === "<" || char === "(" || char === ")" || char === "{" || char === "}") return null;
    // `#` starting a word opens a comment, and a quote inside it would hide
    // the lines after it from this parser while the shell runs them.
    if (char === "#" && !wordStarted) return null;
    if (char === "$") wordUnsafe = true;
    if (char === "*" || char === "?" || char === "[") wordUnsafe = true;
    word += char;
    wordStarted = true;
  }
  if (quote) return null;
  if (words.length === 0 && !wordStarted && !pendingRedirect) {
    return segments.length > 0 ? segments : null;
  }
  if (!endSegment()) return null;
  return segments;
}

/**
 * The program a command's first word names, or null when this check cannot
 * trust it. A bare name (`ls`, `ade.cmd`) and ADE's own CLI variables
 * (`$ADE_CLI_PATH`) are trusted; any other path is not, since `./scripts/ls`
 * can do anything. `trustedDirs` admits absolute paths under those
 * directories (a provider's `/bin/zsh -lc` wrapper).
 */
function programName(word: Word | undefined, trustedDirs?: RegExp): string | null {
  if (!word) return null;
  const raw = word.text;
  if (/^\$(\{)?(env:)?ADE_CLI_PATH(\})?$/i.test(raw)) return "ade";
  if (/^\$(\{)?(env:)?ADE_CLI_BIN_DIR(\})?[\\/]ade(\.cmd|\.exe|\.ps1)?$/i.test(raw)) return "ade";
  if (word.unsafe) return null;
  if (/[\\/]/.test(raw) && !(trustedDirs && trustedDirs.test(raw))) return null;
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function adeCommandIsReadOnly(args: string[]): boolean {
  if (args.includes("--help")) return true;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (ADE_GLOBAL_VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      // An unknown option before the group may take a value that would be
      // read as the group, so refuse rather than guess.
      if (positionals.length === 0 && !arg.includes("=") && arg !== "--text" && arg !== "--json") return false;
      // Nor between the group and its verb: `ade linear --team issue create`
      // runs `create`, though its words read `linear issue`.
      const group = positionals[0];
      if (group && !ADE_READ_ANY_ARGS.has(group) && !ADE_READ_BARE.has(group)
        && positionals.length < (ADE_NESTED_GROUPS.has(group) ? 3 : 2)) return false;
      continue;
    }
    positionals.push(arg);
    if (positionals.length >= 3) break;
  }
  const [group, second, third] = positionals;
  if (!group) return false;
  if (ADE_READ_ANY_ARGS.has(group)) return true;
  if (ADE_READ_BARE.has(group)) return !second;
  if (ADE_NESTED_GROUPS.has(group)) return Boolean(second && third && READ_ONLY_ADE.has(`${group} ${second} ${third}`));
  return Boolean(second && READ_ONLY_ADE.has(`${group} ${second}`));
}

function gitCommandIsReadOnly(args: string[]): boolean {
  let rest = args;
  while (rest.length > 0) {
    const head = rest[0]!;
    if (head === "--no-pager" || head === "--no-optional-locks" || head === "-P") rest = rest.slice(1);
    else if (head === "-C") rest = rest.slice(2);
    else break;
  }
  if (rest.some((word) => GIT_RUNNING_OPTIONS.test(word))) return false;
  const sub = rest[0] ?? "";
  if (READ_ONLY_GIT.has(sub)) return true;
  const firstWords = GIT_READ_ONLY_FIRST_WORD[sub];
  if (firstWords && !firstWords.has(rest[1] ?? "")) return false;
  const allowed = GIT_READ_ONLY_WITH_OPTIONS[sub];
  if (!allowed) return false;
  return rest.slice(1).every((word) => allowed.has(word));
}

function ghCommandIsReadOnly(args: string[]): boolean {
  const [group, verb] = args;
  if (group === "api") {
    return !args.slice(1).some((word) => GH_API_WRITING_OPTIONS.test(word));
  }
  return Boolean(group && verb && READ_ONLY_GH.has(`${group} ${verb}`));
}

function segmentIsReadOnly(words: Segment, dialect: ReadOnlyShellDialect, options: ReadOnlyShellOptions): boolean {
  const program = programName(words[0]);
  if (!program) return false;
  if (options.programs && !options.programs.has(program)) return false;
  // An argument the shell would rewrite cannot be judged from its text.
  if (words.slice(1).some((word) => word.unsafe)) return false;
  const args = words.slice(1).map((word) => word.text);
  if (args.some((word) => PROGRAM_RUNNING_OPTIONS.test(word))) return false;
  if (program === "ade") return !args.some((word) => WRITING_OPTIONS.test(word)) && adeCommandIsReadOnly(args);
  if (args.some((word) => WRITING_OPTIONS.test(word))) return false;
  if (program === "git") return gitCommandIsReadOnly(args);
  if (program === "gh") return ghCommandIsReadOnly(args);
  if (program === "find") return !args.some((word) => FIND_WRITING_OPTIONS.test(word));
  if (program === "date") return !args.some((word) => /^(-s|--set)/.test(word));
  // `uniq in out` writes `out`.
  if (program === "uniq") return args.filter((word) => !word.startsWith("-")).length <= 1;
  if (program === "sort") return !args.some((word) => SORT_WRITING_OPTIONS.test(word));
  if (READ_ONLY_PROGRAMS.has(program)) return true;
  return dialect === "powershell" && POWERSHELL_READ_ONLY_PROGRAMS.has(program);
}

export function shellCommandIsReadOnly(
  command: unknown,
  dialect: ReadOnlyShellDialect = "bash",
  options: ReadOnlyShellOptions = {},
): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const segments = splitCommand(command, dialect);
  if (!segments || segments.length === 0) return false;
  return segments.every((words) => segmentIsReadOnly(words, dialect, options));
}

/**
 * The same check when the shell that will run the command is not known (a
 * Cursor or OpenCode shell tool). On Windows it may be PowerShell or a POSIX
 * shell, and the two split a command differently (`a\;b` is one word to bash
 * and two commands to PowerShell), so the command must read under both.
 */
export function shellCommandIsReadOnlyOnPlatform(
  command: unknown,
  platform: NodeJS.Platform = process.platform,
  options: ReadOnlyShellOptions = {},
): boolean {
  if (!shellCommandIsReadOnly(command, "bash", options)) return false;
  return platform !== "win32" || shellCommandIsReadOnly(command, "powershell", options);
}

const POSIX_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);
const POWERSHELLS: ReadonlySet<string> = new Set(["powershell", "pwsh"]);

/** `-c`, `-lc`, `-l -c`: flags only, one of them `c`. */
function posixShellRunsScript(options: string[]): boolean {
  return options.every((option) => /^-[a-z]+$/.test(option)) && options.some((option) => option.includes("c"));
}

/** `-NoProfile -ExecutionPolicy Bypass -Command`: known switches, ending in `-Command`. */
function powerShellRunsScript(options: string[]): boolean {
  const last = options[options.length - 1] ?? "";
  if (!/^-(command|c)$/i.test(last)) return false;
  for (let i = 0; i < options.length - 1; i += 1) {
    const option = options[i]!;
    if (/^-(noprofile|nop|nologo|noninteractive|noni)$/i.test(option)) continue;
    if (/^-(executionpolicy|ep)$/i.test(option) && /^(bypass|remotesigned|unrestricted)$/i.test(options[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * The same check for a command line that may be a shell invocation, as a
 * provider reports it in an approval (`bash -lc "git log"`,
 * `powershell.exe -NoProfile -Command "ade linear issue ADE-296"`). The inner
 * script is judged in the dialect of the shell that runs it; a command line
 * that is not a shell invocation is judged as `shellCommandIsReadOnlyOnPlatform`.
 */
export function shellInvocationIsReadOnly(
  command: unknown,
  platform: NodeJS.Platform = process.platform,
  options: ReadOnlyShellOptions = {},
): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const segments = splitCommand(command, "bash");
  const words = segments?.length === 1 ? segments[0]! : null;
  const shell = words ? programName(words[0], TRUSTED_SHELL_DIRS) ?? "" : "";
  if (words && (POSIX_SHELLS.has(shell) || POWERSHELLS.has(shell))) {
    if (words.slice(1).some((word) => word.unsafe)) return false;
    const flags = words.slice(1, -1).map((word) => word.text);
    const script = words[words.length - 1]?.text;
    if (!script || flags.length === 0) return false;
    if (!(POSIX_SHELLS.has(shell) ? posixShellRunsScript(flags) : powerShellRunsScript(flags))) return false;
    return shellCommandIsReadOnly(script, POSIX_SHELLS.has(shell) ? "bash" : "powershell", options);
  }
  return shellCommandIsReadOnlyOnPlatform(command, platform, options);
}
