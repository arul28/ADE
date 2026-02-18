import { stripAnsiWithOptions } from "./ansiStrip";

function normalizePreviewLine(raw: string): string {
  if (!raw) return "";
  return raw.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

function appendVisibleChar(line: string, ch: string): string {
  if (!ch) return line;
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return line;
  if (line.length >= 500) return line;
  return line + ch;
}

export function derivePreviewFromChunk(args: {
  previousLine: string;
  previousPreview: string | null;
  chunk: string;
  maxChars?: number;
}): { nextLine: string; preview: string | null } {
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(20, Math.floor(args.maxChars ?? 220)) : 220;
  const cleaned = stripAnsiWithOptions(args.chunk ?? "", { preserveCarriageReturns: true });

  let line = args.previousLine ?? "";
  let preview = args.previousPreview ?? null;

  const captureLine = () => {
    const normalized = normalizePreviewLine(line);
    if (normalized.length) preview = normalized;
    line = "";
  };

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i] ?? "";
    if (ch === "\r") {
      line = "";
      continue;
    }
    if (ch === "\n") {
      captureLine();
      continue;
    }
    line = appendVisibleChar(line, ch);
  }

  const currentLine = normalizePreviewLine(line);
  if (currentLine.length) preview = currentLine;

  if (preview && preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  return { nextLine: line.slice(-500), preview };
}
