/**
 * Whether a piece of text looks like a secret: a known token shape, a private
 * key, a secret-named key with a literal value, or a lone high-entropy string.
 *
 * Shared because two places ask the same question: the clipboard history
 * (main) never keeps a copy that looks like one, and the chat composer
 * (renderer) suggests ADE secrets when one is sent in a message. Pure and
 * O(text); it never logs or returns the match.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
];

/**
 * `password = "…"`, `API_KEY=…`, `"client_secret": "…"`: a secret-named key
 * given a value that looks like a literal. A quoted value of 8+ characters
 * counts unless it is a placeholder (`"${TOKEN}"`, `"<your key>"`); an
 * unquoted one must carry a digit and must not be a reference
 * (`token = getToken();`, `secret: process.env.SECRET`, `password: string`).
 */
const SECRET_ASSIGNMENT = /\b[\w-]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|token)[\w-]*["']?\s*[:=]\s*(?:(["'`])([^"'`\s]{8,})\1|([^\s"'`;,(){}[\]]{8,})(?=$|[\s;,]))/gi;
const PLACEHOLDER_VALUE = /^(?:\$|<|%|\{)/;
const DOTTED_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

function hasSecretAssignment(text: string): boolean {
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    const quoted = match[2];
    if (quoted) {
      if (!PLACEHOLDER_VALUE.test(quoted)) return true;
      continue;
    }
    const bare = match[3] ?? "";
    if (/\d/.test(bare) && !PLACEHOLDER_VALUE.test(bare) && !DOTTED_REFERENCE.test(bare)) return true;
  }
  return false;
}

/** Shapes that mix every character class without being a secret: links, paths, addresses, package specs. */
const NOT_A_SECRET: RegExp[] = [
  /^(?:https?|ftp|ssh|git|file|wss?):\/\//i,
  /^[a-z]:[\\/]/i,
  /^\\\\[^\\]+\\/,
  /^(?:\/|~\/|\.{1,2}[\\/])/,
  // host.tld[:port][/path] with no scheme
  /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$/i,
  // name@host.tld
  /^[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,24}$/i,
  // dir/dir/file.ext or a/b/c
  /^[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z0-9]{1,8}$/,
  /^(?:[\w.@-]+[\\/]){2,}[\w.@-]*$/,
  // @scope/name@1.2.3, name@^1.2.3
  /^(?:@[\w.-]+\/)?[\w.-]+@[\w.^~<>=*|-]+$/,
];

function shannonBitsPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True for a copy that should not be kept: a known token shape, a private key,
 * a secret-named key with a literal value, or a lone high-entropy string that
 * mixes letters, digits and symbols the way generated passwords do. Hashes
 * and ids (hex, base32) pass, because they use fewer character classes.
 */
export function looksLikeSecret(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (hasSecretAssignment(trimmed)) return true;
  if (/\s/.test(trimmed) || trimmed.length < 12 || trimmed.length > 128) return false;
  // A link or a path mixes every character class too; a token inside one was caught above.
  if (NOT_A_SECRET.some((pattern) => pattern.test(trimmed))) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(trimmed)).length;
  return classes >= 4 && shannonBitsPerChar(trimmed) >= 3.5;
}
