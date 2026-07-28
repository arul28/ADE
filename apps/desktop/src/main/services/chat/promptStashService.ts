import { randomUUID } from "node:crypto";
import {
  MAX_PROMPT_STASH_ATTACHMENTS,
  MAX_PROMPT_STASHES,
  type AgentChatFileRef,
  type PromptStashEntry,
} from "../../../shared/types/chat";
import type { AdeDb } from "../state/kvDb";

export { MAX_PROMPT_STASHES };
export const MAX_PROMPT_STASH_TEXT_CHARS = 200_000;
export { MAX_PROMPT_STASH_ATTACHMENTS };
export const MAX_PROMPT_STASH_ATTACHMENT_PATH_CHARS = 8_192;

type PromptStashRow = {
  id: string;
  text: string;
  attachments_json: string;
  attachment_origin_site_id: string | null;
  provider: string | null;
  model_id: string | null;
  created_at: string;
};

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeAttachments(value: unknown): AgentChatFileRef[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_PROMPT_STASH_ATTACHMENTS) {
    throw new Error(`A prompt stash can include at most ${MAX_PROMPT_STASH_ATTACHMENTS} attachments.`);
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Prompt stash attachments are invalid.");
    }
    const attachment = candidate as Partial<AgentChatFileRef>;
    const path = typeof attachment.path === "string" ? attachment.path.trim() : "";
    if (!path || path.length > MAX_PROMPT_STASH_ATTACHMENT_PATH_CHARS) {
      throw new Error("Prompt stash attachment path is invalid.");
    }
    if (attachment.type === "image-url") {
      const url = typeof attachment.url === "string" ? attachment.url.trim() : "";
      if (!url || url !== path || url.length > MAX_PROMPT_STASH_ATTACHMENT_PATH_CHARS) {
        throw new Error("Prompt stash image URL is invalid.");
      }
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new Error("Prompt stash image URL is invalid.");
      }
      if (protocol !== "https:" && protocol !== "http:") {
        throw new Error("Prompt stash image URL is invalid.");
      }
      return { path: url, type: "image-url", url };
    }
    if (attachment.type !== "image") {
      throw new Error("Prompt stash attachment type is invalid.");
    }
    return { path, type: "image" };
  });
}

function parseAttachments(json: string): AgentChatFileRef[] {
  try {
    return normalizeAttachments(JSON.parse(json));
  } catch {
    return [];
  }
}

type PromptStashSiteDb = Pick<AdeDb, "get"> & Partial<Pick<AdeDb, "sync">>;

function normalizeSiteId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function currentSiteId(db: PromptStashSiteDb): string | null {
  try {
    const siteId = normalizeSiteId(db.sync?.getSiteId());
    if (siteId) return siteId;
  } catch {
    // Fall through to the SQL read for narrow test/runtime adapters.
  }
  try {
    return normalizeSiteId(db.get<{ site_id: string }>(
      "select lower(hex(crsql_site_id())) as site_id",
    )?.site_id);
  } catch {
    return null;
  }
}

function fromRow(row: PromptStashRow, localSiteId: string | null): PromptStashEntry {
  const storedAttachments = parseAttachments(row.attachments_json);
  const originMatches = Boolean(
    localSiteId
    && normalizeSiteId(row.attachment_origin_site_id) === localSiteId,
  );
  const attachments = storedAttachments.filter((attachment) => (
    attachment.type !== "image" || originMatches
  ));
  return {
    id: row.id,
    text: row.text,
    attachments,
    attachmentCount: storedAttachments.length,
    attachmentsAvailable: attachments.length === storedAttachments.length,
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
      select id, text, attachments_json, attachment_origin_site_id, provider, model_id, created_at
      from prompt_stashes
      order by created_at desc, id desc
      limit ?
    `,
    [safeLimit],
  ).map((row) => fromRow(row, currentSiteId(db)));
}

export function listPromptStashAttachmentPaths(
  db: Pick<AdeDb, "get" | "all"> & Partial<Pick<AdeDb, "sync">>,
): Set<string> {
  const localSiteId = currentSiteId(db);
  if (!localSiteId) return new Set();
  const rows = db.all<Pick<PromptStashRow, "attachments_json" | "attachment_origin_site_id">>(
    `
      select attachments_json, attachment_origin_site_id
      from prompt_stashes
    `,
  );
  return new Set(rows.flatMap((row) => (
    normalizeSiteId(row.attachment_origin_site_id) === localSiteId
      ? parseAttachments(row.attachments_json)
      .filter((attachment) => attachment.type === "image")
      .map((attachment) => attachment.path)
      : []
  )));
}

export function createPromptStash(
  db: AdeDb,
  value: unknown,
): PromptStashEntry {
  const args = objectRecord(value);
  const text = typeof args.text === "string" ? args.text : "";
  const attachments = normalizeAttachments(args.attachments);
  const attachmentOriginSiteId = attachments.some((attachment) => attachment.type === "image")
    ? currentSiteId(db)
    : null;
  if (!text.trim() && attachments.length === 0) {
    throw new Error("A prompt stash cannot be empty.");
  }
  if (text.length > MAX_PROMPT_STASH_TEXT_CHARS) {
    throw new Error("This prompt is too large to stash.");
  }

  const entry: PromptStashEntry = {
    id: randomUUID(),
    text,
    attachments,
    attachmentCount: attachments.length,
    attachmentsAvailable: true,
    provider: optionalString(args.provider),
    modelId: optionalString(args.modelId),
    createdAt: nextCreatedAt(db),
  };
  db.run(
    `
      insert into prompt_stashes(
        id, text, attachments_json, attachment_origin_site_id, provider, model_id, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      entry.id,
      entry.text,
      JSON.stringify(entry.attachments),
      attachmentOriginSiteId,
      entry.provider,
      entry.modelId,
      entry.createdAt,
    ],
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
