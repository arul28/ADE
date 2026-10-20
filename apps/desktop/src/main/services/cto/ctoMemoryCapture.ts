import { clipText } from "../shared/utils";
import { CTO_MEMORY_FACT_KINDS, type CtoMemoryFactKind } from "./ctoMemoryService";

/**
 * The CTO's automatic memory pass: what ADE asks a cheap helper model, and how
 * it reads the answer. Also the deterministic snapshot a compaction or switch
 * writes before that pass can run.
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

/** Heading that separates a deterministic snapshot from the model-written summary above it. */
const CONTINUITY_SNAPSHOT_HEADING = "Recent continuity snapshot:";

/** How many live facts the helper is shown so it does not file them again. */
export const CAPTURE_KNOWN_FACTS = 40;

const CAPTURE_ENTRIES = 40;
const SNAPSHOT_ENTRIES = 12;
// The whole snapshot has to fit the thread state's injected head (3,000
// chars, less the file's own header), or the newest turns are the ones cut.
const SNAPSHOT_TOTAL_MAX_CHARS = 2_800;
const SNAPSHOT_PREVIOUS_MAX_CHARS = 1_200;
const USER_ENTRY_MAX_CHARS = 800;
const ASSISTANT_ENTRY_MAX_CHARS = 1_200;
const TRANSCRIPT_MAX_CHARS = 16_000;
const KNOWN_FACTS_MAX_CHARS = 4_000;
const PREVIOUS_SUMMARY_MAX_CHARS = 2_500;

const flatClip = (text: string, max: number): string => clipText(text.replace(/\s+/g, " "), max);

/**
 * The conversation as the helper reads it: newest entries kept, each one
 * clipped so a single long answer cannot crowd out the turns around it.
 */
export function formatCaptureTranscript(entries: ContinuityCaptureEntry[], maxChars = TRANSCRIPT_MAX_CHARS): string {
  const lines: string[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const body = flatClip(entry.text, entry.role === "user" ? USER_ENTRY_MAX_CHARS : ASSISTANT_ENTRY_MAX_CHARS);
    if (!body) continue;
    const line = `${entry.role === "user" ? "User" : "CTO"}: ${body}`;
    if (lines.length && total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.reverse().join("\n");
}

/** The model-written part of a continuity summary, without an appended snapshot. */
function modelWrittenContinuity(summary: string | null | undefined): string {
  const text = summary?.trim() ?? "";
  const at = text.indexOf(CONTINUITY_SNAPSHOT_HEADING);
  return (at === -1 ? text : text.slice(0, at)).trim().slice(0, PREVIOUS_SUMMARY_MAX_CHARS);
}

/**
 * The deterministic continuity snapshot: the newest turns, each clipped,
 * behind whatever the last model-written summary knew.
 *
 * Both halves matter. It used to be the last twenty entries verbatim and
 * nothing else, so every compaction replaced a good summary of what the
 * thread is FOR with a raw copy of what was just said.
 */
export function buildContinuitySnapshot(
  entries: ContinuityCaptureEntry[],
  previousSummary: string | null | undefined,
): string | null {
  const previous = clipText(modelWrittenContinuity(previousSummary), SNAPSHOT_PREVIOUS_MAX_CHARS);
  const budget = SNAPSHOT_TOTAL_MAX_CHARS - previous.length - CONTINUITY_SNAPSHOT_HEADING.length - 3;
  const recent = formatCaptureTranscript(entries.slice(-SNAPSHOT_ENTRIES), budget).trim();
  if (!recent.length) return null;
  return [previous, `${CONTINUITY_SNAPSHOT_HEADING}\n${recent}`].filter((part) => part.length).join("\n\n");
}

export function buildContinuityCapturePrompt(args: {
  reason: string;
  entries: ContinuityCaptureEntry[];
  knownFacts: string[];
  previousSummary: string | null | undefined;
}): string {
  const known = args.knownFacts.map((fact) => `- ${fact}`).join("\n").slice(0, KNOWN_FACTS_MAX_CHARS);
  const previous = modelWrittenContinuity(args.previousSummary);
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
    formatCaptureTranscript(args.entries.slice(-CAPTURE_ENTRIES)),
  ].join("\n");
}

const FACT_LINE = new RegExp(`^[-*•]\\s*(?:\\*\\*)?(${CTO_MEMORY_FACT_KINDS.join("|")})(?:\\*\\*)?\\s*[:—-]\\s*(.+)$`, "i");

/**
 * Read the helper's answer. Tolerant of the usual drift (markdown headings,
 * bold labels, text on the label's own line) and strict where it matters: no
 * SUMMARY label means no summary, and a fact line without a known kind is
 * dropped rather than guessed at.
 */
export function parseContinuityCapture(raw: string): ContinuityCapture {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { summary: null, facts: [] };
  const lines = text.split("\n");
  // A label line, with anything written after its colon kept as content.
  const labelRest = (line: string, label: string): string | null => {
    const match = new RegExp(`^[#*\\s]*${label}[*\\s]*(?::[*\\s]*(.*))?$`, "i").exec(line.trim());
    return match ? (match[1] ?? "").trim() : null;
  };
  const durableAt = lines.findIndex((line) => labelRest(line, "durable") !== null);
  const summaryAt = lines.findIndex((line) => labelRest(line, "summary") !== null);
  // No SUMMARY label means the model did not do the job (a refusal, a chatty
  // reply). That must not replace the last good summary.
  const summary = summaryAt === -1
    ? ""
    : [labelRest(lines[summaryAt], "summary") ?? "", ...lines.slice(summaryAt + 1, durableAt > summaryAt ? durableAt : lines.length)]
      .join("\n").trim();
  const facts: ContinuityCapture["facts"] = [];
  if (durableAt !== -1) {
    for (const line of [labelRest(lines[durableAt], "durable") ?? "", ...lines.slice(durableAt + 1)]) {
      const match = FACT_LINE.exec(line.trim());
      if (!match) continue;
      const body = match[2].trim().replace(/^\*\*|\*\*$/g, "").trim();
      if (!body || /^none\.?$/i.test(body)) continue;
      facts.push({ kind: match[1].toLowerCase() as CtoMemoryFactKind, text: body });
    }
  }
  return { summary: summary.length ? summary : null, facts };
}
