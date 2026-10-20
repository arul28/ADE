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

/* ── nightly gardening ── */

export type GardeningFact = {
  id: string;
  text: string;
  kind: string;
  pinned: boolean;
};

export type GardeningPlan = {
  add: Array<{ text: string; kind: CtoMemoryFactKind }>;
  merge: Array<{ ids: string[]; text: string; kind: CtoMemoryFactKind }>;
  retire: Array<{ id: string; reason: string }>;
};

// A cheap model rewriting memory unattended: each night may change only a
// little, so one bad answer cannot empty the notes.
const GARDENING_MAX_ADDS = 5;
const GARDENING_MAX_MERGES = 5;
const GARDENING_MAX_RETIRES = 3;
const GARDENING_FACT_MAX_CHARS = 300;
const GARDENING_FACTS_MAX_CHARS = 24_000;

/** Short refs (F1, F2, …) a small model copies reliably, unlike UUIDs. */
const gardeningRef = (index: number): string => `F${index + 1}`;

/**
 * The gardener's prompt, and the facts it actually shows. Parse the answer
 * against `shown`, never the full list: a ref past the budget was not seen.
 */
export function buildGardeningPrompt(args: {
  facts: GardeningFact[];
  recentLog: string;
  discoveries: string;
}): { prompt: string; shown: GardeningFact[] } {
  // The newest facts that fit, shown oldest first: new captures are where
  // duplicates pile up, so a long memory must not hide them past the budget.
  const shown: GardeningFact[] = [];
  let total = 0;
  for (let index = args.facts.length - 1; index >= 0; index -= 1) {
    const fact = args.facts[index];
    const size = flatClip(fact.text, GARDENING_FACT_MAX_CHARS).length + fact.kind.length + 20;
    if (total + size > GARDENING_FACTS_MAX_CHARS) break;
    shown.unshift(fact);
    total += size;
  }
  const lines = shown.map((fact, index) =>
    `${gardeningRef(index)} [${fact.kind}${fact.pinned ? ", pinned" : ""}] ${flatClip(fact.text, GARDENING_FACT_MAX_CHARS)}`);
  const prompt = [
    "You tidy the long-term notes of a project coordinator (the CTO). Below are its saved facts, its recent work log, and notes from worker agents. Answer with action lines only, one per line, in exactly these shapes:",
    "",
    `ADD <kind>: <one sentence>   — something durable from the log or worker notes that no fact covers yet (at most ${GARDENING_MAX_ADDS})`,
    `MERGE F3 F7 -> <kind>: <one sentence>   — two or more facts about the same thing, rewritten as one sentence that keeps what still matters (at most ${GARDENING_MAX_MERGES})`,
    `RETIRE F5: <reason>   — a fact the log shows is no longer true: a reversed or replaced decision, including one your own ADD line replaces (at most ${GARDENING_MAX_RETIRES})`,
    "NONE   — when nothing needs doing",
    "",
    `kind is one of ${CTO_MEMORY_FACT_KINDS.join(", ")}. Durable means worth knowing weeks from now: decisions, conventions, traps, environment facts, and how the user wants work done. Never progress or status. Never touch a pinned fact. Retire only when the log clearly contradicts the fact: losing a fact is worse than keeping a redundant one. Never include secrets, tokens, or passwords. Write nothing else.`,
    "",
    "FACTS:",
    lines.join("\n") || "(none)",
    "",
    "RECENT LOG:",
    args.recentLog.trim() || "(empty)",
    "",
    "WORKER NOTES:",
    args.discoveries.trim() || "(none)",
  ].join("\n");
  return { prompt, shown };
}

const KIND_PATTERN = CTO_MEMORY_FACT_KINDS.join("|");
const ADD_LINE = new RegExp(`^ADD\\s+(${KIND_PATTERN})\\s*:\\s*(.+)$`, "i");
const MERGE_LINE = new RegExp(`^MERGE\\s+((?:F\\d+[\\s,]*)+)\\s*(?:->|→)\\s*(${KIND_PATTERN})\\s*:\\s*(.+)$`, "i");
const RETIRE_LINE = /^RETIRE\s+(F\d+)\s*:\s*(.+)$/i;

/**
 * Read the gardener's answer against the facts it was shown. Strict: a line
 * naming a ref that was not shown, or a pinned fact, is dropped; a fact is
 * touched by at most one action; and each action type is capped.
 */
export function parseGardeningPlan(raw: string, facts: GardeningFact[]): GardeningPlan {
  const plan: GardeningPlan = { add: [], merge: [], retire: [] };
  const touched = new Set<string>();
  const resolve = (ref: string): GardeningFact | null => {
    const fact = facts[Number(ref.slice(1)) - 1];
    return fact && !fact.pinned && !touched.has(fact.id) ? fact : null;
  };
  const sentence = (text: string): string => text.trim().replace(/^\*\*|\*\*$/g, "").trim();
  for (const rawLine of raw.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim().replace(/^[-*•]\s*/, "").replace(/`/g, "");
    let match = ADD_LINE.exec(line);
    if (match) {
      const text = sentence(match[2]);
      if (text.length >= 12 && plan.add.length < GARDENING_MAX_ADDS) {
        plan.add.push({ kind: match[1].toLowerCase() as CtoMemoryFactKind, text });
      }
      continue;
    }
    match = MERGE_LINE.exec(line);
    if (match) {
      const text = sentence(match[3]);
      if (text.length < 12 || plan.merge.length >= GARDENING_MAX_MERGES) continue;
      const refs = [...new Set((match[1].match(/F\d+/gi) ?? []).map((ref) => ref.toUpperCase()))];
      const ids: string[] = [];
      for (const ref of refs) {
        const fact = resolve(ref);
        if (fact) ids.push(fact.id);
      }
      if (ids.length < 2 || ids.length !== refs.length) continue;
      ids.forEach((id) => touched.add(id));
      plan.merge.push({ ids, kind: match[2].toLowerCase() as CtoMemoryFactKind, text });
      continue;
    }
    match = RETIRE_LINE.exec(line);
    if (match) {
      const fact = resolve(match[1].toUpperCase());
      const reason = sentence(match[2]);
      if (!fact || !reason || plan.retire.length >= GARDENING_MAX_RETIRES) continue;
      touched.add(fact.id);
      plan.retire.push({ id: fact.id, reason });
    }
  }
  return plan;
}
