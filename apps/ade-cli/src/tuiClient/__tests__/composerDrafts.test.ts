import { describe, expect, it } from "vitest";
import {
  NEW_CHAT_DRAFT_KEY,
  clearComposerDraft,
  composerDraftKey,
  createComposerDraftStore,
  deleteImageTokenBackward,
  deleteImageTokenForward,
  expandImageTokensForSend,
  findImageTokens,
  formatImageToken,
  formatUserMessageTranscriptBody,
  imageTokenAtCursor,
  insertImageToken,
  isComposerDraftEmpty,
  readComposerDraft,
  referencedAttachmentPaths,
  retainReferencedAttachments,
  saveComposerDraft,
  sanitizeImageTokenLabel,
  sessionHasDraft,
  shortenImageTokensInText,
  uniqueImageTokenLabel,
} from "../composerDrafts";
import { deletePromptBackward, deletePromptForKey, deletePromptForward } from "../app";

const shot = { label: "shot.png", path: "/tmp/ade/shot.png" };
const other = { label: "other.png", path: "/tmp/ade/other.png" };

describe("per-session draft store", () => {
  it("keeps each session's draft separate and restores it on return", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "half written a", cursor: 4, attachments: [] });
    saveComposerDraft(store, "chat-b", { text: "b thoughts", cursor: 10, attachments: [] });

    expect(readComposerDraft(store, "chat-a")).toEqual({ text: "half written a", cursor: 4, attachments: [] });
    expect(readComposerDraft(store, "chat-b").text).toBe("b thoughts");
  });

  it("gives the new-chat surface its own key, distinct from any session", () => {
    const store = createComposerDraftStore();
    expect(composerDraftKey(null)).toBe(NEW_CHAT_DRAFT_KEY);
    expect(composerDraftKey("chat-a")).toBe("chat-a");

    saveComposerDraft(store, null, { text: "new chat idea", cursor: 3, attachments: [] });
    expect(readComposerDraft(store, null).text).toBe("new chat idea");
    expect(readComposerDraft(store, "chat-a").text).toBe("");
  });

  it("reports an empty draft for a session that was never visited", () => {
    const store = createComposerDraftStore();
    expect(readComposerDraft(store, "never-seen")).toEqual({ text: "", cursor: 0, attachments: [] });
    expect(sessionHasDraft(store, "never-seen")).toBe(false);
  });

  it("sessionHasDraft answers what a draft-indicator glyph needs", () => {
    const store = createComposerDraftStore();
    expect(sessionHasDraft(store, "chat-a")).toBe(false);
    saveComposerDraft(store, "chat-a", { text: "wip", cursor: 3, attachments: [] });
    expect(sessionHasDraft(store, "chat-a")).toBe(true);
    saveComposerDraft(store, "chat-a", { text: "", cursor: 0, attachments: [] });
    expect(sessionHasDraft(store, "chat-a")).toBe(false);
  });

  it("does not retain an entry for an emptied draft", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "wip", cursor: 3, attachments: [] });
    saveComposerDraft(store, "chat-a", { text: "", cursor: 0, attachments: [] });
    expect(store.size).toBe(0);
  });

  it("clamps a restored cursor into the draft text", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "abc", cursor: 99, attachments: [] });
    expect(readComposerDraft(store, "chat-a").cursor).toBe(3);
  });

  it("clears a draft on send", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "sent", cursor: 4, attachments: [] });
    clearComposerDraft(store, "chat-a");
    expect(sessionHasDraft(store, "chat-a")).toBe(false);
  });

  it("hands back a copy so a caller cannot mutate the stash", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: formatImageToken("shot.png"), cursor: 0, attachments: [shot] });
    readComposerDraft(store, "chat-a").attachments.push(other);
    expect(readComposerDraft(store, "chat-a").attachments).toHaveLength(1);
  });

  it("treats an attachment-only draft as non-empty", () => {
    expect(isComposerDraftEmpty({ text: "", cursor: 0, attachments: [] })).toBe(true);
    expect(isComposerDraftEmpty({ text: "", cursor: 0, attachments: [shot] })).toBe(false);
  });
});

describe("image attachments never leak across chats", () => {
  it("keeps a pasted image with the draft it was pasted into", () => {
    const store = createComposerDraftStore();
    const text = insertImageToken("look at ", 8, "shot.png").value;
    saveComposerDraft(store, "chat-a", { text, cursor: text.length, attachments: [shot] });

    // Chat B never saw the paste.
    expect(readComposerDraft(store, "chat-b").attachments).toEqual([]);
    expect(readComposerDraft(store, "chat-b").text).toBe("");
    // Chat A still has it on return.
    expect(readComposerDraft(store, "chat-a").attachments).toEqual([shot]);
  });

  it("drops an attachment whose token the user deleted", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "no token here", cursor: 0, attachments: [shot] });
    expect(readComposerDraft(store, "chat-a").attachments).toEqual([]);
    expect(sessionHasDraft(store, "chat-a")).toBe(true); // text remains
  });

  it("retainReferencedAttachments keeps only what the text still references", () => {
    const text = `a ${formatImageToken("shot.png")} b`;
    expect(retainReferencedAttachments(text, [shot, other])).toEqual([shot]);
  });
});

describe("image token text model", () => {
  it("formats a compact self-delimiting tag", () => {
    expect(formatImageToken("png")).toBe("⟦image:png⟧");
    expect(formatImageToken(uniqueImageTokenLabel([], "pasted-screenshot-1.png"))).toBe("⟦image:png⟧");
  });

  it("strips characters that would break token scanning", () => {
    expect(sanitizeImageTokenLabel("a⟧b\nc")).toBe("abc");
    expect(sanitizeImageTokenLabel("   ")).toBe("image");
  });

  it("uses the extension as the chip kind and disambiguates repeats", () => {
    expect(uniqueImageTokenLabel([], "shot.png")).toBe("png");
    expect(uniqueImageTokenLabel(["png"], "shot.png")).toBe("png2");
    expect(uniqueImageTokenLabel(["png", "png2"], "shot.png")).toBe("png3");
    expect(uniqueImageTokenLabel(["png"], "photo.jpg")).toBe("jpg");
    expect(uniqueImageTokenLabel([], "photo.JPEG")).toBe("jpg");
    expect(uniqueImageTokenLabel(["readme"], "readme")).toBe("readme2");
  });

  it("finds every token with exact offsets", () => {
    const text = `a ${formatImageToken("png")} b ${formatImageToken("jpg")}`;
    const tokens = findImageTokens(text);
    expect(tokens.map((token) => token.label)).toEqual(["png", "jpg"]);
    for (const token of tokens) {
      expect(text.slice(token.start, token.end)).toBe(formatImageToken(token.label));
    }
  });

  it("still scans the older spaced tag form", () => {
    const tokens = findImageTokens("a ⟦image: shot.png⟧ b");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.label).toBe("shot.png");
  });

  it("ignores lookalike text that is not a token", () => {
    expect(findImageTokens("image: shot.png")).toEqual([]);
    expect(findImageTokens("⟦image: unterminated")).toEqual([]);
  });

  it("inserts at the caret with separating spaces", () => {
    expect(insertImageToken("", 0, "png").value).toBe("⟦image:png⟧ ");
    expect(insertImageToken("see", 3, "png").value).toBe("see ⟦image:png⟧ ");
    expect(insertImageToken("see ", 4, "png").value).toBe("see ⟦image:png⟧ ");
  });

  it("puts the caret after the inserted token", () => {
    const result = insertImageToken("see", 3, "png");
    expect(result.value.slice(0, result.cursor)).toBe("see ⟦image:png⟧ ");
  });

  it("inserts mid-text without disturbing what follows", () => {
    const result = insertImageToken("before after", 7, "png");
    expect(result.value).toBe("before ⟦image:png⟧ after");
  });
});

describe("caret / token interaction", () => {
  const text = `see ${formatImageToken("shot.png")} ok`; // token spans [4, 22)

  it("detects the caret anywhere on the token", () => {
    const token = findImageTokens(text)[0]!;
    expect(imageTokenAtCursor(text, token.start)?.label).toBe("shot.png");
    expect(imageTokenAtCursor(text, token.start + 3)?.label).toBe("shot.png");
    expect(imageTokenAtCursor(text, token.end)?.label).toBe("shot.png");
  });

  it("reports no token when the caret is in ordinary prose", () => {
    expect(imageTokenAtCursor(text, 1)).toBeNull();
    expect(imageTokenAtCursor(text, text.length)).toBeNull();
    expect(imageTokenAtCursor("plain prose", 4)).toBeNull();
  });
});

describe("whole-token deletion (mirrors URL chip deletion)", () => {
  const text = `see ${formatImageToken("shot.png")} ok`;
  const token = findImageTokens(text)[0]!;

  it("backspace inside the token removes the whole token", () => {
    for (const cursor of [token.start + 1, token.start + 8, token.end]) {
      const result = deleteImageTokenBackward(text, cursor);
      expect(result).toEqual({ value: "see  ok", cursor: token.start });
    }
  });

  it("delete inside the token removes the whole token", () => {
    for (const cursor of [token.start, token.start + 5, token.end - 1]) {
      const result = deleteImageTokenForward(text, cursor);
      expect(result).toEqual({ value: "see  ok", cursor: token.start });
    }
  });

  it("leaves ordinary characters to the normal delete path", () => {
    expect(deleteImageTokenBackward(text, 2)).toBeNull();
    expect(deleteImageTokenForward(text, text.length)).toBeNull();
  });

  it("is wired into the prompt Backspace/Delete handlers", () => {
    // Backspace with the caret just past the token.
    expect(deletePromptBackward(text, token.end)).toEqual({ value: "see  ok", cursor: token.start });
    // Delete with the caret at the token start.
    expect(deletePromptForward(text, token.start)).toEqual({ value: "see  ok", cursor: token.start });
    expect(deletePromptForKey(text, token.end, { backspace: true })).toEqual({ value: "see  ok", cursor: token.start });
    expect(deletePromptForKey(text, token.start, { delete: true })).toEqual({ value: "see  ok", cursor: token.start });
  });

  it("still deletes one character at a time outside a token", () => {
    expect(deletePromptBackward("abc", 3)).toEqual({ value: "ab", cursor: 2 });
  });

  it("removes only the token the caret is on", () => {
    const two = `${formatImageToken("one.png")} ${formatImageToken("two.png")}`;
    const second = findImageTokens(two)[1]!;
    expect(deletePromptBackward(two, second.end).value).toBe(`${formatImageToken("one.png")} `);
  });
});

describe("draft round-trip across a session switch", () => {
  /**
   * Mirrors the save/restore the app performs in selectActiveSessionId, so the
   * end-to-end promise ("switch away, come back, your draft and its image are
   * still there; the other chat never sees them") is covered without rendering
   * the whole TUI.
   */
  function switchSession(
    store: ReturnType<typeof createComposerDraftStore>,
    from: string | null,
    to: string | null,
    live: { text: string; cursor: number; attachments: typeof shot[] },
  ) {
    saveComposerDraft(store, from, live);
    return readComposerDraft(store, to);
  }

  it("restores text, caret and image attachment on return", () => {
    const store = createComposerDraftStore();
    const text = `look ${formatImageToken("shot.png")}`;
    const live = { text, cursor: 4, attachments: [shot] };

    const intoB = switchSession(store, "chat-a", "chat-b", live);
    expect(intoB).toEqual({ text: "", cursor: 0, attachments: [] });

    const backToA = switchSession(store, "chat-b", "chat-a", { text: "", cursor: 0, attachments: [] });
    expect(backToA).toEqual({ text, cursor: 4, attachments: [shot] });
  });

  it("does not carry a pasted image into the next chat", () => {
    const store = createComposerDraftStore();
    const withImage = { text: formatImageToken("shot.png"), cursor: 0, attachments: [shot] };
    const intoB = switchSession(store, "chat-a", "chat-b", withImage);
    expect(referencedAttachmentPaths(intoB.text, intoB.attachments)).toEqual([]);
  });

  it("keeps the new-chat draft separate from the chat it launches into", () => {
    const store = createComposerDraftStore();
    switchSession(store, null, "chat-a", { text: "draft surface text", cursor: 5, attachments: [] });
    expect(readComposerDraft(store, "chat-a").text).toBe("");
    expect(readComposerDraft(store, null).text).toBe("draft surface text");
  });

  it("leaves nothing behind after the draft is sent", () => {
    const store = createComposerDraftStore();
    saveComposerDraft(store, "chat-a", { text: "about to send", cursor: 3, attachments: [shot] });
    clearComposerDraft(store, "chat-a");
    expect(readComposerDraft(store, "chat-a")).toEqual({ text: "", cursor: 0, attachments: [] });
    expect(sessionHasDraft(store, "chat-a")).toBe(false);
  });
});

describe("send-time expansion", () => {
  const attachments = [shot, other];

  it("replaces the chip with a path the agent can open", () => {
    const text = `look at ${formatImageToken("shot.png")} please`;
    expect(expandImageTokensForSend(text, attachments)).toBe("look at /tmp/ade/shot.png please");
  });

  it("expands several tokens in one prompt", () => {
    const text = `${formatImageToken("shot.png")} vs ${formatImageToken("other.png")}`;
    expect(expandImageTokensForSend(text, attachments)).toBe("/tmp/ade/shot.png vs /tmp/ade/other.png");
  });

  it("leaves prompts without tokens byte-identical", () => {
    expect(expandImageTokensForSend("nothing to see", attachments)).toBe("nothing to see");
    expect(expandImageTokensForSend("", attachments)).toBe("");
  });

  it("degrades an unresolvable token to its label rather than dropping text", () => {
    const text = `see ${formatImageToken("gone.png")}`;
    expect(expandImageTokensForSend(text, attachments)).toBe("see gone.png");
  });

  it("still supplies the structured attachment envelope for the same tokens", () => {
    const text = `${formatImageToken("other.png")} and ${formatImageToken("shot.png")}`;
    // Order follows the text, so the envelope matches what the prose references.
    expect(referencedAttachmentPaths(text, attachments)).toEqual([other.path, shot.path]);
  });

  it("omits attachments whose token is not in the outgoing text", () => {
    expect(referencedAttachmentPaths("no tokens", attachments)).toEqual([]);
  });

  it("does not duplicate a path referenced twice", () => {
    const text = `${formatImageToken("shot.png")} ${formatImageToken("shot.png")}`;
    expect(referencedAttachmentPaths(text, attachments)).toEqual([shot.path]);
  });
});

describe("transcript image chips", () => {
  it("rewrites a long pasted-filename token to the compact chip", () => {
    expect(shortenImageTokensInText("see ⟦image: pasted-screenshot-1.png⟧")).toBe("see ⟦image:png⟧");
    expect(shortenImageTokensInText("see ⟦image:png⟧")).toBe("see ⟦image:png⟧");
  });

  it("appends compact chips for desktop-originated attachments that live only on the envelope", () => {
    expect(formatUserMessageTranscriptBody({
      text: "hello",
      displayText: "hello",
      attachments: [{ path: "/tmp/pasted-screenshot-1.png", type: "image" }],
    })).toBe("hello\n⟦image:png⟧");
  });

  it("replaces expanded send-time paths with compact chips", () => {
    expect(formatUserMessageTranscriptBody({
      text: "look at /tmp/ade/shot.png please",
      attachments: [{ path: "/tmp/ade/shot.png", type: "image" }],
    })).toBe("look at ⟦image:png⟧ please");
  });

  it("numbers a second image of the same kind", () => {
    expect(formatUserMessageTranscriptBody({
      text: "compare",
      attachments: [
        { path: "/tmp/a.png", type: "image" },
        { path: "/tmp/b.png", type: "image" },
      ],
    })).toBe("compare\n⟦image:png⟧ ⟦image:png2⟧");
  });

  it("leaves a text-only user message unchanged", () => {
    expect(formatUserMessageTranscriptBody({ text: "hello" })).toBe("hello");
  });
});
