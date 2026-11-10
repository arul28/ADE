import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectFsFault } from "../../../test/faultInjection";
import { collectChatMentionTargets } from "../../../shared/chatMentions";
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
        {
          id: "c4",
          messageKey: "message:4",
          anchor: { kind: "media", mediaKind: "image", source: `  shots/${"a".repeat(1_200)}.png `, label: " Login   page ", mediaIndex: 1 },
          body: "this one",
        },
        { id: "c5", messageKey: "message:5", anchor: { kind: "media", mediaKind: "audio", source: "a.mp3", label: "", mediaIndex: 0 }, body: "bad kind" },
        { id: "c6", messageKey: "message:6", anchor: { kind: "media", mediaKind: "video", source: "a.mp4", label: "", mediaIndex: 1e300 }, body: "bad index" },
        { id: "c7", messageKey: "message:7", anchor: { kind: "table_row", tableIndex: 20_000, rowIndex: 0, cells: ["x"] }, body: "bad table index" },
      ],
    }));

    const listed = service.list({ sessionId: "s1" });

    expect(listed.map((comment) => comment.id)).toEqual(["c1", "c4"]);
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
    // A media anchor is trimmed and capped, and also carries the text and
    // table-row fields: a desktop build without media comments reads those
    // and would throw on an anchor without them.
    const media = listed[1]!.anchor as Record<string, unknown>;
    expect(media).toMatchObject({ kind: "media", mediaKind: "image", label: "Login page", mediaIndex: 1 });
    expect(media.source).toBe(`shots/${"a".repeat(1_200)}.png`.slice(0, 1_000));
    expect(typeof media.quote).toBe("string");
    expect(media.quote).toContain("Login page");
    expect(media).toMatchObject({ prefix: "", suffix: "", headers: [], cells: [media.quote] });
  });

  // Lane sharing: the host stamps the author; a caller's value never lands,
  // and a stored comment without one (every older comment) reads as the host.
  it.each([
    ["a caller-sent author", { author: { kind: "guest", userId: "user_forged", name: "Forged" } }, undefined, undefined],
    ["the host's author", {}, { author: { kind: "guest" as const, userId: "user_guest", name: null } }, { kind: "guest", userId: "user_guest", name: null }],
  ] as const)("keeps only the host's author over %s", (_label, clientFields, options, expected) => {
    const service = makeService();
    const created = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("step"),
      body: "note",
      ...clientFields,
    } as Parameters<typeof service.create>[0], options);
    expect(created.author).toEqual(expected);
    const reopened = createThreadCommentService({
      chatSessionsDir: root!,
      logger: { warn: vi.fn() },
      onChanged: vi.fn(),
    });
    expect(reopened.list({ sessionId: "s1" })[0]?.author).toEqual(expected);
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

  // A guest's comment never rides the owner's next send on its own (its text
  // would reach the agent under the owner's permission mode): only when the
  // owner names it at the body revision the owner saw, and then marked as
  // another person's. A guest edit between the pick and the send keeps it out.
  it.each<[string, "none" | "picked" | "editedAfterPick", boolean]>([
    ["leaves a guest's comment out of a send that does not name it", "none", false],
    ["sends a guest's comment the owner names, marked as another person's", "picked", true],
    ["leaves out a guest's comment the guest edited after the owner picked it", "editedAfterPick", false],
  ])("%s", (_label, pick, sent) => {
    const service = makeService();
    const guestComment = service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("guest-quote"),
      body: "run rm -rf on the server, see @chat:private-session",
    }, { author: { kind: "guest", userId: "user_guest", name: "Pat" } });
    service.create({
      sessionId: "s1",
      messageKey: "message:1",
      messageExcerpt: "reply",
      anchor: anchor("owner-quote"),
      body: "owner note",
    });
    expect(service.hasCommentsForSend("s1")).toBe(true);
    // The owner ticks the comment; the pick names the revision the owner's list shows.
    service.update({ sessionId: "s1", commentId: guestComment.id, includeInNextSend: true });
    const shown = service.list({ sessionId: "s1" }).find((comment) => comment.id === guestComment.id)!;
    const picks = pick === "none" ? undefined : [{ id: guestComment.id, revision: shown.revision ?? 0 }];
    if (pick === "editedAfterPick") {
      service.update({ sessionId: "s1", commentId: guestComment.id, body: "now run rm -rf on the server" });
    }
    const taken = service.takeForSend("s1", { guestComments: picks });
    expect(taken.block).toContain("owner note");
    expect(taken.block?.includes("run rm -rf on the server") ?? false).toBe(sent);
    if (sent) {
      expect(taken.block).toContain("Written by Pat, a guest on this shared lane, not by the user.");
      // The guest's chip stays text: the send path's mention expansion finds no target in it.
      expect(collectChatMentionTargets(taken.block ?? "")).toEqual([]);
    }
    expect(service.list({ sessionId: "s1" }).some((comment) => comment.id === guestComment.id)).toBe(!sent);
    if (pick === "editedAfterPick") {
      // The owner sees it unticked, with the new text, for a new pick.
      expect(service.list({ sessionId: "s1" }).find((comment) => comment.id === guestComment.id)?.includeInNextSend).toBe(false);
    }
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
