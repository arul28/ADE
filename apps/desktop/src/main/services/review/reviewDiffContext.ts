import type { ReviewDiffContext } from "../../../shared/types";

type FilePatchSource = {
  filePath: string;
  excerpt: string;
};

const CONTEXT_RADIUS = 8;

function extractFileHunks(patchText: string): string[] {
  if (!patchText) return [];
  const lines = patchText.split("\n");
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) hunks.push(current);
      current = [line];
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  if (current.length > 0) hunks.push(current);
  return hunks.map((hunk) => hunk.join("\n"));
}

type ParsedHunk = {
  newStart: number;
  newLength: number;
  lines: ReviewDiffContext["lines"];
};

function parseHunk(hunk: string): ParsedHunk | null {
  const rawLines = hunk.split("\n");
  const header = rawLines.shift();
  if (!header) return null;
  const match = header.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  const newStart = Number(match[1] ?? "0");
  const newLength = Number(match[2] ?? "1");

  const output: ReviewDiffContext["lines"] = [
    { line: null, kind: "meta", text: header, highlighted: false },
  ];
  let runningLine = newStart;
  for (const raw of rawLines) {
    if (raw.length === 0) continue;
    if (raw.startsWith("\\")) {
      output.push({ line: null, kind: "meta", text: raw, highlighted: false });
      continue;
    }
    const ch = raw[0]!;
    const text = raw.slice(1);
    if (ch === "+") {
      output.push({ line: runningLine, kind: "add", text, highlighted: false });
      runningLine += 1;
    } else if (ch === "-") {
      output.push({ line: null, kind: "del", text, highlighted: false });
    } else {
      output.push({ line: runningLine, kind: "context", text, highlighted: false });
      runningLine += 1;
    }
  }
  return { newStart, newLength, lines: output };
}

function sliceAroundAnchor(parsed: ParsedHunk, anchor: number): ParsedHunk {
  const windowStart = Math.max(parsed.newStart, anchor - CONTEXT_RADIUS);
  const windowEnd = anchor + CONTEXT_RADIUS;
  const filtered: ReviewDiffContext["lines"] = [];
  for (const entry of parsed.lines) {
    if (entry.kind === "meta") {
      filtered.push(entry);
      continue;
    }
    if (entry.line == null) {
      filtered.push(entry);
      continue;
    }
    if (entry.line >= windowStart && entry.line <= windowEnd) {
      filtered.push({ ...entry, highlighted: entry.line === anchor });
    }
  }
  return { ...parsed, lines: filtered };
}

export function buildDiffContextForFinding(args: {
  filePath: string | null;
  anchoredLine: number | null;
  patches: FilePatchSource[];
}): ReviewDiffContext | null {
  if (!args.filePath) return null;
  const patch = args.patches.find((entry) => entry.filePath === args.filePath);
  if (!patch || !patch.excerpt) return null;
  const hunks = extractFileHunks(patch.excerpt).map(parseHunk).filter((h): h is ParsedHunk => h != null);
  if (hunks.length === 0) return null;

  let chosen: ParsedHunk | null = null;
  if (args.anchoredLine != null) {
    chosen =
      hunks.find((hunk) => args.anchoredLine! >= hunk.newStart && args.anchoredLine! < hunk.newStart + hunk.newLength) ??
      null;
  }
  if (!chosen) chosen = hunks[0] ?? null;
  if (!chosen) return null;

  const sliced = args.anchoredLine != null ? sliceAroundAnchor(chosen, args.anchoredLine) : chosen;
  const lineNumbers = sliced.lines.filter((entry) => entry.line != null).map((entry) => entry.line!);
  const startLine = lineNumbers.length ? Math.min(...lineNumbers) : chosen.newStart;
  const endLine = lineNumbers.length ? Math.max(...lineNumbers) : chosen.newStart + chosen.newLength - 1;

  return {
    filePath: args.filePath,
    startLine,
    endLine,
    anchoredLine: args.anchoredLine,
    lines: sliced.lines,
  };
}
