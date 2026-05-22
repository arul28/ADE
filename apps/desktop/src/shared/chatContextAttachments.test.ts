import { describe, expect, it } from "vitest";
import {
  buildChatContextAttachmentPrompt,
  chatContextAttachmentKey,
  makePlanCommentContextAttachment,
  normalizeChatContextAttachments,
} from "./chatContextAttachments";

describe("chatContextAttachments plan_comment", () => {
  it("builds a stable key for plan comments", () => {
    const attachment = makePlanCommentContextAttachment({
      lines: [3, 4],
      excerpt: "Spawn worker A",
      comment: "Split validation into its own worker",
    });
    expect(chatContextAttachmentKey(attachment)).toContain("plan:3-4:");
  });

  it("normalizes plan_comment attachments from persisted payloads", () => {
    const normalized = normalizeChatContextAttachments([
      {
        type: "plan_comment",
        lines: [12],
        excerpt: "UI plan",
        comment: "Add rainbow ring to orchestrator chats",
      },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.type).toBe("plan_comment");
  });

  it("includes plan comments in attachment prompt injection", () => {
    const prompt = buildChatContextAttachmentPrompt([
      makePlanCommentContextAttachment({
        lines: [5],
        excerpt: "Backend",
        comment: "Also add IPC for worker spawn",
      }),
    ]);
    expect(prompt).toContain("Attached plan comments");
    expect(prompt).toContain("Also add IPC for worker spawn");
  });
});
