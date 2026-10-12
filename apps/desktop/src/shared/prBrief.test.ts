import { describe, expect, it } from "vitest";

import { parsePrBrief, prBriefHints } from "./prBrief";

const BRIEF = [
  "The tab bar is faster.",
  "",
  "## Why",
  "A switch waited for the finger to lift.",
  "",
  "## What changed",
  "A tab opens when the finger pushes down.",
  "",
  "## Evidence",
  "- Timed 20 switches in the running app: 137 ms before, 47 ms after.",
  "",
  "## Not checked",
  "Windows.",
  "",
  "Authored with a model via a harness.",
].join("\n");

describe("parsePrBrief", () => {
  it("splits a description into the lead, one part for each heading, and the sign-off", () => {
    const brief = parsePrBrief(BRIEF);
    expect(brief, "the text is a Brief").not.toBeNull();
    expect(brief!.lead).toBe("The tab bar is faster.");
    expect(brief!.parts.map((part) => [part.kind, part.heading, part.level])).toEqual([
      ["why", "Why", 2],
      ["changed", "What changed", 2],
      ["evidence", "Evidence", 2],
      ["not_checked", "Not checked", 2],
    ]);
    expect(brief!.parts[2]!.body).toContain("137 ms before");
    // The sign-off leaves the last part, so "Not checked" holds only its answer.
    expect(brief!.parts[3]!.body).toBe("Windows.");
    expect(brief!.footer).toBe("Authored with a model via a harness.");
  });

  it("reads the headings older templates use as the same parts, and keeps a heading it does not know", () => {
    const brief = parsePrBrief([
      "## Problem", "p", "## Cause", "c", "## Change and boundary", "b",
      "## Performance (row measured)", "t", "## Verification:", "v",
    ].join("\n"));
    expect(brief!.parts.map((part) => part.kind)).toEqual(["why", "why", "changed", "other", "evidence"]);
    expect(brief!.parts[3]!.heading).toBe("Performance (row measured)");
    expect(brief!.parts[4]!.body).toBe("v");
  });

  it.each([
    ["a text with no headings", "Bump the compiler flag so the Windows build passes again."],
    ["one known part only", "## Summary\nA fix.\n\n## Notes\nNone."],
    ["no part that says what changed or how it was checked", "## Why\na\n\n## Choices I made\nb"],
    ["a link defined in one part and used in another", "## Why\nSee [the issue][1].\n\n## Evidence\nRan it.\n\n[1]: https://example.com/1"],
    ["a details block that spans two parts", "## Why\n<details>\n\n## Evidence\nRan it.\n</details>"],
  ])("leaves %s as a plain document", (_name, text) => {
    expect(parsePrBrief(text)).toBeNull();
  });

  it("does not cut at a heading that is inside a code fence, even a fence shown inside a longer fence", () => {
    const brief = parsePrBrief([
      "## What changed",
      "The guide shows this example:",
      "````markdown",
      "```proof-compare",
      "## Evidence",
      "```",
      "````",
      "## Evidence",
      "Ran it.",
    ].join("\n"));
    expect(brief!.parts.map((part) => part.kind)).toEqual(["changed", "evidence"]);
    expect(brief!.parts[0]!.body).toContain("## Evidence");
    expect(brief!.parts[1]!.body).toBe("Ran it.");
  });
});

describe("prBriefHints", () => {
  const codes = (text: string) => prBriefHints(text).map((hint) => hint.code);

  it.each([
    ["a complete Brief", BRIEF, []],
    ["an empty text", "   ", ["no_text"]],
    ["a small fix told in two sentences", "Bump the compiler flag. The Windows build passes again.", []],
    ["a long text with no parts", `${"The change does many things for many people. ".repeat(12)}`, ["no_parts"]],
    ["missing parts", "## Summary\nIt is faster.\n\n## Notes\nNone.\n\n## Why\nIt was slow.", ["no_evidence", "no_not_checked"]],
    ["evidence that is only a pass claim", "## What changed\nx\n\n## Evidence\nAll tests pass.\n\n## Not checked\nNothing.\n\n## Why\ny", ["tests_pass_only"]],
    ["a pass claim beside a table of numbers", "## What changed\nx\n\n## Evidence\nTests pass.\n\n| run | ms |\n| --- | --- |\n| 1 | 47 |\n\n## Not checked\nNothing.\n\n## Why\ny", []],
    ["a placeholder left in the text", "## Why\ny\n\n## What changed\nx\n\n## Evidence\npending /quality and /test\n\n## Not checked\nNothing.", ["placeholder"]],
    ["the word todo in a sentence", "## Why\nThe todo list lost items.\n\n## What changed\nx\n\n## Evidence\nAdded an item and reloaded: it stayed.\n\n## Not checked\nNothing.", []],
  ])("for %s", (_name, text, expected) => {
    expect(codes(text)).toEqual(expected);
  });

  it("flags an opening full of code names and a text too long to read, and counts neither code blocks nor pictures as words", () => {
    const names = "`a.ts` `b.ts` `c.ts` `d.ts`";
    const rest = "\n\n## What changed\nx\n\n## Evidence\nRan the app and saw it.\n\n## Not checked\nNothing.";
    expect(codes(`## Why\nIt touches ${names}.${rest}`)).toEqual(["code_names"]);

    const long = `## Why\n${"word ".repeat(460)}${rest}`;
    expect(codes(long)).toEqual(["long"]);
    const sameWordsInCode = `## Why\nShort.\n\n\`\`\`\n${"word ".repeat(460)}\n\`\`\`\n\n![${"word ".repeat(40)}](https://example.com/a.png)${rest}`;
    expect(codes(sameWordsInCode)).toEqual([]);
  });
});
