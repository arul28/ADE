import { describe, expect, it } from "vitest";
import { getShippedTheme } from "../../../shared/theme";
import { planThemeSave, upsertCustomTheme } from "./themeCustomizerModel";

const base = getShippedTheme("dark")!;

describe("planThemeSave", () => {
  it("saves a shipped-based draft as a new custom theme, never the shipped one", () => {
    const saved = planThemeSave({
      draft: { ...base, palette: { ...base.palette, accent: "#ff00aa" } },
      name: "My Night",
      editingExisting: false,
      takenIds: ["dark", "light"],
      baseId: "dark",
    });
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe("my-night");
    expect(saved!.source).toBe("custom");
    expect(saved!.basedOn).toBe("dark");
    expect(saved!.palette.accent).toBe("#ff00aa");
    // The base's description must not follow the user's theme.
    expect(saved!.description).toBeUndefined();
  });

  it("keeps an existing custom theme's own description when editing it", () => {
    const draft = { ...base, id: "mine", name: "Mine", source: "custom" as const, description: "Imported from Nord" };
    const saved = planThemeSave({
      draft,
      name: "Mine",
      editingExisting: true,
      takenIds: ["mine"],
      baseId: "mine",
    });
    expect(saved!.description).toBe("Imported from Nord");
  });

  it("gives a colliding name a fresh id instead of overwriting an existing theme", () => {
    const saved = planThemeSave({
      draft: base,
      name: "Obsidian",
      editingExisting: false,
      takenIds: ["obsidian"],
      baseId: "dark",
    });
    expect(saved!.id).toBe("obsidian-2");
  });

  it("keeps an existing custom theme's id when editing it", () => {
    const draft = { ...base, id: "mine", name: "Mine", source: "custom" as const, basedOn: "dark" };
    const saved = planThemeSave({
      draft: { ...draft, palette: { ...draft.palette, accent: "#00ff00" } },
      name: "Mine",
      editingExisting: true,
      takenIds: ["dark", "mine"],
      baseId: "mine",
    });
    expect(saved!.id).toBe("mine");
    expect(saved!.palette.accent).toBe("#00ff00");
  });

  it("refuses a blank name", () => {
    expect(planThemeSave({ draft: base, name: "   ", editingExisting: false, takenIds: [], baseId: "dark" })).toBeNull();
  });

  it("drops an unparsable colour from the saved palette", () => {
    const saved = planThemeSave({
      draft: { ...base, palette: { ...base.palette, accent: "not-a-colour" } },
      name: "Broken",
      editingExisting: false,
      takenIds: [],
      baseId: "dark",
    });
    expect(saved!.palette.accent).toBeUndefined();
  });
});

describe("upsertCustomTheme", () => {
  it("appends a new theme and replaces an existing one in place", () => {
    const a = { ...base, id: "a", name: "A", source: "custom" as const };
    const b = { ...base, id: "b", name: "B", source: "custom" as const };
    const list = upsertCustomTheme([a], b);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);

    const updated = upsertCustomTheme(list, { ...a, name: "A updated" });
    expect(updated.map((t) => t.id)).toEqual(["a", "b"]);
    expect(updated[0].name).toBe("A updated");
  });
});
