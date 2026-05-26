import type { WorkerSandboxConfig } from "../../../../shared/types";

export const DEFAULT_WORKER_SANDBOX_CONFIG: WorkerSandboxConfig = {
  blockedCommands: [
    "\\brm\\s+-rf\\s+/",
    "\\brm\\s+-rf\\s+~",
    "\\bsudo\\b",
    "\\bchmod\\s+777\\b",
    "\\bcurl\\b.*\\|\\s*sh",
    "\\bwget\\b.*\\|\\s*sh",
    "\\beval\\b",
    ">\\s*/etc/",
    ">\\s*/usr/",
    ">\\s*/var/",
    "\\bmkfs\\b",
    "\\bdd\\b\\s+if=",
    "\\bshutdown\\b",
    "\\breboot\\b",
    ":\\(\\)\\{",
    "\\breg(?:\\.exe)?\\s+(add|delete|import|load|unload|copy|save|restore)\\b",
    "\\bdiskpart(?:\\.exe)?\\b",
    "\\bformat(?:\\.exe)?\\s+[a-z]:",
    "\\bbcdedit(?:\\.exe)?\\b",
    "\\btakeown(?:\\.exe)?\\b",
    ">\\s*[^\\n\\r]*[/\\\\]windows[/\\\\]system32\\b",
    ">\\s*[^\\n\\r]*[/\\\\]windows[/\\\\]syswow64\\b",
  ],
  safeCommands: [
    "^pnpm(\\.cmd)?\\s",
    "^npm(\\.cmd)?\\s",
    "^yarn(\\.cmd)?\\s",
    "^npx(\\.cmd)?\\s",
    "^git(\\.exe)?\\s+status\\b",
    "^git(\\.exe)?\\s+diff\\b",
    "^git(\\.exe)?\\s+log\\b",
    "^git(\\.exe)?\\s+show\\b",
    "^git(\\.exe)?\\s+branch\\s*$",
    "^git(\\.exe)?\\s+ls-files\\b",
    "^ls\\s",
    "^ls$",
    "^pwd\\b",
    "^echo\\s",
    "^date\\b",
    "^node(\\.exe)?\\s",
    "^tsx(\\.cmd)?\\s",
    "^vitest(\\.cmd)?\\s",
    "^jest(\\.cmd)?\\s",
    "^eslint(\\.cmd)?\\s",
    "^prettier(\\.cmd)?\\s",
    "^tsc(\\.cmd)?\\b",
    "^lsof\\s",
    "^ps\\s",
  ],
  protectedFiles: [
    "\\.env$",
    "\\.env\\.",
    "secrets?\\.json$",
    "credentials\\.json$",
    "\\.pem$",
    "\\.key$",
    "/\\.git/",
  ],
  allowedPaths: ["./"],
  blockByDefault: false,
};

const CLAUDE_READ_ONLY_NATIVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
] as const;

export function buildClaudeReadOnlyWorkerAllowedTools(extraToolNames: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...CLAUDE_READ_ONLY_NATIVE_TOOLS, ...extraToolNames]) {
    const trimmed = entry.trim();
    if (!trimmed.length || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
