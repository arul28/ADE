const DEFAULT_EXCLUDES = [
  ".git/",
  "node_modules/",
  "vendor/",
  ".venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "target/",
  ".env",
  ".env.*",
  ".env.local",
  ".env.production",
  ".env.development",
  "*.pem",
  "*.key",
  "*.cert",
  "credentials.json",
  "secrets.*",
  "id_rsa",
  "id_ed25519",
  "credentials",
  ".aws/credentials"
];

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    replacement: "$1<redacted>"
  },
  {
    pattern: /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    replacement: "<redacted-private-key>"
  },
  {
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    replacement: "<redacted-token>"
  }
];

export function getDefaultExcludePatterns(): string[] {
  return [...DEFAULT_EXCLUDES];
}

function globLikeMatch(inputPath: string, pattern: string): boolean {
  const normalizedPath = inputPath.replace(/\\/g, "/").toLowerCase();
  const normalizedPattern = pattern.trim().replace(/\\/g, "/").toLowerCase();
  if (!normalizedPattern.length) return false;

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`(^|/)${escaped}($|/)`);
  if (regex.test(normalizedPath)) return true;

  return normalizedPath.includes(normalizedPattern);
}

export function pathShouldBeExcluded(filePath: string, extraPatterns: string[] = []): boolean {
  const patterns = [...DEFAULT_EXCLUDES, ...extraPatterns];
  return patterns.some((pattern) => globLikeMatch(filePath, pattern));
}

export function redactSecrets(text: string): string {
  let output = text;
  for (const entry of SECRET_PATTERNS) {
    output = output.replace(entry.pattern, entry.replacement);
  }
  return output;
}
