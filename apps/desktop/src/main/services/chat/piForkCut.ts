import { sessionEntryChain } from "./sessionEntryChain";

/**
 * Where "Fork from here" cuts a Pi session: the entry just before the prompt
 * of the first turn the fork leaves out.
 *
 * Pi keeps a session as a tree of entries (`id`/`parentId`); the conversation
 * a session resumes is the chain from its last entry back to the root. ADE
 * knows the turn by the text it sent, which can carry ADE context ahead of
 * what the user typed, so a prompt matches by its end, and `ordinal` picks
 * among prompts that end the same way (0 = the first).
 *
 * - `cut`: fork through `entryId`.
 * - `first_turn`: the prompt opens the session; there is nothing before it.
 * - `not_found`: no prompt on the chain matches.
 */
export type PiForkCut =
  | { kind: "cut"; entryId: string }
  | { kind: "first_turn" }
  | { kind: "not_found" };

type PiEntry = { id: string; parentId: string | null; userText: string | null };

function userTextOf(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "user") return null;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return null;
  return record.content
    .map((block) => (block && typeof block === "object" && (block as Record<string, unknown>).type === "text"
      ? String((block as Record<string, unknown>).text ?? "")
      : ""))
    .join("");
}

function parseEntries(jsonl: string): PiEntry[] {
  const entries: PiEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    // The header (`type: "session"`) has no id and is not part of the tree.
    if (typeof record.id !== "string" || !record.id || record.type === "session") continue;
    entries.push({
      id: record.id,
      parentId: typeof record.parentId === "string" && record.parentId ? record.parentId : null,
      userText: record.type === "message" ? userTextOf(record.message) : null,
    });
  }
  return entries;
}

export function piForkCutBeforePrompt(jsonl: string, promptText: string, ordinal: number): PiForkCut {
  const chain = sessionEntryChain(parseEntries(jsonl), (entry) => entry.id, (entry) => entry.parentId);
  const wanted = promptText.trim();
  if (!wanted) return { kind: "not_found" };
  const matches = chain
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.userText != null && entry.userText.trim().endsWith(wanted));
  const match = matches[Math.max(0, ordinal)];
  if (!match) return { kind: "not_found" };
  const previous = chain[match.index - 1];
  return previous ? { kind: "cut", entryId: previous.id } : { kind: "first_turn" };
}
