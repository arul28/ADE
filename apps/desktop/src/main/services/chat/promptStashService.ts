import { randomUUID } from "node:crypto";
import {
  MAX_PROMPT_STASHES,
  type PromptStashCreateArgs,
  type PromptStashEntry,
} from "../../../shared/types/chat";
import type { AdeDb } from "../state/kvDb";

export { MAX_PROMPT_STASHES };
export const MAX_PROMPT_STASH_TEXT_CHARS = 200_000;

type PromptStashRow = {
  id: string;
  text: string;
  provider: string | null;
  model_id: string | null;
  created_at: string;
};

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function fromRow(row: PromptStashRow): PromptStashEntry {
  return {
    id: row.id,
    text: row.text,
    provider: row.provider,
    modelId: row.model_id,
    createdAt: row.created_at,
  };
}

function nextCreatedAt(db: AdeDb): string {
  const latest = db.get<{ created_at: string }>(
    "select created_at from prompt_stashes order by created_at desc limit 1",
  )?.created_at;
  const latestTimestamp = latest ? Date.parse(latest) : Number.NaN;
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(latestTimestamp) ? latestTimestamp + 1 : 0,
  )).toISOString();
}

export function listPromptStashes(
  db: AdeDb,
  limit = MAX_PROMPT_STASHES,
): PromptStashEntry[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : MAX_PROMPT_STASHES;
  const safeLimit = Math.max(1, Math.min(MAX_PROMPT_STASHES, normalizedLimit));
  return db.all<PromptStashRow>(
    `
      select id, text, provider, model_id, created_at
      from prompt_stashes
      order by created_at desc, id desc
      limit ?
    `,
    [safeLimit],
  ).map(fromRow);
}

export function createPromptStash(
  db: AdeDb,
  args: PromptStashCreateArgs,
): PromptStashEntry {
  const text = typeof args?.text === "string" ? args.text : "";
  if (!text.trim()) {
    throw new Error("A prompt stash cannot be empty.");
  }
  if (text.length > MAX_PROMPT_STASH_TEXT_CHARS) {
    throw new Error("This prompt is too large to stash.");
  }

  const entry: PromptStashEntry = {
    id: randomUUID(),
    text,
    provider: optionalString(args.provider),
    modelId: optionalString(args.modelId),
    createdAt: nextCreatedAt(db),
  };
  db.run(
    `
      insert into prompt_stashes(id, text, provider, model_id, created_at)
      values (?, ?, ?, ?, ?)
    `,
    [entry.id, entry.text, entry.provider, entry.modelId, entry.createdAt],
  );

  db.run(
    `
      delete from prompt_stashes
      where id in (
        select id
        from prompt_stashes
        order by created_at desc, id desc
        limit -1 offset ?
      )
    `,
    [MAX_PROMPT_STASHES],
  );
  return entry;
}

export function deletePromptStash(db: AdeDb, id: string): boolean {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Prompt stash id is required.");
  }
  const existing = db.get<{ id: string }>(
    "select id from prompt_stashes where id = ? limit 1",
    [normalizedId],
  );
  if (!existing) return false;
  db.run("delete from prompt_stashes where id = ?", [normalizedId]);
  return true;
}
