const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".xml": "xml",
  ".md": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "ini",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".php": "php",
  ".sql": "sql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".dockerfile": "dockerfile"
};

export function extensionToLanguage(filePath: string): string {
  const lower = filePath.toLowerCase().trim();
  if (!lower.length) return "plaintext";

  if (lower.endsWith("dockerfile")) return "dockerfile";

  const lastDot = lower.lastIndexOf(".");
  if (lastDot < 0) return "plaintext";
  const ext = lower.slice(lastDot);
  return EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
}
