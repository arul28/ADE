import { stripAnsi } from "../../utils/ansiStrip";

export type InferredTestOutcome = {
  status: "pass" | "fail";
  evidence: string;
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

export function deriveSessionSummaryFromText(rawText: string): string {
  const text = normalize(rawText);
  if (!text.trim()) return "";

  const anchors: RegExp[] = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bpass(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*passed\b/gi,
    /\bTests?:\s*\d+\s*passed\b/gi,
    /\bHere's what I (?:added|changed|did)\b/gi,
    /\bSummary\b\s*:/gi
  ];

  let idx = -1;
  for (const anchor of anchors) idx = Math.max(idx, lastIndexOfRegex(text, anchor));

  const slice = idx >= 0 ? text.slice(idx) : text.split("\n").slice(-24).join("\n");
  const lines = slice
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line));

  const joined = lines
    .slice(0, 18)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return joined;
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

