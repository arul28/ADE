import { describe, expect, it } from "vitest";
import { smartLinkChipMarkSvg } from "./smartLinkChipMark";
import type { SmartLinkProvider } from "../../../shared/smartLinks";

describe("smartLinkChipMarkSvg", () => {
  const catalogue: SmartLinkProvider[] = ["github", "linear", "ade", "generic"];

  it("returns a real inline SVG brand mark for every catalogued provider", () => {
    for (const provider of catalogue) {
      const markup = smartLinkChipMarkSvg(provider);
      expect(markup, `${provider} should have a mark`).toBeTruthy();
      expect(markup!.startsWith("<svg"), `${provider} markup is an <svg>`).toBe(true);
      expect(markup).toContain("</svg>");
      // Never the old letter monograms ("GH" / "L" / "A" / "↗").
      expect(markup).not.toMatch(/>GH<|>L<|>A<|↗/);
    }
  });

  it("renders currentColor marks so chips inherit their foreground", () => {
    for (const provider of catalogue) {
      expect(smartLinkChipMarkSvg(provider)).toContain("currentColor");
    }
  });

  it("uses the octocat mark for github and a stroked globe for generic web pages", () => {
    const github = smartLinkChipMarkSvg("github")!;
    // simple-icons octocat starts at the M12 .297 apex.
    expect(github).toContain("M12 .297");
    expect(github).toContain('fill="currentColor"');

    const generic = smartLinkChipMarkSvg("generic")!;
    expect(generic).toContain("<circle");
    expect(generic).toContain('stroke="currentColor"');
  });
});
