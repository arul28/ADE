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
    // The two utilities share one `@media (hover:hover)` block whose other
    // members change as the app grows, so check nesting by brace depth rather
    // than by a fixed window of characters after the opener.
    const insideHoverMedia = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const opener = css.lastIndexOf("@media (hover:hover)", start);
      if (opener < 0) return false;
      let depth = 0;
      for (const ch of css.slice(opener, start)) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      return depth >= 1;
    };
    const hiddenSelector = ".\\[\\@media\\(hover\\:hover\\)\\]\\:opacity-0";
    const revealSelector = ".\\[\\@media\\(hover\\:hover\\)\\]\\:group-hover\\:opacity-100";
    expect(insideHoverMedia(hiddenSelector)).toBe(true);
    expect(insideHoverMedia(revealSelector)).toBe(true);
    const hiddenStart = css.indexOf(hiddenSelector);
    expect(css.slice(hiddenStart, css.indexOf("}", hiddenStart))).toContain("opacity: 0%");
  });
});
