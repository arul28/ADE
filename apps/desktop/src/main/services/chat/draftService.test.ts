import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import {
  claimDraft,
  createDraft,
  deleteDraft,
  listDraftAttachmentPaths,
  listDrafts,
  listDueScheduledDrafts,
  listScheduledDrafts,
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_TEXT_CHARS,
  MAX_DRAFTS,
  MAX_SCHEDULED_DRAFTS,
  setDraftStatus,
  updateDraft,
} from "./draftService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function insertSyncedDrafts(
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

describe("draftService", () => {
  let root: string;
  let db: AdeDb;

  // Opening the database is the slow part (~1 s each), so the suite shares one
  // and empties the table between tests.
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-drafts-"));
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
    const created = createDraft(db, {
      text: "  Fix the parser.\nThen run tests.  ",
      provider: " codex ",
      modelId: " openai/gpt-5.4 ",
    });

    expect(created).toMatchObject({
      text: "  Fix the parser.\nThen run tests.  ",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    });
    expect(listDrafts(db)).toEqual([created]);
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
    const created = createDraft(db, {
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

    expect(listDrafts(db)).toEqual([
      expect.objectContaining({
        id: created.id,
        attachments: visible,
        attachmentCount: 2,
        attachmentsAvailable: available,
      }),
    ]);
    expect(listDraftAttachmentPaths(db)).toEqual(
      new Set(available ? [localImage.path] : []),
    );
  });

  it("rejects empty, excessively large, and malformed stashes", () => {
    expect(() => createDraft(db, { text: " \n\t " })).toThrow("cannot be empty");
    expect(() => createDraft(db, {
      text: "x".repeat(MAX_DRAFT_TEXT_CHARS + 1),
    })).toThrow("too large");
    expect(() => createDraft(db, {
      text: "bad attachment",
      attachments: [{ path: "javascript:alert(1)", type: "image-url", url: "javascript:alert(1)" }],
    })).toThrow("image URL is invalid");
    expect(() => createDraft(db, {
      text: "too many",
      attachments: Array.from({ length: MAX_DRAFT_ATTACHMENTS + 1 }, (_, index) => ({
        path: `/project/image-${index}.png`,
        type: "image" as const,
      })),
    })).toThrow("at most");
    expect(listDrafts(db)).toEqual([]);
  });

  it("keeps only the newest twenty entries", () => {
    const created = Array.from({ length: MAX_DRAFTS + 3 }, (_, index) =>
      createDraft(db, { text: `prompt ${index}` }));

    expect(listDrafts(db).map((entry) => entry.id))
      .toEqual(created.slice(3).map((entry) => entry.id).reverse());
  });

  it("prunes synchronized overflow before returning a bounded list", () => {
    const olderTimestamp = "2026-07-28T12:00:00.000Z";
    const newerTimestamp = "2026-07-28T12:00:01.000Z";
    for (let index = 0; index < MAX_DRAFTS + 3; index += 1) {
      insertSyncedDrafts(db, {
        id: `synced-${String(index).padStart(2, "0")}`,
        createdAt: index === 0 ? olderTimestamp : newerTimestamp,
      });
    }

    const listed = listDrafts(db, 5);
    const retainedIds = db.all<{ id: string }>(
      "select id from prompt_stashes order by created_at desc, id desc",
    ).map((row) => row.id);

    expect(listed.map((entry) => entry.id)).toEqual(retainedIds.slice(0, 5));
    expect(retainedIds).toHaveLength(MAX_DRAFTS);
    expect(retainedIds.filter((id) => ["synced-00", "synced-01", "synced-02"].includes(id))).toEqual([]);
    // A non-finite limit falls back to the bounded default.
    expect(listDrafts(db, Number.NaN)).toHaveLength(MAX_DRAFTS);
  });

  it("prunes synchronized overflow before protecting live attachment paths", () => {
    const inserted = Array.from(
      { length: MAX_DRAFTS + 3 },
      (_, index) => ({
        id: `synced-image-${String(index).padStart(2, "0")}`,
        createdAt: new Date(Date.parse("2026-07-28T12:00:00.000Z") + index).toISOString(),
        attachmentPath: path.join(root, ".ade", "attachments", `image-${index}.png`),
      }),
    );
    inserted.forEach((entry) => insertSyncedDrafts(db, entry));

    const protectedPaths = listDraftAttachmentPaths(db);
    const retainedIds = db.all<{ id: string }>(
      "select id from prompt_stashes order by created_at desc, id desc",
    ).map((row) => row.id);

    expect(retainedIds).toHaveLength(MAX_DRAFTS);
    expect(protectedPaths).toEqual(new Set(
      inserted.slice(-MAX_DRAFTS).map((entry) => entry.attachmentPath),
    ));
  });

  it("deletes atomically and reports already-consumed stashes", () => {
    const created = createDraft(db, { text: "restore me" });

    expect(deleteDraft(db, created.id)).toBe(true);
    expect(deleteDraft(db, created.id)).toBe(false);
    expect(listDrafts(db)).toEqual([]);
  });

  it("keeps the synced table compatible with CRR conversion", () => {
    const blockingUniqueIndexes = db
      .all<{ unique: number; origin: string }>("pragma index_list('prompt_stashes')")
      .filter((index) => Number(index.unique) === 1 && index.origin !== "pk");

    expect(blockingUniqueIndexes).toEqual([]);
  });

  describe("scheduled sends", () => {
    const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const schedule = (overrides: Record<string, unknown> = {}) => ({
      scheduledAt: inAnHour(),
      targetKind: "existing" as const,
      targetSessionId: "chat-1",
      ...overrides,
    });

    it("arms a draft and reports it as scheduled", () => {
      const created = createDraft(db, {
        text: "check the migration",
        schedule: schedule({ deliveryPolicy: "strict" }),
      });

      expect(created).toMatchObject({
        kind: "scheduled",
        status: "scheduled",
        targetKind: "existing",
        targetSessionId: "chat-1",
        deliveryPolicy: "strict",
      });
      expect(listScheduledDrafts(db).map((entry) => entry.id)).toEqual([created.id]);
      // A plain draft list still shows it: the row is one drafts list with a state.
      expect(listDrafts(db).map((entry) => entry.id)).toContain(created.id);
    });

    // The failure this feature exists to prevent: an armed send must not be
    // pushed out by a flood of ordinary drafts.
    it("never prunes an armed send, however many plain drafts arrive", () => {
      const armed = createDraft(db, { text: "keep me", schedule: schedule() });
      for (let index = 0; index < MAX_DRAFTS + 5; index += 1) {
        createDraft(db, { text: `plain ${index}` });
      }

      expect(listScheduledDrafts(db).map((entry) => entry.id)).toEqual([armed.id]);
      expect(db.get<{ id: string }>(
        "select id from prompt_stashes where id = ?",
        [armed.id],
      )).not.toBeNull();
    });

    it("refuses a schedule that is in the past, too far out, or has no target", () => {
      expect(() => createDraft(db, {
        text: "late",
        schedule: schedule({ scheduledAt: new Date(Date.now() - 1000).toISOString() }),
      })).toThrow("must be set in the future");
      expect(() => createDraft(db, {
        text: "far",
        schedule: schedule({ scheduledAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() }),
      })).toThrow("more than a year away");
      expect(() => createDraft(db, {
        text: "nowhere",
        schedule: { scheduledAt: inAnHour(), targetKind: "existing" },
      })).toThrow("Choose the chat");
      expect(() => createDraft(db, {
        text: "nowhere",
        schedule: { scheduledAt: inAnHour(), targetKind: "new" },
      })).toThrow("Choose the lane");
      expect(listDrafts(db)).toEqual([]);
    });

    it("caps armed sends without silently dropping one", () => {
      for (let index = 0; index < MAX_SCHEDULED_DRAFTS; index += 1) {
        createDraft(db, { text: `armed ${index}`, schedule: schedule() });
      }

      // A refusal, not a prune: every already-armed send is still there.
      expect(() => createDraft(db, { text: "one too many", schedule: schedule() }))
        .toThrow(`at most ${MAX_SCHEDULED_DRAFTS} scheduled sends`);
      expect(listScheduledDrafts(db)).toHaveLength(MAX_SCHEDULED_DRAFTS);
    });

    it("retimes, clears, and edits a scheduled draft in place", () => {
      const created = createDraft(db, { text: "v1", schedule: schedule() });
      const later = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

      const retimed = updateDraft(db, {
        id: created.id,
        text: "v2",
        schedule: schedule({ scheduledAt: later }),
      });
      expect(retimed).toMatchObject({ text: "v2", kind: "scheduled", scheduledAt: later });

      const cleared = updateDraft(db, { id: created.id, unschedule: true });
      expect(cleared).toMatchObject({ kind: "draft", status: "draft", scheduledAt: null });
      expect(listScheduledDrafts(db)).toEqual([]);
    });

    it("reports a draft taken on another machine instead of claiming it twice", () => {
      const created = createDraft(db, { text: "restore me" });

      const first = claimDraft(db, created.id);
      expect(first?.text).toBe("restore me");
      // The loser must not be handed the text: that is the double-send guard.
      expect(claimDraft(db, created.id)).toBeNull();
      expect(listDrafts(db)).toEqual([]);
    });

    it("fires only the rows due on this machine", () => {
      const twoHoursOut = Date.now() + 2 * 60 * 60 * 1000;
      const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // No machine target: machine-agnostic, so it fires wherever it is due.
      const anywhere = createDraft(db, { text: "anywhere", schedule: schedule({ scheduledAt: soon }) });
      const onStudio = createDraft(db, {
        text: "studio only",
        schedule: schedule({ scheduledAt: later, targetMachineKey: "studio" }),
      });
      createDraft(db, {
        text: "laptop only",
        schedule: schedule({ scheduledAt: later, targetMachineKey: "laptop" }),
      });
      createDraft(db, {
        text: "not yet",
        schedule: schedule({
          scheduledAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          targetMachineKey: "studio",
        }),
      });

      expect(listDueScheduledDrafts(db, "studio", twoHoursOut).map((entry) => entry.id))
        .toEqual([anywhere.id, onStudio.id]);
      expect(listDueScheduledDrafts(db, "laptop", twoHoursOut).map((entry) => entry.text))
        .toEqual(["anywhere", "laptop only"]);
      // A runtime with no machine key still fires untargeted rows only.
      expect(listDueScheduledDrafts(db, null, twoHoursOut).map((entry) => entry.text))
        .toEqual(["anywhere"]);
      expect(listDueScheduledDrafts(db, "studio", Date.now()).map((entry) => entry.text))
        .toEqual([]);
    });

    it("records a terminal status without losing the row", () => {
      const created = createDraft(db, { text: "sent", schedule: schedule() });
      setDraftStatus(db, created.id, { status: "sent", firedAt: new Date().toISOString() });

      const stored = db.get<{ status: string; fired_at: string | null }>(
        "select status, fired_at from prompt_stashes where id = ?",
        [created.id],
      );
      expect(stored?.status).toBe("sent");
      expect(stored?.fired_at).toBeTruthy();
    });

    // Machine keys reach this host from three different places, so a row
    // targeted at "  StUdIo  " must still fire on a host named "studio".
    it("matches a target machine key regardless of casing or padding", () => {
      const twoHoursOut = Date.now() + 2 * 60 * 60 * 1000;
      const created = createDraft(db, {
        text: "padded target",
        schedule: schedule({
          scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          targetMachineKey: "  StUdIo  ",
        }),
      });

      expect(listDueScheduledDrafts(db, "studio", twoHoursOut).map((entry) => entry.id))
        .toEqual([created.id]);
      expect(listDueScheduledDrafts(db, "laptop", twoHoursOut)).toEqual([]);
    });
  });
});
