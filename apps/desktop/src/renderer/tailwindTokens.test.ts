import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

/**
 * The colour vocabulary, checked against the stylesheet that has to back it.
 *
 * A class-name assertion cannot tell a live utility from a dead one: jsdom
 * computes no styles, so `expect(el).toHaveClass("bg-surface")` passes whether
 * that utility paints a background or produces no CSS at all. That is how a
 * panel renders see-through with every render test green, and it is exactly
 * what happened: the config defines `surface-raised`, `surface-recessed` and
 * `surface-overlay` but no bare `surface`, so `bg-surface` — on the Mac
 * Desktop video letterbox, its time-lapse card and a TopBar dialog — compiled
 * to nothing and those three panels had no background at all.
 *
 * So this compiles the real stylesheet and fails on a dead colour class.
 *
 * On the `@config` line: I compiled index.css with and without it through
 * `@tailwindcss/postcss` 4.1 and the emitted rules were byte-identical, so the
 * plugin still finds `tailwind.config.cjs` on its own. The directive stays
 * because that is a v3 compatibility path rather than a v4 guarantee.
 */
describe("tailwind token wiring", () => {
  const desktopRoot = path.resolve(__dirname, "..", "..");
  const cssPath = path.join(desktopRoot, "src/renderer/index.css");
  const css = fs.readFileSync(cssPath, "utf8");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require(path.join(desktopRoot, "tailwind.config.cjs")) as {
    theme?: { extend?: { colors?: Record<string, unknown> } };
  };
  const tokens = Object.keys(config.theme?.extend?.colors ?? {});

  it("names the config rather than relying on auto-detection", () => {
    const declared = css.match(/@config\s+"([^"]+)"/);
    expect(declared, "index.css must name tailwind.config.cjs with @config").toBeTruthy();
    const target = path.resolve(desktopRoot, "src/renderer", declared![1]!);
    expect(fs.existsSync(target), `@config points at a missing file: ${target}`).toBe(true);
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

  it("emits CSS for every colour class the renderer actually spells", async () => {
    const out = await postcss([tailwind()]).process(css, { from: cssPath });
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full);
      }
    })(path.join(desktopRoot, "src/renderer"));

    /**
     * Only classes in this product's own colour vocabulary. A name counts when
     * it is a token, or shares a family with one — `bg-surface` is in scope
     * because `surface-raised` exists, which is the case that shipped broken.
     * Everything else in a class string (`border-box` in an inline style, a
     * stock Tailwind colour) is somebody else's problem and is skipped.
     */
    const ours = (name: string): boolean =>
      tokens.some((token) => token === name || token.startsWith(`${name}-`) || name.startsWith(`${token}-`));

    const dead = new Map<string, Set<string>>();
    for (const file of files) {
      for (const literal of fs.readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
        const text = literal[1] ?? literal[2] ?? literal[3] ?? "";
        if (!/\b(?:bg|text|border|ring)-/.test(text)) continue;
        // Opacity modifiers escape as `\/` in the output; the plain class is
        // the reliable signal and catches the same authoring mistake.
        for (const match of text.matchAll(/(?:^|\s)((?:[a-z-]+:)*(?:bg|text|border|ring)-[a-z][a-z0-9-]*)(?=\s|$)/g)) {
          const cls = match[1]!.replace(/^(?:[a-z-]+:)*/, "");
          const name = cls.replace(/^(?:bg|text|border|ring)-/, "");
          if (!ours(name)) continue;
          if (new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?![a-z0-9-])`).test(out.css)) continue;
          if (!dead.has(cls)) dead.set(cls, new Set());
          dead.get(cls)!.add(path.relative(desktopRoot, file));
        }
      }
    }

    const report = [...dead].map(([cls, where]) => `${cls} (${[...where].join(", ")})`);
    expect(report, "these colour classes produce no CSS, so their elements render unstyled").toEqual([]);
  }, 30_000);
});
