import { describe, expect, it } from "vitest";
import {
  buildPaletteSections,
  paletteSectionAt,
  paletteSectionsTotal,
  walkPaletteSections,
  type PaletteSection,
  type PaletteSectionKey,
} from "./commandPaletteSections";

/**
 * Reproduces what the palette's renderer does: walk the sections in order and
 * emit one row per claimed index, tagged with the section it came from. The
 * resulting array IS the on-screen order.
 */
function renderOrder(
  sections: readonly PaletteSection[],
): { key: PaletteSectionKey; offset: number; index: number }[] {
  return walkPaletteSections(sections, (section, startIndex) =>
    Array.from({ length: section.count }, (_unused, offset) => ({
      key: section.key,
      offset,
      index: startIndex + offset,
    })),
  ).flat();
}

describe("buildPaletteSections", () => {
  it("puts threads first by default", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 3,
      commandCount: 5,
      entityCount: 2,
    });
    expect(sections.map((section) => section.key)).toEqual([
      "threads",
      "commands",
      "entities",
    ]);
    expect(sections.map((section) => section.count)).toEqual([3, 5, 2]);
  });

  it("flips commands ahead of threads when the query leads with a command", () => {
    const sections = buildPaletteSections({
      commandsLead: true,
      threadCount: 3,
      commandCount: 5,
      entityCount: 2,
    });
    expect(sections.map((section) => section.key)).toEqual([
      "commands",
      "threads",
      "entities",
    ]);
    expect(sections.map((section) => section.count)).toEqual([5, 3, 2]);
  });

  it("keeps entities last in both orders", () => {
    for (const commandsLead of [false, true]) {
      const sections = buildPaletteSections({
        commandsLead,
        threadCount: 1,
        commandCount: 1,
        entityCount: 1,
      });
      expect(sections[sections.length - 1]?.key).toBe("entities");
    }
  });

  it("does no filtering of its own — the total is exactly the counts it was given", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 4,
      commandCount: 7,
      entityCount: 6,
    });
    expect(paletteSectionsTotal(sections)).toBe(17);
  });

  it("reflects a narrowed query only through the counts and the lead flag", () => {
    const unfiltered = buildPaletteSections({
      commandsLead: false,
      threadCount: 9,
      commandCount: 20,
      entityCount: 0,
    });
    // Typing a command title drops the thread matches and flips the order.
    const filtered = buildPaletteSections({
      commandsLead: true,
      threadCount: 0,
      commandCount: 2,
      entityCount: 0,
    });
    expect(paletteSectionsTotal(unfiltered)).toBe(29);
    expect(paletteSectionsTotal(filtered)).toBe(2);
    expect(renderOrder(filtered).every((row) => row.key === "commands")).toBe(
      true,
    );
  });
});

describe("empty sections", () => {
  it("renders no rows and claims no flat indices", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 0,
      commandCount: 2,
      entityCount: 0,
    });
    expect(renderOrder(sections)).toEqual([
      { key: "commands", offset: 0, index: 0 },
      { key: "commands", offset: 1, index: 1 },
    ]);
    expect(paletteSectionAt(sections, 0)?.section.key).toBe("commands");
  });

  it("never resolves an index to a zero-count section", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 0,
      commandCount: 0,
      entityCount: 3,
    });
    for (let index = 0; index < 3; index += 1) {
      expect(paletteSectionAt(sections, index)?.section.key).toBe("entities");
    }
  });

  it("has no navigable rows when every section is empty", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 0,
      commandCount: 0,
      entityCount: 0,
    });
    expect(paletteSectionsTotal(sections)).toBe(0);
    expect(renderOrder(sections)).toEqual([]);
    expect(paletteSectionAt(sections, 0)).toBeNull();
  });
});

describe("keyboard order matches render order", () => {
  const cases = [
    { commandsLead: false, threadCount: 3, commandCount: 4, entityCount: 2 },
    { commandsLead: true, threadCount: 3, commandCount: 4, entityCount: 2 },
    { commandsLead: false, threadCount: 0, commandCount: 4, entityCount: 0 },
    { commandsLead: true, threadCount: 5, commandCount: 0, entityCount: 1 },
  ];

  for (const input of cases) {
    it(`resolves every flat index back to the row it rendered (${JSON.stringify(input)})`, () => {
      const sections = buildPaletteSections(input);
      const rows = renderOrder(sections);
      expect(rows).toHaveLength(paletteSectionsTotal(sections));
      // Render order is a contiguous 0..n-1 run — no gaps, no reordering.
      expect(rows.map((row) => row.index)).toEqual(
        rows.map((_unused, position) => position),
      );
      for (const row of rows) {
        const hit = paletteSectionAt(sections, row.index);
        expect(hit).not.toBeNull();
        expect(hit?.section.key).toBe(row.key);
        expect(hit?.offset).toBe(row.offset);
      }
    });
  }

  it("returns null for indices outside the list", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 2,
      commandCount: 1,
      entityCount: 0,
    });
    expect(paletteSectionAt(sections, -1)).toBeNull();
    expect(paletteSectionAt(sections, 3)).toBeNull();
  });

  it("hands each section the flat index of its own first row", () => {
    const sections = buildPaletteSections({
      commandsLead: false,
      threadCount: 3,
      commandCount: 4,
      entityCount: 2,
    });
    expect(
      walkPaletteSections(sections, (section, startIndex) => [
        section.key,
        startIndex,
      ]),
    ).toEqual([
      ["threads", 0],
      ["commands", 3],
      ["entities", 7],
    ]);
  });
});
