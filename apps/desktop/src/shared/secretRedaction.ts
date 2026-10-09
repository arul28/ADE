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

/** `Authorization: Bearer x`, `Proxy-Authorization=Basic x`. Keeps the header and scheme. */
const AUTHORIZATION_PATTERN =
  /(\b(?:proxy-)?authorization["']?\s*[:=]\s*(?:["']?)(?:(?:bearer|basic|token)\s+)?)[^\s"',;]+/gi;

/** A bare `Bearer <token>` anywhere in the command. */
const BEARER_PATTERN = /(\bbearer\s+)[A-Za-z0-9\-._~+/]{12,}=*/gi;

/** `https://user:password@host`: keeps the user, masks the password. */
const URL_CREDENTIAL_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi;

/**
 * Shell environment assignments whose NAME is an env-style secret: upper-case
 * and ending in KEY, TOKEN, SECRET, PASSWORD, PASSWD or CREDENTIAL(S). Matches
 * `ANTHROPIC_API_KEY=…`, `export GITHUB_TOKEN=…`, `DB_PASSWORD='…'`. Lower-case
 * code identifiers and names like `MAX_TOKENS` are left alone.
 */
const ENV_SECRET_NAME = String.raw`[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)`;
// A value that is a shell or printf placeholder (`$VAR`, `%s`, `<x>`, `{x}`) is not a secret.
// A bare value needs six characters, so a short literal stays readable.
const COMMAND_VALUE = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?![$%<{])(?:\\.|[^\s"'&;|)<>\\]){6,})`;
const ENV_ASSIGNMENT_PATTERN = new RegExp(String.raw`(\b${ENV_SECRET_NAME}=)${COMMAND_VALUE}`, "g");

/** A quoted JSON-style key in a command body: `-d '{"api_key": "…"}'`. */
const JSON_SECRET_PATTERN = /(["'][A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)["']\s*:\s*)(["'])[^"'\n]{4,}\2/gi;

/** Lower-case secret flags: `--api-key value`, `--token=value`, `--password value`. */
const FLAG_PATTERN = new RegExp(
  String.raw`(--[a-z0-9-]*(?:key|token|secret|passw(?:or)?d|passwd|credentials?)(?:=|\s+))${COMMAND_VALUE}`,
  "g",
);

/** Masks secrets in one command line. Multi-line safe (PEM blocks), never truncates. */
export function redactCommandLine(command: string): string {
  if (!command) return command;
  let out = command.replace(PRIVATE_KEY_BLOCK, "<redacted-private-key>");
  out = out.replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "<redacted-token>");
  out = out.replace(AUTHORIZATION_PATTERN, "$1<redacted>");
  out = out.replace(BEARER_PATTERN, "$1<redacted>");
  out = out.replace(ENV_ASSIGNMENT_PATTERN, "$1<redacted>");
  out = out.replace(JSON_SECRET_PATTERN, "$1$2<redacted>$2");
  out = out.replace(FLAG_PATTERN, "$1<redacted>");
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
