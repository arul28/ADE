import { describe, expect, it } from "vitest";

import { parseReleaseNotesMdx } from "./releaseNotesMdx";

const PAGE = `---
title: "v1.2.79"
description: "Release notes for ADE v1.2.79"
---

One contract, and a faster thread engine.

---

## Chat

- **Finished turns fold.** A chat shows one task list.
- See the [docs](https://www.ade-app.dev/docs/changelog/v1.2.79) for the rest.

## Empty

`;

describe("parseReleaseNotesMdx", () => {
  it("keeps the summary and the section bullets, and drops the page chrome", () => {
    expect(parseReleaseNotesMdx(PAGE)).toEqual({
      summary: "One contract, and a faster thread engine.",
      sections: [
        {
          title: "Chat",
          items: [
            "Finished turns fold. A chat shows one task list.",
            "See the docs for the rest.",
          ],
        },
      ],
    });
  });

  it("returns null when the page has no summary and no bullets", () => {
    expect(parseReleaseNotesMdx("---\ntitle: x\n---\n")).toBeNull();
  });
});
