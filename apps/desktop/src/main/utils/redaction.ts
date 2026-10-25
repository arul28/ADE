import { scrubString } from "../../shared/sentry/scrub";
import { redactSecretTokens } from "../../shared/secretTokenShapes";

function redactText(text: string): string {
  let output = text;
  output = output.replace(
    /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    "$1<redacted>"
  );
  output = output.replace(
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    "<redacted-private-key>"
  );
  return redactSecretTokens(output, "<redacted-token>");
}

export function redactSecrets(text: string): string {
  return redactText(String(text ?? ""));
}

export function redactSecretsDeep<T>(value: T, maxDepth = 8): T {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (depth > maxDepth) return v;
    if (typeof v === "string") return redactText(v);
    if (v == null || typeof v !== "object") return v;
    if (seen.has(v as object)) return v;
    seen.add(v as object);

    if (Array.isArray(v)) {
      return v.map((entry) => walk(entry, depth + 1));
    }

    const record = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, entry] of Object.entries(record)) {
      out[k] = walk(entry, depth + 1);
    }
    return out;
  };

  return walk(value, 0) as T;
}

/**
 * A child process's output (an agent's stderr, a git error) with its secrets
 * removed, before it reaches a log line, an error message or a banner. Uses
 * the same secret shapes as error reports, without their length cap.
 */
export function redactProcessOutput(text: string): string {
  return scrubString(String(text ?? ""), { maxLength: Number.POSITIVE_INFINITY });
}

/** A URL's query and fragment, up to the quote or space that ends the URL. */
const URL_QUERY_AND_FRAGMENT = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s'"?#]+)[?#][^\s'"]*/gi;

/**
 * Git's output with every URL's query and fragment dropped, then its secrets
 * removed. Git repeats a remote URL in its errors query and all (it strips only
 * `user:password@`), and a remote URL has no legitimate query, so a pasted
 * `?access_token=…` or `?private_token=…` would otherwise reach the error.
 */
export function redactGitOutput(text: string): string {
  return redactProcessOutput(String(text ?? "").replace(URL_QUERY_AND_FRAGMENT, "$1"));
}
