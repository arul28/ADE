import { stripAnsi } from "../../utils/ansiStrip";

export type InferredTestOutcome = {
  status: "pass" | "fail";
  evidence: string;
};

export type TranscriptSummaryRef = {
  summary: string;
  testOutcome: InferredTestOutcome | null;
};

export type TranscriptSummarySource = "explicit_final_block" | "heuristic_tail";

export type TranscriptSummaryConfidence = "high" | "medium";

export type ParsedTranscriptSummary = {
  summary: string;
  bullets: string[];
  files: string[];
  source: TranscriptSummarySource;
  confidence: TranscriptSummaryConfidence;
  omissionTags: string[];
};

function normalize(raw: string): string {
  return stripAnsi(String(raw ?? "")).replace(/\r\n/g, "\n");
}

function lastIndexOfRegex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(text)) != null) {
    last = match.index;
  }
  return last;
}

function lineAt(text: string, idx: number): string {
  if (idx < 0) return "";
  const start = text.lastIndexOf("\n", idx);
  const end = text.indexOf("\n", idx);
  const slice = text.slice(start < 0 ? 0 : start + 1, end < 0 ? text.length : end);
  return slice.trim();
}

function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("✻")) return true;
  const lower = t.toLowerCase();
  if (lower.startsWith("cooked for")) return true;
  return false;
}

function parseFileCandidates(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_]+)`/g)) {
      const file = (match[1] ?? "").trim();
      if (file) files.add(file);
    }
    for (const match of line.matchAll(/\b(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_]+\b/g)) {
      const file = (match[0] ?? "").trim();
      if (file) files.add(file);
    }
  }
  return Array.from(files).sort((a, b) => a.localeCompare(b));
}

function clipList(values: string[], maxItems: number, omissionTags: string[], tag: string): string[] {
  if (values.length <= maxItems) return values;
  omissionTags.push(tag);
  return values.slice(0, Math.max(0, maxItems));
}

function parseExplicitFinalBlock(text: string): ParsedTranscriptSummary | null {
  const lines = text.split("\n");
  let anchorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (
      /^(done\.?|all done\.?|completed\.?)\b/i.test(line) ||
      /^accomplished\s*:/i.test(line) ||
      /^research is complete\b/i.test(line) ||
      /here'?s what (?:i|we) (?:changed|did|updated|fixed)/i.test(line) ||
      /^summary\s*:/i.test(line) ||
      /^final summary\s*:?/i.test(line)
    ) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return null;

  const block = lines
    .slice(anchorIdx, lines.length)
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line));
  if (!block.length) return null;

  const bullets = block
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);

  const summary = block
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return null;

  const omissionTags: string[] = [];
  const clippedBullets = clipList(bullets, 6, omissionTags, "bullets_clipped");
  const files = clipList(parseFileCandidates(block), 12, omissionTags, "files_clipped");

  return {
    summary,
    bullets: clippedBullets,
    files,
    source: "explicit_final_block",
    confidence: "high",
    omissionTags
  };
}

function parseHeuristicTail(text: string): ParsedTranscriptSummary | null {
  if (!text.trim()) return null;

  const passAnchors: RegExp[] = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bpass(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*passed\b/gi,
    /\bTests?:\s*\d+\s*passed\b/gi
  ];

  const summaryAnchors: RegExp[] = [
    /\bHere's what I (?:added|changed|did)\b/gi,
    /\bSummary\b\s*:/gi
  ];

  let passIdx = -1;
  for (const anchor of passAnchors) passIdx = Math.max(passIdx, lastIndexOfRegex(text, anchor));
  let summaryIdx = -1;
  for (const anchor of summaryAnchors) summaryIdx = Math.max(summaryIdx, lastIndexOfRegex(text, anchor));

  const idx = passIdx >= 0 && summaryIdx >= 0 ? Math.min(passIdx, summaryIdx) : Math.max(passIdx, summaryIdx);

  const slice = idx >= 0 ? text.slice(idx) : text.split("\n").slice(-24).join("\n");
  const lines = slice
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line));

  const summary = lines
    .slice(0, 18)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return null;

  const omissionTags: string[] = [];
  const files = clipList(parseFileCandidates(lines), 12, omissionTags, "files_clipped");
  return {
    summary,
    bullets: [],
    files,
    source: "heuristic_tail",
    confidence: "medium",
    omissionTags
  };
}

export function parseTranscriptSummary(rawText: string): ParsedTranscriptSummary | null {
  const text = normalize(rawText);
  if (!text.trim()) return null;
  return parseExplicitFinalBlock(text) ?? parseHeuristicTail(text);
}

export function deriveSessionSummaryFromText(rawText: string): string {
  return parseTranscriptSummary(rawText)?.summary ?? "";
}

export function inferTestOutcomeFromText(rawText: string): InferredTestOutcome | null {
  const text = normalize(rawText);
  if (!text.trim()) return null;

  const passPatterns: RegExp[] = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bpass(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*passed\b/gi,
    /\bTests?:\s*\d+\s*passed\b/gi,
    /\bTest Files?:\s*\d+\s*passed\b/gi
  ];

  const failPatterns: RegExp[] = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bfail(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*failed\b/gi,
    /\bTests?:\s*\d+\s*failed\b/gi,
    /\bFAIL\b.{0,160}\btest\b/gi,
    /\btest\b.{0,160}\bFAIL\b/gi
  ];

  let passIdx = -1;
  for (const pattern of passPatterns) passIdx = Math.max(passIdx, lastIndexOfRegex(text, pattern));
  let failIdx = -1;
  for (const pattern of failPatterns) failIdx = Math.max(failIdx, lastIndexOfRegex(text, pattern));

  if (passIdx < 0 && failIdx < 0) return null;

  const status: "pass" | "fail" = failIdx > passIdx ? "fail" : "pass";
  const idx = status === "fail" ? failIdx : passIdx;
  const evidence = lineAt(text, idx) || (status === "fail" ? "tests failed" : "tests passed");

  return { status, evidence };
}

export function buildTranscriptSummaryRef(rawText: string, maxChars = 600): TranscriptSummaryRef {
  const summaryRaw = deriveSessionSummaryFromText(rawText);
  const summary =
    summaryRaw.length > maxChars
      ? `${summaryRaw.slice(0, Math.max(0, maxChars - 20)).trimEnd()} ...(truncated)...`
      : summaryRaw;
  return {
    summary,
    testOutcome: inferTestOutcomeFromText(rawText)
  };
}
