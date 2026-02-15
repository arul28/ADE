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
  output = output.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    "<redacted-token>"
  );
  return output;
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

