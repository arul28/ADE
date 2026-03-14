import type { TerminalRuntimeState, TerminalToolType } from "../../shared/types";

const OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
const RESUME_BACKTICK_REGEX = /`((?:claude|codex)\s+(?:resume|--resume\b)[^`\r\n]*)`/gi;
const RESUME_PLAIN_REGEX = /\b((?:claude|codex)\s+(?:resume|--resume\b)[^\r\n]*)/gi;

function normalizeCommand(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[)\].,;:!?]+$/g, "")
    .trim();
}

function toolFromCommand(raw: string): TerminalToolType | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("claude ")) return "claude";
  if (normalized.startsWith("codex ")) return "codex";
  return null;
}

function prefersTool(raw: string, preferredTool: TerminalToolType | null | undefined): boolean {
  if (!preferredTool || (preferredTool !== "claude" && preferredTool !== "codex")) return true;
  const cmdTool = toolFromCommand(raw);
  return cmdTool === preferredTool;
}

export function defaultResumeCommandForTool(toolType: TerminalToolType | null | undefined): string | null {
  if (toolType === "claude" || toolType === "claude-orchestrated") return "claude resume";
  if (toolType === "codex" || toolType === "codex-orchestrated") return "codex resume";
  return null;
}

export function extractResumeCommandFromOutput(
  text: string,
  preferredTool?: TerminalToolType | null
): string | null {
  if (!text.trim()) return null;

  const fromBackticks = Array.from(text.matchAll(RESUME_BACKTICK_REGEX))
    .map((m) => normalizeCommand(m[1] ?? ""))
    .filter(Boolean);
  for (const candidate of fromBackticks) {
    if (prefersTool(candidate, preferredTool)) return candidate;
  }

  const fromPlain = Array.from(text.matchAll(RESUME_PLAIN_REGEX))
    .map((m) => normalizeCommand(m[1] ?? ""))
    .filter(Boolean);
  for (const candidate of fromPlain) {
    if (prefersTool(candidate, preferredTool)) return candidate;
  }

  return null;
}

export function runtimeStateFromOsc133Chunk(
  chunk: string,
  previous: TerminalRuntimeState
): TerminalRuntimeState {
  let next = previous;
  if (!chunk) return next;
  for (const match of chunk.matchAll(OSC_133_REGEX)) {
    const marker = (match[1] ?? "").toUpperCase();
    if (marker === "A" || marker === "D") {
      next = "waiting-input";
      continue;
    }
    if (marker === "B" || marker === "C") {
      next = "running";
    }
  }
  return next;
}
