import { describe, expect, it } from "vitest";

import {
  ensureAdePrTranscriptGistLinks,
  hasAdePrTranscriptGistLinks,
  renderAdePrTranscriptGistLinks,
} from "./adePrTranscriptGists";

describe("renderAdePrTranscriptGistLinks", () => {
  it("renders escaped transcript links with message counts", () => {
    const block = renderAdePrTranscriptGistLinks([
      {
        title: "Chat [review]",
        url: "https://gist.github.com/octo/gist 1)",
        provider: "codex[cli]",
        entryCount: 2,
      },
    ]);

    expect(block).toContain("<!-- ade:transcript-gists v=1 count=1 -->");
    expect(block).toContain("## ADE chat transcripts");
    expect(block).toContain("[ADE chat transcripts](https://gist.github.com/octo/gist%201%29)");
    expect(block).toContain("codex\\[cli\\] | 2 messages");
    expect(block).toContain("<!-- /ade:transcript-gists -->");
  });
});

describe("ensureAdePrTranscriptGistLinks", () => {
  it("inserts transcript links before the ADE deeplink footer", () => {
    const body = [
      "Summary",
      "",
      "<!-- ade:link v=1 type=pr repo=a/b branch=f num=1 -->",
      "Open in ADE",
      "<!-- /ade:link -->",
      "",
    ].join("\n");
    const next = ensureAdePrTranscriptGistLinks(body, [
      { title: "Chat", url: "https://gist.github.com/octo/gist-1", provider: "codex", entryCount: 1 },
    ]);

    expect(next.indexOf("## ADE chat transcripts")).toBeGreaterThan(next.indexOf("Summary"));
    expect(next.indexOf("## ADE chat transcripts")).toBeLessThan(next.indexOf("<!-- ade:link"));
  });

  it("replaces an existing transcript block in place", () => {
    const initial = ensureAdePrTranscriptGistLinks("Summary\n", [
      { title: "Old", url: "https://gist.github.com/octo/old" },
    ]);
    const updated = ensureAdePrTranscriptGistLinks(initial, [
      { title: "New", url: "https://gist.github.com/octo/new" },
    ]);

    expect((updated.match(/<!-- ade:transcript-gists v=1/gi) ?? [])).toHaveLength(1);
    expect(updated).toContain("https://gist.github.com/octo/new");
    expect(updated).not.toContain("https://gist.github.com/octo/old");
  });
});

describe("hasAdePrTranscriptGistLinks", () => {
  it("detects a present marker", () => {
    expect(
      hasAdePrTranscriptGistLinks("body\n\n<!-- ade:transcript-gists v=1 count=1 -->"),
    ).toBe(true);
  });

  it("returns false for missing markers", () => {
    expect(hasAdePrTranscriptGistLinks("body")).toBe(false);
    expect(hasAdePrTranscriptGistLinks(null)).toBe(false);
    expect(hasAdePrTranscriptGistLinks(undefined)).toBe(false);
  });
});
