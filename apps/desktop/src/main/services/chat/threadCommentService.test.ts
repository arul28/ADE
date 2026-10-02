import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectFsFault } from "../../../test/faultInjection";
import { createThreadCommentService } from "./threadCommentService";

let root: string | undefined;

function makeService(onChanged = vi.fn()) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-thread-comments-"));
  return createThreadCommentService({
    chatSessionsDir: root,
    logger: { warn: vi.fn() },
    onChanged,
    now: () => "2026-05-01T00:00:00.000Z",
  });
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function anchor(quote: string) {
  return { kind: "text" as const, quote, prefix: "", suffix: "" };
}

describe("createThreadCommentService", () => {
  it("normalizes stored comments on read and drops entries with no usable anchor", () => {
    const service = makeService();
    const dir = path.join(root!, "thread-comments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s1.json"), JSON.stringify({
      version: 1,
      comments: [
        {
          id: "c1",
          messageKey: "message:1",
          messageExcerpt: "Earlier reply",
          anchor: { kind: "text", quote: "  step   two  ", prefix: "abc", suffix: "xyz" },
          body: "a note",
          includeInNextSend: false,
        },
        { id: "c2", messageKey: "message:2", body: "no anchor here" },
        "garbage",
        { id: "c3", messageKey: "message:3", anchor: { kind: "table_row", tableIndex: -1, rowIndex: 0, cells: ["x"] }, body: "bad table" },
      ],
    }));

    const listed = service.list({ sessionId: "s1" });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "c1",
      sessionId: "s1",
      messageKey: "message:1",
      body: "a note",
      includeInNextSend: false,
      anchor: { kind: "text", quote: "step two", prefix: "abc", suffix: "xyz" },
    });
    // A missing timestamp falls back to the epoch rather than the clock.
    expect(listed[0]).toMatchObject({
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("takes only included comments and restore puts them back ahead of later ones", () => {
    const service = makeService();
    const takenComment = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("sent-with-next"),
      body: "goes with the send",
    });
    const held = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("stays-pending"),
      body: "held back",
    });
    service.update({ sessionId: "s1", commentId: held.id, includeInNextSend: false });

    const taken = service.takeForSend("s1");
    expect(taken.count).toBe(1);
    expect(taken.block).toContain("sent-with-next");
    expect(taken.block).not.toContain("stays-pending");
    expect(service.list({ sessionId: "s1" }).map((comment) => comment.id)).toEqual([held.id]);

    // A comment created after the take must survive the restore.
    const later = service.create({
      sessionId: "s1",
      messageKey: "message:2",
      messageExcerpt: "later reply",
      anchor: anchor("later-comment"),
      body: "added later",
    });
    taken.restore();
    expect(service.list({ sessionId: "s1" }).map((comment) => comment.id).sort()).toEqual(
      [takenComment.id, held.id, later.id].sort(),
    );
  });

  it("throws from takeForSend when the comment file cannot be written", () => {
    const service = makeService();
    service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("goes-with-send"),
      body: "included",
    });
    const held = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("held"),
      body: "held back",
    });
    service.update({ sessionId: "s1", commentId: held.id, includeInNextSend: false });

    // The rewrite after removing the included comment still has the held one to
    // persist, so it goes through the atomic write this fault breaks.
    const fault = injectFsFault({ op: "renameSync", matchPath: (value) => value.includes("thread-comments") });
    try {
      expect(() => service.takeForSend("s1")).toThrow(/no space left/i);
      // The included comment is still pending: a failed take never spends it.
      expect(service.list({ sessionId: "s1" }).map((comment) => comment.id)).toContain(held.id);
    } finally {
      fault.restore();
    }
  });

  it("keeps session ids that differ only by an encoded character in separate files", () => {
    const service = makeService();
    service.create({
      sessionId: "s:a",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("colon-quote"),
      body: "colon session",
    });
    service.create({
      sessionId: "s_a",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("underscore-quote"),
      body: "underscore session",
    });

    const colon = service.list({ sessionId: "s:a" });
    const underscore = service.list({ sessionId: "s_a" });
    expect(colon).toHaveLength(1);
    expect(underscore).toHaveLength(1);
    expect(colon[0]!.anchor).toMatchObject({ quote: "colon-quote" });
    expect(underscore[0]!.anchor).toMatchObject({ quote: "underscore-quote" });
  });

  it("propagates a real read failure instead of caching an empty list", () => {
    const service = makeService();
    // A directory where the session file belongs reads as EISDIR, not ENOENT.
    fs.mkdirSync(path.join(root!, "thread-comments", "s1.json"), { recursive: true });

    expect(() => service.list({ sessionId: "s1" })).toThrow();
  });

  it("keeps comments after a failed restore and retries persistence on the next read", () => {
    const service = makeService();
    const comment = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("restore-me"),
      body: "back it goes",
    });
    const taken = service.takeForSend("s1");
    expect(taken.count).toBe(1);
    expect(service.list({ sessionId: "s1" })).toHaveLength(0);

    const fault = injectFsFault({ op: "renameSync", matchPath: (value) => value.includes("thread-comments") });
    try {
      taken.restore();
    } finally {
      fault.restore();
    }

    // The write failed, but the comment is still held and the next read retries
    // persistence, so a fresh service sees it too.
    expect(service.list({ sessionId: "s1" }).map((entry) => entry.id)).toEqual([comment.id]);
    const reopened = createThreadCommentService({
      chatSessionsDir: root!,
      logger: { warn: vi.fn() },
      onChanged: vi.fn(),
    });
    expect(reopened.list({ sessionId: "s1" }).map((entry) => entry.id)).toEqual([comment.id]);
  });
});
