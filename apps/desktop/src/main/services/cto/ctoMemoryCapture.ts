import { CTO_MEMORY_FACT_KINDS, type CtoMemoryFactKind } from "./ctoMemoryService";

/**
 * The CTO's automatic memory pass: what ADE asks a cheap helper model, and how
 * it reads the answer.
 *
 * The CTO almost never called saveMemory on its own, so the only memory that
 * ever accumulated was what a person typed into MEMORY.md. ADE now decides
 * WHEN to write memory down (a compaction, a provider switch, a retired
 * thread, every few turns) and the helper model decides WHAT. It runs on the
 * vendor the CTO already talks to (Haiku, Luna, Composer, or the chat's own
 * model), from ADE's own transcript, so it works on every provider and on a
 * thread that can no longer take a turn.
 */

export type ContinuityCaptureEntry = {
  role: "user" | "assistant";
  text: string;
};

export type ContinuityCapture = {
  summary: string | null;
  facts: Array<{ text: string; kind: CtoMemoryFactKind }>;
};

const USER_ENTRY_MAX_CHARS = 800;
const ASSISTANT_ENTRY_MAX_CHARS = 1_200;
const TRANSCRIPT_MAX_CHARS = 16_000;
const KNOWN_FACTS_MAX_CHARS = 4_000;
const PREVIOUS_SUMMARY_MAX_CHARS = 2_500;

function clipEntry(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The conversation as the helper reads it: newest entries kept, each one
 * clipped so a single long answer cannot crowd out the turns around it.
 */
export function formatCaptureTranscript(entries: ContinuityCaptureEntry[], maxChars = TRANSCRIPT_MAX_CHARS): string {
  const lines: string[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const body = clipEntry(entry.text, entry.role === "user" ? USER_ENTRY_MAX_CHARS : ASSISTANT_ENTRY_MAX_CHARS);
    if (!body) continue;
    const line = `${entry.role === "user" ? "User" : "CTO"}: ${body}`;
    if (lines.length && total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.reverse().join("\n");
}

export function buildContinuityCapturePrompt(args: {
  reason: string;
  transcript: string;
  knownFacts: string[];
  previousSummary: string | null;
}): string {
  const known = args.knownFacts.map((fact) => `- ${fact}`).join("\n").slice(0, KNOWN_FACTS_MAX_CHARS);
  const previous = args.previousSummary?.trim()
    ? args.previousSummary.trim().slice(0, PREVIOUS_SUMMARY_MAX_CHARS)
    : "";
  return [
    "You keep the memory of a long-running project coordinator chat (the CTO). Read the conversation below and write two sections, exactly in this shape:",
    "",
    "SUMMARY:",
    "- 3 to 8 short lines a fresh copy of the CTO needs to pick the work back up: the current goal, work in flight (name lanes, chats and PRs by name or number), decisions made, and open questions. Present tense. Fold in what is still true from the previous summary.",
    "DURABLE:",
    `- 0 to 5 lines, each \`- <kind>: <one sentence>\`, kind one of ${CTO_MEMORY_FACT_KINDS.join(", ")}. Only things worth knowing weeks from now: decisions, conventions, traps that bit someone, environment facts, and how the user wants work done. Skip progress and status, anything temporary, anything already in KNOWN FACTS, and anything you are not sure the user meant. Write \`- none\` when nothing qualifies.`,
    "",
    "Write nothing else. Never include secrets, tokens, or passwords.",
    "",
    `Why now: ${args.reason}`,
    "",
    "KNOWN FACTS:",
    known || "- none",
    "",
    "PREVIOUS SUMMARY:",
    previous || "(none)",
    "",
    "CONVERSATION (oldest first):",
    args.transcript,
  ].join("\n");
}

const FACT_LINE = new RegExp(`^[-*•]\\s*(?:\\*\\*)?(${CTO_MEMORY_FACT_KINDS.join("|")})(?:\\*\\*)?\\s*[:—-]\\s*(.+)$`, "i");

/**
 * Read the helper's answer. Tolerant of the usual drift (markdown headings,
 * bold labels, a missing SUMMARY label) and strict about facts: a fact line
 * without a known kind is dropped rather than guessed at.
 */
export function parseContinuityCapture(raw: string): ContinuityCapture {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { summary: null, facts: [] };
  const lines = text.split("\n");
  const isLabel = (line: string, label: string): boolean =>
    new RegExp(`^[#*\\s]*${label}[*\\s]*:?[*\\s]*$`, "i").test(line.trim());
  const durableAt = lines.findIndex((line) => isLabel(line, "durable"));
  const summaryAt = lines.findIndex((line) => isLabel(line, "summary"));
  const summaryLines = lines.slice(summaryAt === -1 ? 0 : summaryAt + 1, durableAt === -1 ? lines.length : durableAt);
  const summary = summaryLines.join("\n").trim();
  const facts: ContinuityCapture["facts"] = [];
  if (durableAt !== -1) {
    for (const line of lines.slice(durableAt + 1)) {
      const match = FACT_LINE.exec(line.trim());
      if (!match) continue;
      const body = match[2].trim().replace(/^\*\*|\*\*$/g, "").trim();
      if (!body || /^none\.?$/i.test(body)) continue;
      facts.push({ kind: match[1].toLowerCase() as CtoMemoryFactKind, text: body });
    }
  }
  return { summary: summary.length ? summary : null, facts };
}
