/**
 * Masks secrets in a COMMAND LINE before it is shown in a compact or expanded
 * surface: working-indicator labels, tool-call headers, approval headlines,
 * background-job labels, and the command body of a shell tool.
 *
 * It is not a general text redactor. Code, diffs, file edits, prompts and
 * memory never go through it, so the patterns can stay narrow enough not to
 * touch an identifier such as `tokenCount` or a flag such as `--key-file`.
 *
 * Shared by the main process, the renderer, and the CLI so every surface
 * masks the same shapes. Callers mask the FULL command before they truncate or
 * flatten it: a key cut in half by a length limit no longer matches its
 * pattern and leaks its prefix.
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g;

/** Provider and service keys recognised by their prefix, masked wherever they appear. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // `sk-ant-` is masked even with nothing after it: a key cut off early would
  // otherwise still show its provider prefix.
  /\bsk-ant-[A-Za-z0-9_-]*|\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * `Authorization: Bearer x`, `Proxy-Authorization=Basic x`. Keeps the header,
 * quote and scheme; the value is the fourth group.
 */
const AUTHORIZATION_PATTERN =
  /(\b(?:proxy-)?authorization["']?\s*[:=]\s*)(["']?)((?:(?:bearer|basic|token)\s+)?)([^\s"',;]+)/gi;

/** A bare `Bearer <token>` anywhere in the command. */
const BEARER_PATTERN = /(\bbearer\s+)[A-Za-z0-9\-._~+/]{12,}=*/gi;

/**
 * `https://user:password@host`: keeps the user, masks the password. The scheme
 * is bounded so a long run of `a-a-a…` cannot cost a quadratic scan.
 */
const URL_CREDENTIAL_PATTERN = /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi;

/**
 * Shell environment assignments whose NAME is an env-style secret: upper-case
 * and ending in TOKEN, SECRET, PASSWORD or PASSWD (`PGPASSWORD`, `GHTOKEN`),
 * or with KEY, APIKEY, CREDENTIAL(S) or an auth blob (`AUTH_CONFIG`,
 * `AUTH_HEADER`, `AUTHORIZATION`) as a whole `_`-separated segment:
 * `MY_API_KEY` and `DOCKER_AUTH_CONFIG` match, `MONKEY` and `MAX_TOKENS` do
 * not. Segment count and length are bounded.
 */
const ENV_SECRET_NAME = String.raw`(?:[A-Z][A-Z0-9]{0,31}_){0,8}(?:[A-Z0-9]{0,31}(?:TOKEN|SECRET|PASSWORD|PASSWD)|(?:API)?KEY|CREDENTIALS?|AUTH_CONFIG|AUTH_HEADER|AUTHORIZATION)`;
// A value is a non-empty quoted run or a non-empty bare word. A bare value cannot
// start with a shell or printf placeholder (`$VAR`, `%s`, `<x>`, `{x}`).
const COMMAND_VALUE = String.raw`(?:"(?:\\.|[^"\\\n])+"|'(?:\\.|[^'\\\n])+'|(?![$%<{])(?:\\.|[^\s"'&;|)<>\\])+)`;
// PowerShell writes `$env:NAME = "value"` with spaces around `=`. A `==` is a
// comparison (`[[ $TOKEN == "" ]]`), not an assignment.
const ENV_ASSIGNMENT_PATTERN = new RegExp(String.raw`(\b${ENV_SECRET_NAME}[ \t]*=(?!=)[ \t]*)(${COMMAND_VALUE})`, "g");

/**
 * A quoted JSON-style key in a command body: `-d '{"api_key": "…"}'`, or the
 * same shape escaped for a double-quoted shell argument: `-d "{\"api_key\":\"…\"}"`.
 */
const JSON_SECRET_PATTERN = /(\\?["'][A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)\\?["']\s*:\s*)(\\?["'])((?:\\.|[^"'\\\n])+?)\2/gi;

/**
 * Lower-case secret flags: `--api-key value`, `--token=value`, `--authtoken value`.
 * A flag name ending in token, secret or password is a secret flag; key and
 * credentials must be a whole segment (or `apikey`), so `--monkey` is not. A space-separated value that starts with `-` is the next flag
 * (`--token --verbose`), not a value. Segment count and length are bounded.
 */
const FLAG_PATTERN = new RegExp(
  String.raw`(--(?:[a-z0-9]{1,32}[-_]){0,8}(?:[a-z0-9]{0,31}(?:token|secret|passw(?:or)?d)|(?:api)?key|credentials?)(?:=|\s+(?!-)))(${COMMAND_VALUE})`,
  "g",
);

/**
 * True when a matched secret-named value must stay visible: a placeholder
 * (`<your-key>`, `%s`, `{name}`), or text the shell expands (`$VAR`, `$(…)`,
 * backticks), which is code that runs and not a literal secret. A single-quoted
 * value never expands, so only an exact `'<placeholder>'` stays visible, and a
 * quoted JSON blob (`'{"auths":…}'`) is not a `{name}` placeholder. An escaped
 * `\$` is a literal dollar.
 */
function staysVisible(value: string): boolean {
  if (value.startsWith("'")) return /^'<[^<>'\n]*>'$/.test(value);
  if (isPlaceholder(value)) return true;
  return /[$`]/.test(value.replace(/\\[\s\S]/g, ""));
}

function isPlaceholder(value: string): boolean {
  return /^"?(?:[<%]|\{\w+\})/.test(value);
}

/** Replacer for an assignment or flag: keeps the head, masks the value unless it must stay visible. */
function maskAssignment(_match: string, head: string, value: string): string {
  return staysVisible(value) ? head + value : `${head}<redacted>`;
}

/**
 * Replacer for a JSON key/value pair; the value's quote (`"` or `\"`) is group 2.
 * An escaped quote means the JSON sits in a double-quoted shell argument, where
 * `$` expands; a plain quote means single-quoted shell text, where it is literal.
 */
function maskJsonSecret(match: string, head: string, quote: string, value: string): string {
  const visible = quote.startsWith("\\") ? staysVisible(`"${value}"`) : isPlaceholder(value);
  return visible ? match : `${head}${quote}<redacted>${quote}`;
}

/**
 * Replacer for an `Authorization` header: keeps the header, quote and scheme,
 * masks the credential. A header that opens a single-quoted argument
 * (`-H 'Authorization: Bearer …'`) never expands, so it is masked like one.
 */
function maskAuthorization(
  match: string, head: string, quote: string, scheme: string, value: string, offset: number, whole: string,
): string {
  const singleQuoted = quote === "'" || whole[offset - 1] === "'";
  return staysVisible(singleQuoted ? `'${value}'` : quote + value) ? match : `${head}${quote}${scheme}<redacted>`;
}

/** Masks secrets in one command line. Multi-line safe (PEM blocks), never truncates. */
export function redactCommandLine(command: string): string {
  if (!command) return command;
  let out = command.replace(PRIVATE_KEY_BLOCK, "<redacted-private-key>");
  out = out.replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "<redacted-token>");
  out = out.replace(AUTHORIZATION_PATTERN, maskAuthorization);
  out = out.replace(BEARER_PATTERN, "$1<redacted>");
  out = out.replace(ENV_ASSIGNMENT_PATTERN, maskAssignment);
  out = out.replace(JSON_SECRET_PATTERN, maskJsonSecret);
  out = out.replace(FLAG_PATTERN, maskAssignment);
  return out;
}

/**
 * One display line for a command: masked first, then flattened and cut to
 * `maxChars`. The only correct order for anything shown compactly.
 */
export function oneLineRedacted(command: string, maxChars: number): string {
  const line = redactCommandLine(String(command ?? "")).replace(/\s+/g, " ").trim();
  return line.length > maxChars ? `${line.slice(0, Math.max(0, maxChars - 1))}…` : line;
}
