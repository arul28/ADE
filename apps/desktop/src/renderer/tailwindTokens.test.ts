import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Tailwind v4 reads `@import "tailwindcss"` and, unlike v3, does NOT look for
 * `tailwind.config.cjs` on its own. Without an explicit `@config` the whole
 * colour vocabulary in that file — `bg-surface`, `text-fg`, `border-border`,
 * `bg-surface-overlay` … — compiles to nothing. Every panel using them then
 * renders with NO background at all, which is how a confirm dialog shipped
 * see-through while its tests passed: jsdom computes no styles, so a test that
 * asserts a class name cannot tell a live utility from a dead one.
 */
describe("tailwind token wiring", () => {
  const desktopRoot = path.resolve(__dirname, "..", "..");
  const css = fs.readFileSync(path.join(desktopRoot, "src/renderer/index.css"), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(path.join(desktopRoot, "tailwind.config.cjs")) as {
    theme?: { extend?: { colors?: Record<string, unknown> } };
  };

  it("declares @config, so the config's colours become real utilities", () => {
    const declared = css.match(/@config\s+"([^"]+)"/);
    expect(declared, "index.css must declare @config for Tailwind v4").toBeTruthy();
    const target = path.resolve(desktopRoot, "src/renderer", declared![1]!);
    expect(fs.existsSync(target), `@config points at a missing file: ${target}`).toBe(true);
    expect(path.basename(target)).toBe("tailwind.config.cjs");
  });

  it("still defines the surface and text tokens the product spells", () => {
    const colors = config.theme?.extend?.colors ?? {};
    for (const token of ["surface", "surface-overlay", "fg", "muted-fg", "border"]) {
      expect(Object.keys(colors), `missing colour token: ${token}`).toContain(token);
    }
  });

  it("backs every colour token with a CSS variable that index.css defines", () => {
    const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string>;
    for (const [token, value] of Object.entries(colors)) {
      if (typeof value !== "string") continue;
      const variable = value.match(/var\((--[a-z0-9-]+)\)/i)?.[1];
      if (!variable) continue;
      expect(css.includes(`${variable}:`), `${token} -> ${variable} is never defined in index.css`).toBe(true);
    }
  });
});
