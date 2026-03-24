// ---------------------------------------------------------------------------
// Episode Format — shared parsing and formatting for episodic memory content.
//
// Episodic memories use a dual-format: human-readable text followed by
// structured JSON in an HTML comment (<!--episode:{...}-->). Legacy entries
// store only raw JSON. This module handles both.
// ---------------------------------------------------------------------------

export type EpisodicMemoryFields = {
  id?: string;
  sessionId?: string;
  missionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome?: string;
  toolsUsed?: string[];
  patternsDiscovered?: string[];
  gotchas?: string[];
  decisionsMade?: string[];
  duration?: number;
  createdAt?: string;
  fileScopePattern?: string;
};

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueLines(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter((value) => value.length > 0))];
}

/**
 * Parse episodic memory content, supporting both the current dual-format
 * (human text + JSON comment) and the legacy raw-JSON format.
 */
export function parseEpisode(content: string): EpisodicMemoryFields | null {
  // Current format: human-readable text with JSON in HTML comment
  const commentMatch = content.match(/<!--episode:([\s\S]*?)-->/);
  if (commentMatch) {
    try {
      const parsed = JSON.parse(commentMatch[1]) as EpisodicMemoryFields;
      if (parsed && typeof parsed === "object"
        && typeof parsed.taskDescription === "string"
        && typeof parsed.approachTaken === "string") {
        return parsed;
      }
    } catch { /* fall through to legacy format */ }
  }

  // Legacy format: raw JSON content
  try {
    const parsed = JSON.parse(content) as EpisodicMemoryFields;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.taskDescription !== "string" || typeof parsed.approachTaken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Format an episodic memory as human-readable text with structured JSON
 * preserved in an HTML comment for downstream parsers.
 */
export function formatEpisodeContent(episode: EpisodicMemoryFields): string {
  const lines: string[] = [];
  const taskDescription = cleanText(episode.taskDescription);
  const approachTaken = cleanText(episode.approachTaken);

  if (taskDescription) lines.push(taskDescription);
  if (approachTaken && approachTaken !== taskDescription) {
    lines.push(`Approach: ${approachTaken}`);
  }

  const outcome = cleanText(episode.outcome);
  if (outcome && outcome !== "partial") lines.push(`Outcome: ${outcome}`);

  const patterns = uniqueLines(episode.patternsDiscovered ?? []);
  if (patterns.length > 0) lines.push(`Patterns: ${patterns.join("; ")}`);

  const gotchas = uniqueLines(episode.gotchas ?? []);
  if (gotchas.length > 0) lines.push(`Pitfalls: ${gotchas.join("; ")}`);

  const decisions = uniqueLines(episode.decisionsMade ?? []);
  if (decisions.length > 0) lines.push(`Decisions: ${decisions.join("; ")}`);

  lines.push(`\n<!--episode:${JSON.stringify(episode)}-->`);
  return lines.join("\n");
}
