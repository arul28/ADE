import { describe, expect, it } from "vitest";

import { composerAtFileRankFields, rankComposerAtMenuItems } from "./composerAtMenuRanking";
import type { ChatMentionSuggestion } from "./types/chatMentions";

const chat = (over: Partial<ChatMentionSuggestion> & { id: string; title: string }): ChatMentionSuggestion => ({
  kind: "chat",
  lastActivityAt: 10,
  ...over,
});

const lane = (over: Partial<ChatMentionSuggestion> & { id: string; title: string }): ChatMentionSuggestion => ({
  kind: "lane",
  lastActivityAt: 10,
  ...over,
});

describe("composerAtFileRankFields", () => {
  it("splits POSIX and Windows paths on the last separator", () => {
    expect(composerAtFileRankFields("apps/desktop/src/shared/chatMentions.ts")).toEqual({
      title: "chatMentions.ts",
      subtitle: "apps/desktop/src/shared/",
    });
    expect(composerAtFileRankFields("apps\\desktop\\src\\shared\\chatMentions.ts")).toEqual({
      title: "chatMentions.ts",
      subtitle: "apps\\desktop\\src\\shared\\",
    });
    expect(composerAtFileRankFields("README.md")).toEqual({
      title: "README.md",
      subtitle: "",
    });
  });
});

describe("rankComposerAtMenuItems", () => {
  it("ranks an exact chat title above a vaguely matching file path", () => {
    const ranked = rankComposerAtMenuItems(
      [{ path: "apps/desktop/src/shared/chatMentions.ts" }],
      [chat({ id: "c1", title: "chat", lastActivityAt: 1 })],
      "chat",
      10,
    );
    expect(ranked[0]).toEqual({
      type: "mention",
      mention: expect.objectContaining({ id: "c1", kind: "chat" }),
    });
    expect(ranked[1]).toEqual({ type: "file", path: "apps/desktop/src/shared/chatMentions.ts" });
  });

  it("ranks a matching lane above a file that only hits in a directory segment", () => {
    const ranked = rankComposerAtMenuItems(
      [{ path: "docs/features/chat/README.md" }],
      [lane({ id: "l1", title: "chat mention tags", lastActivityAt: 1 })],
      "chat mention",
      10,
    );
    expect(ranked[0]).toMatchObject({ mention: { id: "l1" } });
    expect(ranked.filter((item) => item.type === "file")).toHaveLength(1);
  });

  it("lets a better file basename beat a weakly matching chat", () => {
    const ranked = rankComposerAtMenuItems(
      [{ path: "src/login.ts" }],
      [chat({ id: "c1", title: "Unrelated chore", subtitle: "login-fix", lastActivityAt: 900 })],
      "login.ts",
      10,
    );
    expect(ranked[0]).toEqual({ type: "file", path: "src/login.ts" });
  });

  it("mixes kinds by recency when the query is empty", () => {
    const ranked = rankComposerAtMenuItems(
      [{ path: "README.md" }],
      [
        chat({ id: "old", title: "Old chat", lastActivityAt: 10 }),
        lane({ id: "new-lane", title: "Fresh lane", lastActivityAt: 50 }),
      ],
      "",
      10,
    );
    expect(ranked.map((item) => {
      if (item.type === "file") return item.path;
      return item.mention.id;
    })).toEqual(["new-lane", "old", "README.md"]);
  });

  it("does not group by kind: a title match sits above matching files", () => {
    const ranked = rankComposerAtMenuItems(
      [
        { path: "src/auth.ts" },
        { path: "src/auth.test.ts" },
      ],
      [
        chat({ id: "auth-chat", title: "auth", lastActivityAt: 20 }),
        lane({ id: "other", title: "something else", lastActivityAt: 90 }),
      ],
      "auth",
      10,
    );
    expect(ranked[0]).toMatchObject({ type: "mention", mention: { id: "auth-chat", kind: "chat" } });
    expect(ranked.filter((item) => item.type === "file")).toHaveLength(2);
    expect(ranked.some((item) => item.type === "mention" && item.mention.kind === "lane")).toBe(false);
  });
});
