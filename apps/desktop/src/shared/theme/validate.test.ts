import { describe, expect, it } from "vitest";
import {
  exportAdeTheme,
  missingCorePaletteKeys,
  normalizeAdeTheme,
  normalizeAdeThemeList,
  parseAdeThemeFile,
  prepareImportedTheme,
  serializeAdeTheme,
  slugifyThemeId,
  themeExportFileName,
  uniqueThemeId,
} from "./validate";
import type { AdeTheme } from "./types";

const CORE = { bg: "#0b0b0f", fg: "#ececf1", surface: "#121218", card: "#17171e", accent: "#f472b6" };

describe("slugifyThemeId", () => {
  it("produces a safe, stable id", () => {
    expect(slugifyThemeId("Rosé Pine Dawn!")).toBe("rose-pine-dawn");
    expect(slugifyThemeId("   ")).toBe("theme");
    expect(slugifyThemeId("Already-Fine")).toBe("already-fine");
  });

  it("avoids collisions with ids already in use", () => {
    expect(uniqueThemeId("Nord", ["nord"])).toBe("nord-2");
    expect(uniqueThemeId("Nord", ["nord", "nord-2"])).toBe("nord-3");
    expect(uniqueThemeId("Nord", ["other"])).toBe("nord");
  });
});

describe("normalizeAdeTheme", () => {
  it("keeps a valid theme and fills the format version", () => {
    const theme = normalizeAdeTheme({ name: "Midnight", baseMode: "dark", palette: CORE });
    expect(theme).not.toBeNull();
    expect(theme!.formatVersion).toBe(1);
    expect(theme!.id).toBe("midnight");
    expect(theme!.source).toBe("custom");
    expect(theme!.palette.bg).toBe("#0b0b0f");
  });

  it("drops unparsable colours rather than carrying them into CSS", () => {
    const theme = normalizeAdeTheme({
      name: "Broken",
      palette: { ...CORE, mutedFg: "not-a-colour", accent: "oklch(0.6 0.1 200)" },
    })!;
    expect(theme.palette.mutedFg).toBeUndefined();
    expect(theme.palette.accent).toBeDefined();
    // The dropped key is exactly what the resolver then derives.
    expect(missingCorePaletteKeys(theme)).not.toContain("accent");
  });

  it("infers the base mode from the background when it is not declared", () => {
    expect(normalizeAdeTheme({ name: "Bright", palette: { ...CORE, bg: "#ffffff", fg: "#111111" } })!.baseMode).toBe("light");
    expect(normalizeAdeTheme({ name: "Dim", palette: CORE })!.baseMode).toBe("dark");
  });

  it("returns null for things that are not theme-shaped", () => {
    expect(normalizeAdeTheme(null)).toBeNull();
    expect(normalizeAdeTheme("nope")).toBeNull();
    expect(normalizeAdeTheme({ palette: CORE })).toBeNull();
  });

  it("honours an explicit id and source", () => {
    const theme = normalizeAdeTheme({ id: "weird id!!", name: "Keep" }, { id: "forced", source: "imported" })!;
    expect(theme.id).toBe("forced");
    expect(theme.source).toBe("imported");
  });

  it("normalizes translucent colours to rgba and opaque to hex", () => {
    const theme = normalizeAdeTheme({
      name: "Alpha",
      palette: { ...CORE, accentMuted: "rgba(167, 139, 250, 0.2)" },
    })!;
    expect(theme.palette.accentMuted).toBe("rgba(167, 139, 250, 0.2)");
  });
});

describe("normalizeAdeThemeList", () => {
  it("dedupes by id and repairs entries", () => {
    const list = normalizeAdeThemeList([
      { id: "a", name: "A", palette: CORE },
      { id: "a", name: "A again", palette: CORE },
      { id: "b", name: "B", palette: CORE },
      "junk",
    ]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeAdeThemeList(undefined)).toEqual([]);
    expect(normalizeAdeThemeList({})).toEqual([]);
  });
});

describe("theme file export and import", () => {
  const theme: AdeTheme = normalizeAdeTheme({ name: "Shared", baseMode: "dark", palette: CORE })!;

  it("round-trips through the versioned envelope", () => {
    const parsed = parseAdeThemeFile(serializeAdeTheme(theme));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.theme.name).toBe("Shared");
      expect(parsed.theme.palette).toMatchObject(CORE);
      expect(parsed.theme.source).toBe("custom");
    }
  });

  it("accepts a bare theme object as well as an envelope", () => {
    const bare = JSON.stringify({ name: "Bare", palette: CORE });
    const parsed = parseAdeThemeFile(bare);
    expect(parsed.ok).toBe(true);
  });

  it("refuses a file made by a newer format version", () => {
    const parsed = parseAdeThemeFile(JSON.stringify({ kind: "ade.theme", version: 99, theme: { name: "Future", palette: CORE } }));
    expect(parsed.ok).toBe(false);
  });

  it("reports invalid JSON and non-theme files instead of throwing", () => {
    expect(parseAdeThemeFile("{ not json").ok).toBe(false);
    expect(parseAdeThemeFile(JSON.stringify({ hello: "world" })).ok).toBe(false);
  });

  it("stamps exports with the format version and a file-safe name", () => {
    const envelope = exportAdeTheme(theme, new Date("2026-01-02T03:04:05.000Z"));
    expect(envelope.kind).toBe("ade.theme");
    expect(envelope.version).toBe(1);
    expect(envelope.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(themeExportFileName(theme)).toBe("ade-theme-shared.json");
  });
});

describe("prepareImportedTheme", () => {
  it("gives a colliding import a fresh id and stamps its source, keeping the name", () => {
    const imported = normalizeAdeTheme({ id: "nord", name: "Nord", palette: CORE })!;
    const prepared = prepareImportedTheme(imported, "imported", ["dark", "nord"]);
    expect(prepared.id).toBe("nord-2");
    expect(prepared.name).toBe("Nord");
    expect(prepared.source).toBe("imported");
    expect(prepared.palette).toMatchObject(CORE);
  });

  it("stamps a VS Code import as vscode", () => {
    const imported = normalizeAdeTheme({ name: "One Dark", palette: CORE })!;
    expect(prepareImportedTheme(imported, "vscode", []).source).toBe("vscode");
  });
});
