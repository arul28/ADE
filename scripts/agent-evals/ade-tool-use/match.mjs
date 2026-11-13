// Command-text matching shared by the scorer (transcript checks), the arm C
// redirect hook and the OpenCode plugin. Text only: it reads what the agent
// wrote, so it also sees calls that never reached a stand-in (a login shell
// that rebuilt PATH, an absolute path, a command the guard refused).

// A command position: line start, after a separator or an opening quote or
// paren, after a prefix command (`env`, `sudo`, `xargs`, …), or inside
// `sh -c '…'`, or as an alias value. An optional path prefix covers
// `/usr/sbin/screencapture`. Obfuscated names (`${s}capture`, base64 piped
// to sh) are out of reach of any text match; guard.sb stops those.
export const CMD_POS = String.raw`(?:^|[;&|({\x60\n]|\$\(|\b(?:env|exec|command|sudo|xargs|nohup|time|then|do)\s+(?:-\S+\s+|\w+=\S*\s+)*|\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*|\balias\s+[\w.-]+=|['"])\s*(?:[\w.~-]*/)*`;

// Text before a quote that makes the shell run the quoted text.
const RUNS_QUOTED = /(?:(?:^|[\s;&|(])(?:[\w.~-]*\/)*(?:(?:ba|z|da|k)?sh|eval)\s+(?:-\w+\s+)*|\balias\s+[\w.-]+=)$/;
// A double-quoted string that expands to a command or runs one.
const EXPANDS = /\$[({A-Za-z_]|\x60/;

/**
 * The parts of a command that the shell runs: quoted text and heredoc bodies
 * become empty, so `grep 'screencapture' log` or a PR body that names `gh`
 * is not a call. Kept: the argument of `sh -c` / `eval` / an alias value,
 * double quotes that expand (`"$ADE_CLI_PATH"`, `"$(…)"`), and a heredoc
 * that feeds a shell.
 */
export function executableText(command) {
  const text = command.replace(/(\b(?:(?:ba|z|da|k)?sh)\s*)?<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3(?=\n|$)/g,
    (whole, shell, _q, tag, body) => (shell ? whole : whole.replace(body, "")));
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { out += text.slice(i, i + 2); i++; continue; }
    if (ch !== "'" && ch !== '"') { out += ch; continue; }
    let end = i + 1;
    while (end < text.length && text[end] !== ch) end += ch === '"' && text[end] === "\\" ? 2 : 1;
    const inner = text.slice(i + 1, end);
    const keep = RUNS_QUOTED.test(out) || (ch === '"' && EXPANDS.test(inner));
    // The kept text is itself a shell command: its own quotes count too.
    out += ch + (keep ? executableText(inner) : "") + ch;
    i = end;
  }
  return out;
}

/** `name` (a regex source, may be an alternation) at a command position, then `rest`. */
export function commandPattern(name, rest = "") {
  return new RegExp(`${CMD_POS}(?:${name})(?=$|[\\s;&|)'"\\x60])${rest ? `\\s+(?:\\S+\\s+)*?${rest}` : ""}`, "m");
}

/**
 * A stand-in-log pattern (`/^gh pr create\b/`) as a transcript pattern: the
 * same text at any command position, with any path prefix.
 */
export function transcriptPattern(runPattern) {
  const source = runPattern.source.startsWith("^") ? runPattern.source.slice(1) : runPattern.source;
  return new RegExp(`${CMD_POS}${source}`, "m");
}

/**
 * Every `ade …` invocation in a command, normalized the way the CLI reads it.
 * `"$ADE_CLI_PATH" …` counts: ADE's prompt gives agents that variable.
 */
export function adeInvocations(commandText) {
  const found = [];
  const re = new RegExp(`${CMD_POS}(?:ade|\\$\\{?ADE_CLI_PATH\\}?"?)\\s+([^;&|\\n\\x60)]*)`, "gm");
  for (const m of executableText(commandText).matchAll(re)) found.push(normalizeAdeCall(`ade ${m[1].trim().replace(/['"]+$/, "")}`));
  return found;
}

/** `ade --socket /x browser open …` → `ade browser open …`, as the CLI reads it. */
export function normalizeAdeCall(line) {
  const words = line.trim().split(/\s+/).slice(1);
  while (words.length) {
    if (words[0] === "--socket") {
      words.shift();
      if (words[0]?.startsWith("/")) words.shift();
    } else if (["--text", "--json", "--quiet"].includes(words[0])) {
      words.shift();
    } else {
      break;
    }
  }
  return `ade ${words.join(" ")}`;
}

/** A call that only asks for help (`--help`, `-h`, `ade help …`): it shows intent, not the action. */
export function isHelpCall(text) {
  return /(?:^|\s)(?:--help|-h)(?=[\s"')]|$)/.test(text) || /^ade\s+help\b/.test(text);
}

/** Rule table entries: { id, command, args?, decision: "deny" | "deny-once", reason }. */
export function compileRules(rules) {
  return rules.map((rule) => ({ ...rule, pattern: commandPattern(rule.command, rule.args ?? "") }));
}

export function firstRuleHit(compiled, commandText) {
  const text = executableText(commandText);
  return compiled.find((rule) => rule.pattern.test(text)) ?? null;
}
