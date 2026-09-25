import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

  // Opening the database is the slow part (~1 s each), so the suite shares one
  // and empties the table between tests.
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prompt-stash-"));
    fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
    db = await openKvDb(path.join(root, ".ade", "ade.db"), createLogger() as never);
  });

  beforeEach(() => {
    db.run("delete from prompt_stashes");
  });

  afterAll(() => {
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

  const localImage = { path: "/source/.ade/attachments/design.png", type: "image" as const };
  const portableImage = {
    path: "https://example.com/reference.png",
    type: "image-url" as const,
    url: "https://example.com/reference.png",
  };

  // A machine-bound image path is only usable on the runtime that stashed it;
  // portable image URLs travel with the synced row.
  it.each([
    ["the stashing runtime", null, [localImage, portableImage], true],
    ["a site id differing only in case and whitespace", "local-padded", [localImage, portableImage], true],
    ["another synced runtime", "different-runtime", [portableImage], false],
  ] as const)("exposes machine-bound images only to %s", (_label, originOverride, visible, available) => {
    const created = createPromptStash(db, {
      text: "Compare these designs",
      attachments: [localImage, portableImage],
    });
    if (originOverride) {
      db.run(
        "update prompt_stashes set attachment_origin_site_id = ? where id = ?",
        [
          originOverride === "local-padded" ? ` \n${db.sync.getSiteId().toUpperCase()}\t ` : originOverride,
          created.id,
        ],
      );
    }

    expect(listPromptStashes(db)).toEqual([
      expect.objectContaining({
        id: created.id,
        attachments: visible,
        attachmentCount: 2,
        attachmentsAvailable: available,
      }),
    ]);
    expect(listPromptStashAttachmentPaths(db)).toEqual(
      new Set(available ? [localImage.path] : []),
    );
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

    expect(listPromptStashes(db).map((entry) => entry.id))
      .toEqual(created.slice(3).map((entry) => entry.id).reverse());
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
    expect(retainedIds.filter((id) => ["synced-00", "synced-01", "synced-02"].includes(id))).toEqual([]);
    // A non-finite limit falls back to the bounded default.
    expect(listPromptStashes(db, Number.NaN)).toHaveLength(MAX_PROMPT_STASHES);
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
  });

  it("deletes atomically and reports already-consumed stashes", () => {
    const created = createPromptStash(db, { text: "restore me" });

    expect(deletePromptStash(db, created.id)).toBe(true);
    expect(deletePromptStash(db, created.id)).toBe(false);
    expect(listPromptStashes(db)).toEqual([]);
  });

  it("keeps the synced table compatible with CRR conversion", () => {
    const blockingUniqueIndexes = db
      .all<{ unique: number; origin: string }>("pragma index_list('prompt_stashes')")
      .filter((index) => Number(index.unique) === 1 && index.origin !== "pk");

    expect(blockingUniqueIndexes).toEqual([]);
  });
});
