import fs from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, expect, it } from "vitest";

describe("queued steer action styles", () => {
  it("compiles the visibility rules inside hover media queries", async () => {
    const sourcePath = path.resolve(process.cwd(), "src/renderer/index.css");
    const source = await fs.readFile(sourcePath, "utf8");
    const { css } = await postcss([tailwindcss({ base: process.cwd() })]).process(source, {
      from: sourcePath,
    });

    expect(css).toContain(".\\[\\@media\\(hover\\:hover\\)\\]\\:opacity-0");
    expect(css).toContain(".\\[\\@media\\(hover\\:hover\\)\\]\\:group-hover\\:opacity-100");
    const hiddenRuleStart = css.indexOf(".\\[\\@media\\(hover\\:hover\\)\\]\\:opacity-0");
    const revealRuleStart = css.indexOf(".\\[\\@media\\(hover\\:hover\\)\\]\\:group-hover\\:opacity-100");
    expect(hiddenRuleStart).toBeGreaterThanOrEqual(0);
    expect(revealRuleStart).toBeGreaterThanOrEqual(0);
    expect(css.slice(hiddenRuleStart, hiddenRuleStart + 260)).toContain("@media (hover:hover)");
    expect(css.slice(hiddenRuleStart, hiddenRuleStart + 260)).toContain("opacity: 0%");
    expect(css.slice(revealRuleStart, revealRuleStart + 320)).toContain("@media (hover:hover)");
  });
});
