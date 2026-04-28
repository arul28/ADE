const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const SHELL_PROMPT_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\s+.+\s[%#$]$/;
const WORKER_PROMPT_PATH_PATTERN = /(?:^|[\\/])(?:orchestrator[\\/])?worker-prompts[\\/]worker-[a-f0-9-]+(?:\.[A-Za-z0-9._-]+)?/i;

export function stripWorkerRuntimeAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function isWorkerBootstrapNoiseLine(line: string): boolean {
  const normalized = stripWorkerRuntimeAnsi(line).trim();
  if (!normalized.length) return false;
  const lower = normalized.toLowerCase();

  return (
    lower.startsWith("ade_mission_id=")
    || lower.startsWith("-p \"$(cat ")
    || WORKER_PROMPT_PATH_PATTERN.test(normalized)
    || lower.includes("exec claude --model")
    || /\bexec codex\b/i.test(normalized)
    || /^\/users\/.+\.zshrc:\d+:/i.test(lower)
    || /command not found:\s*compdef/i.test(normalized)
    || /^EOF['"]?\s+in\s+\/Users\//i.test(normalized)
    || SHELL_PROMPT_PATTERN.test(normalized)
  );
}

export function sanitizeWorkerTranscriptForDisplay(text: string): string {
  const lines = stripWorkerRuntimeAnsi(text).split(/\r?\n/);
  const kept: string[] = [];
  let pendingBlank = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (isWorkerBootstrapNoiseLine(line)) continue;
    if (!line.trim().length) {
      if (kept.length > 0 && !pendingBlank) {
        kept.push("");
        pendingBlank = true;
      }
      continue;
    }
    kept.push(line);
    pendingBlank = false;
  }

  return kept.join("\n").trim();
}
