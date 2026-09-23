import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADE_ACCENT_COLOR } from "./themeTokens";

const here = dirname(fileURLToPath(import.meta.url));

describe("ADE_ACCENT_COLOR", () => {
  it("still matches the renderer's --color-accent", () => {
    const css = readFileSync(resolve(here, "../renderer/index.css"), "utf8");
    // The first declaration is the default (dark) theme's.
    const match = /--color-accent:\s*(#[0-9A-Fa-f]{6})\s*;/.exec(css);
    expect(match?.[1]?.toUpperCase()).toBe(ADE_ACCENT_COLOR.toUpperCase());
  });
});
