/**
 * Config keys whose VALUE is a credential regardless of where it appears.
 *
 * Word-bounded on purpose: `secretRef` NAMES a secret rather than carrying one,
 * so it stays readable — the CTO needs to know which secret a webhook trigger
 * depends on, and hiding the name protects nothing.
 */
const CREDENTIAL_KEY_PATTERN = /(^|_)(token|secret|password|passphrase|apikey|api_key|credential|privatekey|private_key)($|_)/i;

/**
 * Keys that look credential-shaped but only NAME a credential. `secretRef`
 * points at a secret in the store; hiding the pointer protects nothing and
 * costs the CTO the ability to say which secret a trigger depends on.
 */
const CREDENTIAL_NAME_KEYS = new Set(["secret_ref", "secret_name", "api_key_ref", "credential_ref"]);

/**
 * `githubToken` and `accessToken` carry a credential but contain no separator,
 * so an anchored pattern never matched them. Split camelCase into `_` words
 * first, then match, so `githubToken` -> `github_token` -> hit. Matching a bare
 * substring instead would redact innocent keys such as `tokenizer`.
 */
export function normalizeConfigKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase();
}

/** True for a key whose value is a credential (`API_TOKEN`, `githubToken`), false for one that names it (`secretRef`). */
export function isCredentialKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = normalizeConfigKey(key);
  if (CREDENTIAL_NAME_KEYS.has(normalized)) return false;
  return CREDENTIAL_KEY_PATTERN.test(normalized);
}

/**
 * The credential-shaped keys anywhere inside `value` that hold a non-empty
 * string, sorted and unique. Names only, never values.
 */
export function credentialKeyNames(value: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown, key: string | undefined): void => {
    if (typeof node === "string") {
      if (node.trim() && isCredentialKey(key)) names.add(key!);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, key);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) walk(child, childKey);
    }
  };
  walk(value, undefined);
  return [...names].sort();
}
