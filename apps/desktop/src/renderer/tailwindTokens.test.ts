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
 * On the `@config` line: the mac-desktop lane measured it as a no-op and read
 * it as v3 compatibility. On THIS lane it is not. Compiling this stylesheet
 * through `@tailwindcss/postcss` 4.1 with and without the directive gives
 * 742,847 bytes against 681,927, and `bg-surface`, `bg-surface-overlay`,
 * `text-fg` and `border-border` are emitted only with it. The likely reason
 * the two lanes disagree is that their "without" run still carried the
 * directive after they merged it. Either way this test is the arbiter: it
 * fails if the vocabulary stops compiling, whatever the reason.
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
    /*
     * A name is also ours when index.css defines `--color-<name>` for it, even
     * if the config never registered it. That is the blind spot the family
     * rule alone leaves: `text-success` in cto/shared/TimelineEntry.tsx is
     * backed by `--color-success` but has no token, so nothing compiles and
     * a token-family check cannot see it — the class looks like somebody
     * else's stock colour.
     */
    const declaredVariables = new Set(
      [...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((match) => match[1]!),
    );
    const ours = (name: string): boolean =>
      declaredVariables.has(name)
      || tokens.some((token) => token === name || token.startsWith(`${name}-`) || name.startsWith(`${token}-`));

    const dead = new Map<string, Set<string>>();
    for (const file of files) {
      for (const literal of fs.readFileSync(file, "utf8").matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
        const text = literal[1] ?? literal[2] ?? literal[3] ?? "";
        if (!/\b(?:bg|text|border|ring)-/.test(text)) continue;
        // `key="bg-command-details"` is a React key, not a class. Only look at
        // literals that sit in a class position.
        if (new RegExp(`(?:key|id|data-[a-z-]+)=["'\`]${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(fs.readFileSync(file, "utf8"))) continue;
        // Opacity modifiers escape as `\/` in the output; the plain class is
        // the reliable signal and catches the same authoring mistake.
        for (const match of text.matchAll(/(?:^|\s)((?:[a-z-]+:)*(?:bg|text|border|ring)-[a-z][a-z0-9-]*)(\/\d+)?(?=\s|$)/g)) {
          // A class used ONLY with an opacity modifier (`bg-info/10`) was
          // invisible to both lanes' first version, because the modifier broke
          // the end-of-class lookahead. TimelineEntry spells exactly that:
          // `text-info bg-info/10 border-info/20`. Drop the modifier and check
          // the base utility, which is what has to exist for either to paint.
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
