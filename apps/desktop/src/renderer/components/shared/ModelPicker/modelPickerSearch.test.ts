import { describe, expect, it } from "vitest";

import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        family: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.8 1M",
        subProvider: "GitHub Copilot",
        aliases: ["opus-latest"],
      }),
    ).toBe("claude opus 4.8 1m github copilot opencode opencode opus-latest");
  });
});

describe("scoreModelPickerSearch", () => {
  it("matches typo-tolerant multi-token queries", () => {
    expect(
      scoreModelPickerSearch(
        {
          family: "opencode",
          providerDisplayName: "opencode",
          name: "Claude Opus 4.8 1M",
          subProvider: "GitHub Copilot",
        },
        "coplt op",
      ),
    ).not.toBeNull();
  });

  it("rejects results when any query token does not match", () => {
    expect(
      scoreModelPickerSearch(
        {
          family: "openai",
          providerDisplayName: "Codex",
          name: "GPT-5 Codex",
        },
        "coplt op",
      ),
    ).toBeNull();
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        family: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.8 1M",
        subProvider: "GitHub Copilot",
      },
      "copilot opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        family: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.8 1M",
        subProvider: "GitHub Copilot",
      },
      "coplt op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("gives favorite models a strong enough ranking boost for partial queries", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        family: "anthropic",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opu",
    );
    const nonFavoriteScore = scoreModelPickerSearch(
      {
        family: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.5",
      },
      "opu",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(nonFavoriteScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        family: "anthropic",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.8 1M",
        isFavorite: true,
      },
      "opus 4.8",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        family: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.8 1M",
      },
      "opus 4.8",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });

  it("matches a provider display name against its models", () => {
    expect(
      scoreModelPickerSearch(
        {
          family: "openai",
          providerDisplayName: "Codex Personal",
          name: "GPT-5 Codex",
        },
        "personal",
      ),
    ).not.toBeNull();
  });

  it("matches Cursor SDK aliases returned by model discovery", () => {
    expect(
      scoreModelPickerSearch(
        {
          family: "cursor",
          providerDisplayName: "Cursor",
          name: "Composer 2",
          aliases: ["composer-latest"],
        },
        "composer-latest",
      ),
    ).not.toBeNull();
  });

  it("returns 0 for an empty query and a non-favorite item", () => {
    expect(
      scoreModelPickerSearch(
        {
          family: "anthropic",
          providerDisplayName: "Claude",
        name: "Claude Opus 4.8 1M",
        },
        "",
      ),
    ).toBe(0);
  });
});
