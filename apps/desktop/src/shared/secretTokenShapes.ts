/**
 * The provider and service keys ADE recognises by their shape: one list for
 * every redactor that removes secrets from text (error reports, child-process
 * output, command lines, saved memory, chat transcripts, AI context).
 *
 * Only shapes a secret alone has: a known prefix followed by a long run of key
 * characters. Rules that read context (`password=…`, `Bearer …`, a URL's
 * `user:password@`, an unterminated private key) stay with each redactor,
 * because how far they may reach depends on the text: a Sentry report can lose
 * the rest of a message, a saved memory cannot.
 *
 * `secretText.ts` asks a different question (does a copy or a sent message look
 * like a secret?) with stricter lengths, so it keeps its own list.
 */
export const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // OpenAI, Anthropic and OpenRouter keys: `sk-ant-api03-…`, `sk-proj-…` and
  // `sk-or-v1-…` bodies carry `-` and `_`; an unprefixed `sk-` key is
  // alphanumeric, so a folder such as `sk-learn-tutorials` is left alone.
  /\bsk-(?:ant|proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{12,}|\bsk-[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bsntrys_[A-Za-z0-9_=-]{20,}/g,
  /\b(?:xai-|gsk_)[A-Za-z0-9_-]{16,}/g,
  // npm and Hugging Face tokens have no underscore after the prefix, unlike
  // the many `npm_config_*` variable names.
  /\b(?:npm|hf)_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `text` with every {@link SECRET_TOKEN_PATTERNS} match replaced by `replacement`. */
export function redactSecretTokens(text: string, replacement: string): string {
  let output = text;
  for (const pattern of SECRET_TOKEN_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

/** Whether `text` holds a key of a known shape anywhere. */
export function containsSecretToken(text: string): boolean {
  return SECRET_TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
