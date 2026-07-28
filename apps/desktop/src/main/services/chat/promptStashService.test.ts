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
