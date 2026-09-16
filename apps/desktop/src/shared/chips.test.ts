import { describe, expect, it } from "vitest";

import {
  chipDisplayLabel,
  chipFromMention,
  chipFromPath,
  chipFromSmartLink,
  parseChips,
  splitTextIntoChipParts,
} from "./chips";
import { deriveSmartLinkPreview } from "./smartLinks";
import chipCases from "./__fixtures__/chipCases.json";

function previewFor(url: string) {
  const preview = deriveSmartLinkPreview(url);
  if (!preview) throw new Error(`no preview for ${url}`);
  return preview;
}

describe("chipFromSmartLink", () => {
  it("types an ade:// PR link the same as a github PR url", () => {
    const fromGithub = chipFromSmartLink(previewFor("https://github.com/arul28/ade/pull/1237"));
    const fromDeeplink = chipFromSmartLink(previewFor("ade://pr/arul28/ade/1237"));

    expect(fromGithub.kind).toBe("pr");
    expect(fromDeeplink.kind).toBe("pr");
    expect(fromDeeplink.label).toBe("#1237");
    expect(fromDeeplink.detail).toBe("arul28/ade");
  });

  it("keeps an unparseable ade:// link addressable instead of dropping it", () => {
    const chip = chipFromSmartLink(previewFor("ade://something-a-newer-ade-minted/42"));
    expect(chip.kind).toBe("ade_link");
    expect(chip.token).toBe("ade://something-a-newer-ade-minted/42");
  });

  it("carries the canonical url as the token for external links", () => {
    const chip = chipFromSmartLink(previewFor("https://linear.app/ade/issue/ADE-431/fix-it"));
    expect(chip.kind).toBe("linear_issue");
    expect(chip.label).toBe("ADE-431");
    expect(chip.token).toBe("https://linear.app/ade/issue/ADE-431/fix-it");
  });
});

describe("chipFromMention", () => {
  it("serializes to the pointer token while showing a human label", () => {
    const chip = chipFromMention("chat", "9e2315e8", "Lane B — composer");
    expect(chip.token).toBe("@chat:9e2315e8");
    expect(chip.label).toBe("Lane B — composer");
    expect(chip.kind).toBe("chat");
  });

  it("falls back to a deterministic label when none is known", () => {
    expect(chipFromMention("lane", "abcdef1234567890").label).toBe("Lane abcdef12");
  });
});

describe("chipFromPath", () => {
  it("distinguishes a folder from a file", () => {
    expect(chipFromPath("src/shared/chips.ts").kind).toBe("file");
    expect(chipFromPath("src/shared", { isDirectory: true }).kind).toBe("folder");
    expect(chipFromPath("src/shared", { isDirectory: true }).label).toBe("shared/");
    // The token carries the slash too — it is what the composer inserts.
    expect(chipFromPath("src/shared", { isDirectory: true }).token).toBe("src/shared/");
  });

  it("keeps the full path as the token so the round trip is lossless", () => {
    expect(chipFromPath("src/shared/chips.ts").token).toBe("src/shared/chips.ts");
    expect(chipFromPath("src/shared/chips.ts").detail).toBe("src/shared");
  });
});

describe("parseChips", () => {
  it("finds mentions and links in document order", () => {
    const text = "see @chat:abc then https://github.com/arul28/ade/pull/7 ok";
    const chips = parseChips(text);
    expect(chips.map((chip) => chip.kind)).toEqual(["chat", "pr"]);
    expect(text.slice(chips[0]!.start, chips[0]!.end)).toBe("@chat:abc");
    expect(text.slice(chips[1]!.start, chips[1]!.end)).toBe("https://github.com/arul28/ade/pull/7");
  });

  it("locates the second of two identical tokens correctly", () => {
    const text = "@chat:abc and again @chat:abc";
    const chips = parseChips(text);
    expect(chips).toHaveLength(2);
    expect(chips[1]!.start).toBe(text.lastIndexOf("@chat:abc"));
  });

  it("does not turn a bare path into a chip", () => {
    expect(parseChips("look at src/shared/chips.ts please")).toHaveLength(0);
  });
});

describe("splitTextIntoChipParts", () => {
  it("returns one text part when there is nothing to chip", () => {
    expect(splitTextIntoChipParts("plain message")).toEqual([{ type: "text", text: "plain message" }]);
  });

  it("preserves the surrounding text exactly", () => {
    const text = "fix @lane:xyz now";
    const parts = splitTextIntoChipParts(text);
    const rebuilt = parts
      .map((part) => (part.type === "text" ? part.text : part.chip.token))
      .join("");
    expect(rebuilt).toBe(text);
  });
});

describe("cross-surface fixture", () => {
  // The iOS suite reads this same file from disk
  // (ADETests/WorkComposerTriggerDetectorTests.testMatchesSharedChipFixture),
  // so a new deeplink shape added here fails Swift until it matches. That is
  // what stops the two implementations drifting apart between reviews.
  it("has rows, so an emptied fixture cannot pass silently", () => {
    expect(chipCases.cases.length).toBeGreaterThan(10);
  });

  it.each(chipCases.cases)("$url -> $kind / $label", ({ url, kind, label }) => {
    const preview = deriveSmartLinkPreview(url);
    expect(preview, `no preview for ${url}`).toBeTruthy();
    const chip = chipFromSmartLink(preview!);
    expect(chip.kind).toBe(kind);
    expect(chipDisplayLabel(chip)).toBe(label);
  });
});

describe("cross-surface fixture: mentions", () => {
  // The iOS suite drives these same rows through its Swift mention grammar.
  // Driving them here too is what makes the fixture a two-sided gate: a row
  // that only one side asserts gates nothing.
  it("has rows, so an emptied mention fixture cannot pass silently", () => {
    expect(chipCases.mentions.length).toBeGreaterThan(5);
  });

  it.each(chipCases.mentions)("$text", ({ text, chips }) => {
    const found = parseChips(text).map((chip) => ({ kind: chip.kind, token: chip.token, label: chip.label }));
    expect(found).toEqual(chips);
  });
});
