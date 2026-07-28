import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import {
  createPromptStash,
  deletePromptStash,
  listPromptStashAttachmentPaths,
  listPromptStashes,
  MAX_PROMPT_STASHES,
  MAX_PROMPT_STASH_ATTACHMENTS,
  MAX_PROMPT_STASH_TEXT_CHARS,
} from "./promptStashService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function insertSyncedPromptStash(
  db: AdeDb,
  entry: {
    id: string;
    createdAt: string;
    attachmentPath?: string;
  },
): void {
  db.run(
    `
      insert into prompt_stashes(
        id, text, attachments_json, attachment_origin_site_id, provider, model_id, created_at
      )
      values (?, ?, ?, ?, null, null, ?)
    `,
    [
      entry.id,
      entry.id,
      JSON.stringify(entry.attachmentPath
        ? [{ path: entry.attachmentPath, type: "image" }]
        : []),
      entry.attachmentPath ? db.sync.getSiteId() : null,
      entry.createdAt,
    ],
  );
}

describe("promptStashService", () => {
  let root: string;
  let db: AdeDb;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prompt-stash-"));
    fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
    db = await openKvDb(path.join(root, ".ade", "ade.db"), createLogger() as never);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("preserves prompt text exactly and keeps source metadata", () => {
    const created = createPromptStash(db, {
      text: "  Fix the parser.\nThen run tests.  ",
      provider: " codex ",
      modelId: " openai/gpt-5.4 ",
    });

    expect(created).toMatchObject({
      text: "  Fix the parser.\nThen run tests.  ",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    });
    expect(listPromptStashes(db)).toEqual([created]);
  });

  it("persists runtime-owned attachments for connected desktops", () => {
    const attachments = [
      { path: "/project/.ade/attachments/design.png", type: "image" as const },
      { path: "https://example.com/reference.png", type: "image-url" as const, url: "https://example.com/reference.png" },
    ];

    const created = createPromptStash(db, { text: "", attachments });

    expect(created.attachments).toEqual(attachments);
    expect(listPromptStashes(db)).toEqual([created]);
    expect(listPromptStashAttachmentPaths(db)).toEqual(new Set([attachments[0]!.path]));
  });

  it("does not expose or consume machine-bound image paths on another synced runtime", () => {
    const image = { path: "/source/.ade/attachments/design.png", type: "image" as const };
    const created = createPromptStash(db, { text: "Use this design", attachments: [image] });
    db.run(
      "update prompt_stashes set attachment_origin_site_id = ? where id = ?",
      ["different-runtime", created.id],
    );

    expect(listPromptStashes(db)).toEqual([
      expect.objectContaining({
        id: created.id,
        attachments: [],
        attachmentCount: 1,
        attachmentsAvailable: false,
      }),
    ]);
    expect(listPromptStashAttachmentPaths(db)).toEqual(new Set());
  });

  it("normalizes site ids before deciding whether machine-bound images are local", () => {
    const image = { path: "/source/.ade/attachments/design.png", type: "image" as const };
    const created = createPromptStash(db, { text: "Use this design", attachments: [image] });
    db.run(
      "update prompt_stashes set attachment_origin_site_id = ? where id = ?",
      [` \n${db.sync.getSiteId().toUpperCase()}\t `, created.id],
    );

    expect(listPromptStashes(db)).toEqual([
      expect.objectContaining({
        id: created.id,
        attachments: [image],
        attachmentCount: 1,
        attachmentsAvailable: true,
      }),
    ]);
    expect(listPromptStashAttachmentPaths(db)).toEqual(new Set([image.path]));
  });

  it("keeps portable image URLs while withholding cross-site image paths", () => {
    const localImage = { path: "/source/.ade/attachments/design.png", type: "image" as const };
    const portableImage = {
      path: "https://example.com/reference.png",
      type: "image-url" as const,
      url: "https://example.com/reference.png",
    };
    const created = createPromptStash(db, {
      text: "Compare these designs",
      attachments: [localImage, portableImage],
    });
    db.run(
      "update prompt_stashes set attachment_origin_site_id = ? where id = ?",
      ["different-runtime", created.id],
    );

    expect(listPromptStashes(db)).toEqual([
      expect.objectContaining({
        id: created.id,
        attachments: [portableImage],
        attachmentCount: 2,
        attachmentsAvailable: false,
      }),
    ]);
    expect(listPromptStashAttachmentPaths(db)).toEqual(new Set());
  });

  it("rejects empty, excessively large, and malformed stashes", () => {
    expect(() => createPromptStash(db, { text: " \n\t " })).toThrow("cannot be empty");
    expect(() => createPromptStash(db, {
      text: "x".repeat(MAX_PROMPT_STASH_TEXT_CHARS + 1),
    })).toThrow("too large");
    expect(() => createPromptStash(db, {
      text: "bad attachment",
      attachments: [{ path: "javascript:alert(1)", type: "image-url", url: "javascript:alert(1)" }],
    })).toThrow("image URL is invalid");
    expect(() => createPromptStash(db, {
      text: "too many",
      attachments: Array.from({ length: MAX_PROMPT_STASH_ATTACHMENTS + 1 }, (_, index) => ({
        path: `/project/image-${index}.png`,
        type: "image" as const,
      })),
    })).toThrow("at most");
    expect(listPromptStashes(db)).toEqual([]);
  });

  it("keeps only the newest twenty entries", () => {
    const created = Array.from({ length: MAX_PROMPT_STASHES + 3 }, (_, index) =>
      createPromptStash(db, { text: `prompt ${index}` }));

    const listed = listPromptStashes(db);
    expect(listed).toHaveLength(MAX_PROMPT_STASHES);
    expect(listed.map((entry) => entry.id)).not.toContain(created[0]?.id);
    expect(listed.map((entry) => entry.id)).not.toContain(created[1]?.id);
    expect(listed.map((entry) => entry.id)).not.toContain(created[2]?.id);
  });

  it("prunes synchronized overflow before returning a bounded list", () => {
    const olderTimestamp = "2026-07-28T12:00:00.000Z";
    const newerTimestamp = "2026-07-28T12:00:01.000Z";
    for (let index = 0; index < MAX_PROMPT_STASHES + 3; index += 1) {
      insertSyncedPromptStash(db, {
        id: `synced-${String(index).padStart(2, "0")}`,
        createdAt: index === 0 ? olderTimestamp : newerTimestamp,
      });
    }

    const listed = listPromptStashes(db, 5);
    const retainedIds = db.all<{ id: string }>(
      "select id from prompt_stashes order by created_at desc, id desc",
    ).map((row) => row.id);

    expect(listed.map((entry) => entry.id)).toEqual(retainedIds.slice(0, 5));
    expect(retainedIds).toHaveLength(MAX_PROMPT_STASHES);
    expect(retainedIds).not.toContain("synced-00");
    expect(retainedIds).not.toContain("synced-01");
    expect(retainedIds).not.toContain("synced-02");
  });

  it("prunes synchronized overflow before protecting live attachment paths", () => {
    const inserted = Array.from(
      { length: MAX_PROMPT_STASHES + 3 },
      (_, index) => ({
        id: `synced-image-${String(index).padStart(2, "0")}`,
        createdAt: new Date(Date.parse("2026-07-28T12:00:00.000Z") + index).toISOString(),
        attachmentPath: path.join(root, ".ade", "attachments", `image-${index}.png`),
      }),
    );
    inserted.forEach((entry) => insertSyncedPromptStash(db, entry));

    const protectedPaths = listPromptStashAttachmentPaths(db);
    const retainedIds = db.all<{ id: string }>(
      "select id from prompt_stashes order by created_at desc, id desc",
    ).map((row) => row.id);

    expect(retainedIds).toHaveLength(MAX_PROMPT_STASHES);
    expect(protectedPaths).toEqual(new Set(
      inserted.slice(-MAX_PROMPT_STASHES).map((entry) => entry.attachmentPath),
    ));
    expect(protectedPaths.has(inserted[0]!.attachmentPath)).toBe(false);
    expect(protectedPaths.has(inserted[1]!.attachmentPath)).toBe(false);
    expect(protectedPaths.has(inserted[2]!.attachmentPath)).toBe(false);
  });

  it("deletes atomically and reports already-consumed stashes", () => {
    const created = createPromptStash(db, { text: "restore me" });

    expect(deletePromptStash(db, created.id)).toBe(true);
    expect(deletePromptStash(db, created.id)).toBe(false);
    expect(listPromptStashes(db)).toEqual([]);
  });

  it("falls back to the bounded default for a non-finite limit", () => {
    createPromptStash(db, { text: "one" });
    expect(listPromptStashes(db, Number.NaN)).toHaveLength(1);
  });

  it("keeps the synced table compatible with CRR conversion", () => {
    const blockingUniqueIndexes = db
      .all<{ unique: number; origin: string }>("pragma index_list('prompt_stashes')")
      .filter((index) => Number(index.unique) === 1 && index.origin !== "pk");

    expect(blockingUniqueIndexes).toEqual([]);
  });
});
