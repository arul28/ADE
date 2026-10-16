/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  COMPOSER_DRAFT_STORAGE_KEY_PREFIX,
  composerDraftPresence,
  setComposerDraftPresence,
} from "./composerDraftPresenceStore";

describe("composerDraftPresenceStore", () => {
  // First, so it seeds before any live write. The seed runs once per module.
  it("seeds persisted drafts and ignores empty ones", () => {
    const key = (sessionId: string) => `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}:proj:${sessionId}:work:chat`;
    localStorage.setItem(key("sess-full"), JSON.stringify({ text: "hello", attachments: [] }));
    localStorage.setItem(key("sess-empty"), JSON.stringify({ text: "   ", attachments: [] }));
    localStorage.setItem(key("sess-attachments"), JSON.stringify({ text: "", attachments: [{ path: "a.txt" }] }));

    expect(composerDraftPresence("sess-full")).toBe(true);
    expect(composerDraftPresence("sess-empty")).toBe(false);
    expect(composerDraftPresence("sess-attachments")).toBe(true);
    expect(composerDraftPresence("sess-missing")).toBe(false);
    expect(composerDraftPresence(null)).toBe(false);
  });

  it("tracks a live set and clear", () => {
    expect(composerDraftPresence("sess-live")).toBe(false);
    setComposerDraftPresence("sess-live", true);
    expect(composerDraftPresence("sess-live")).toBe(true);
    setComposerDraftPresence("sess-live", false);
    expect(composerDraftPresence("sess-live")).toBe(false);
  });
});
