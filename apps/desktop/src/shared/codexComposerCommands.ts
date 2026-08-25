/**
 * Codex composer grammar shared by the desktop composer and the app-server
 * adapter. Keep this module renderer-safe: no Node APIs.
 */

export const CODEX_USER_SHELL_PREFIX = "!";
export const CODEX_MEMORY_RESET_RECEIPT = "Codex memory reset for this home.";
export const CODEX_CHECKIN_COALESCE_WINDOW_MS = 12_000;

export type CodexUserShellDraft = {
  command: string;
};

export type CodexMemorySlashCommand =
  | { kind: "status" }
  | { kind: "set"; enabled: boolean }
  | { kind: "reset"; confirm: boolean }
  | { kind: "invalid"; message: string };

function firstLine(text: string): string {
  const newline = text.search(/\r|\n/);
  return (newline < 0 ? text : text.slice(0, newline)).trim();
}

export function parseCodexUserShellDraft(text: string): CodexUserShellDraft | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CODEX_USER_SHELL_PREFIX)) return null;
  const command = trimmed.slice(CODEX_USER_SHELL_PREFIX.length).trim();
  return command.length ? { command } : null;
}

export function parseCodexShellSlashCommand(text: string): CodexUserShellDraft | null {
  const match = /^\/shell(?:\s+|$)(.*)$/is.exec(text.trim());
  if (!match) return null;
  const command = match[1]!.trim();
  return command.length ? { command } : null;
}

export function parseCodexMemorySlashCommand(text: string): CodexMemorySlashCommand | null {
  const trimmed = firstLine(text);
  if (!trimmed.toLowerCase().startsWith("/memory")) return null;
  const rest = trimmed.replace(/^\/memory(?:-reset)?(?:\s+|$)/i, "");
  const isReset = /^\/memory-reset(?:\s|$)/i.test(trimmed);
  if (isReset) {
    const confirm = rest.trim().toLowerCase() === "confirm";
    return { kind: "reset", confirm };
  }
  const arg = rest.trim().toLowerCase();
  if (!arg || arg === "status") return { kind: "status" };
  if (arg === "on" || arg === "enable" || arg === "enabled") return { kind: "set", enabled: true };
  if (arg === "off" || arg === "disable" || arg === "disabled") return { kind: "set", enabled: false };
  if (arg === "reset") return { kind: "reset", confirm: false };
  return {
    kind: "invalid",
    message: "Usage: /memory [on|off|status] or /memory-reset.",
  };
}

export function isCodexMemoryResetDraft(text: string): boolean {
  const parsed = parseCodexMemorySlashCommand(text);
  return parsed?.kind === "reset" && !parsed.confirm;
}

export function shouldCoalesceCodexCheckIn(args: {
  previousText: string | null | undefined;
  previousAtMs: number | null | undefined;
  nextText: string;
  nowMs: number;
  windowMs?: number;
}): boolean {
  const previous = args.previousText?.trim() ?? "";
  const next = args.nextText.trim();
  if (!previous || previous !== next) return false;
  if (args.previousAtMs == null || !Number.isFinite(args.previousAtMs)) return false;
  const windowMs = args.windowMs ?? CODEX_CHECKIN_COALESCE_WINDOW_MS;
  return args.nowMs - args.previousAtMs >= 0 && args.nowMs - args.previousAtMs <= windowMs;
}

/** Visual `$` chip for a leading `!command` draft. The `!` stays in the stored text. */
export function codexUserShellChipRange(text: string): { start: number; end: number } | null {
  const match = /^(\s*)!(\S*)/.exec(text);
  if (!match) return null;
  const start = match[1]!.length;
  return { start, end: start + 1 };
}
