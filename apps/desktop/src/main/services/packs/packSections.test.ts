import { describe, expect, it } from "vitest";
import { computeSectionChanges, replaceBetweenMarkers, upsertSectionByHeading } from "./packSections";
import type { SectionLocator } from "./packSections";

const N_START = "<!-- ADE_NARRATIVE_START -->";
const N_END = "<!-- ADE_NARRATIVE_END -->";

describe("packSections", () => {
  it("replaces content between markers without touching surrounding content", () => {
    const input = [
      "# Lane: demo",
      "",
      "## Narrative",
      N_START,
      "old narrative",
      N_END,
      "",
      "---",
      "*Updated: 2026-02-14T00:00:00Z*",
      ""
    ].join("\n");

    const out = replaceBetweenMarkers({
      content: input,
      startMarker: N_START,
      endMarker: N_END,
      body: "new narrative"
    }).content;

    expect(out).toContain(N_START);
    expect(out).toContain("new narrative");
    expect(out).toContain(N_END);
    expect(out).toContain("*Updated: 2026-02-14T00:00:00Z*");
    expect(out).not.toContain("old narrative");
  });

  it("upserts narrative markers into older packs and preserves footer after Narrative", () => {
    const input = [
      "# Lane: demo",
      "",
      "## Narrative",
      "old narrative",
      "",
      "---",
      "*Updated: 2026-02-14T00:00:00Z*",
      ""
    ].join("\n");

    const { content: out, insertedMarkers } = upsertSectionByHeading({
      content: input,
      heading: "## Narrative",
      startMarker: N_START,
      endMarker: N_END,
      body: "new narrative"
    });

    expect(insertedMarkers).toBe(true);
    expect(out).toContain("## Narrative");
    expect(out).toContain(N_START);
    expect(out).toContain("new narrative");
    expect(out).toContain(N_END);
    expect(out).toContain("---");
    expect(out).toContain("*Updated: 2026-02-14T00:00:00Z*");
    expect(out).not.toContain("old narrative");
  });

  it("is idempotent when markers already exist", () => {
    const input = [
      "# Lane: demo",
      "",
      "## Narrative",
      N_START,
      "new narrative",
      N_END,
      "",
      "## Other Section",
      "keep me",
      ""
    ].join("\n");

    const first = upsertSectionByHeading({
      content: input,
      heading: "## Narrative",
      startMarker: N_START,
      endMarker: N_END,
      body: "new narrative"
    });
    const second = upsertSectionByHeading({
      content: first.content,
      heading: "## Narrative",
      startMarker: N_START,
      endMarker: N_END,
      body: "new narrative"
    });

    expect(first.insertedMarkers).toBe(false);
    expect(second.insertedMarkers).toBe(false);
    expect(second.content).toBe(first.content);
    expect(second.content).toContain("## Other Section");
    expect(second.content).toContain("keep me");
  });

  it("computeSectionChanges is deterministic and null-safe", () => {
    const locators: SectionLocator[] = [
      { id: "narrative", kind: "markers", startMarker: N_START, endMarker: N_END },
      { id: "other", kind: "heading", heading: "## Other Section" }
    ];

    const before = [
      "# Lane: demo",
      "",
      "## Narrative",
      N_START,
      "old",
      N_END,
      "",
      "## Other Section",
      "keep",
      ""
    ].join("\n");

    const after = [
      "# Lane: demo",
      "",
      "## Narrative",
      N_START,
      "new",
      N_END,
      "",
      "## Other Section",
      "keep",
      ""
    ].join("\n");

    const first = computeSectionChanges({ before, after, locators });
    const second = computeSectionChanges({ before, after, locators });
    expect(first).toEqual(second);
    expect(first.some((c) => c.sectionId === "narrative" && c.changeType === "modified")).toBe(true);

    const nullSafe = computeSectionChanges({ before: null, after, locators });
    expect(nullSafe.some((c) => c.sectionId === "narrative")).toBe(true);
  });
});
