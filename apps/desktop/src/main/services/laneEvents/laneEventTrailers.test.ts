import { describe, expect, it } from "vitest";
import { chooseHeadWatchSession, identityFromCoAuthors, parseCoAuthorTrailer } from "./laneEventTrailers";

describe("parseCoAuthorTrailer", () => {
  it("maps the vendor trailers ADE sees in real commits onto providers", () => {
    expect(parseCoAuthorTrailer("Claude Opus 5 <noreply@anthropic.com>")).toEqual({
      provider: "claude",
      model: "Opus 5",
    });
    expect(parseCoAuthorTrailer("Cursor Agent <cursoragent@cursor.com>").provider).toBe("cursor");
    expect(parseCoAuthorTrailer("Codex <noreply@openai.com>").provider).toBe("codex");
    expect(parseCoAuthorTrailer("ChatGPT <bot@example.com>").provider).toBe("codex");
    expect(parseCoAuthorTrailer("Droid <noreply@factory.ai>").provider).toBe("droid");
  });

  it("recognizes a vendor from the email domain when the name does not say it", () => {
    expect(parseCoAuthorTrailer("A Helpful Assistant <noreply@anthropic.com>").provider).toBe("claude");
  });

  it("leaves a bare vendor name without a model rather than inventing an empty one", () => {
    expect(parseCoAuthorTrailer("Claude <noreply@anthropic.com>")).toEqual({ provider: "claude", model: null });
  });

  it("returns no provider for a human co-author", () => {
    expect(parseCoAuthorTrailer("Arul Sharma <arul@example.com>")).toEqual({ provider: null, model: null });
  });

  it("picks the first recognizable provider across several trailers", () => {
    expect(
      identityFromCoAuthors([
        "Arul Sharma <arul@example.com>",
        "Claude Sonnet 5 <noreply@anthropic.com>",
      ]),
    ).toEqual({ provider: "claude", model: "Sonnet 5" });
    expect(identityFromCoAuthors([])).toEqual({ provider: null, model: null });
  });
});

describe("chooseHeadWatchSession", () => {
  it("credits the only mid-flight session", () => {
    expect(chooseHeadWatchSession([{ chatSessionId: "chat-1", lastOutputAt: null }])).toBe("chat-1");
  });

  it("credits the most recently talkative session when a fleet is running", () => {
    expect(
      chooseHeadWatchSession([
        { chatSessionId: "chat-1", lastOutputAt: "2026-08-18T10:00:00.000Z" },
        { chatSessionId: "chat-2", lastOutputAt: "2026-08-18T10:05:00.000Z" },
        { chatSessionId: "chat-3", lastOutputAt: null },
      ]),
    ).toBe("chat-2");
  });

  it("names nobody when no session is mid-flight", () => {
    expect(chooseHeadWatchSession([])).toBeNull();
  });
});
