import { describe, expect, it } from "vitest";
import { resolveViewerKind, viewerIsEditable } from "./viewerRegistry";

describe("resolveViewerKind", () => {
  const cases: Array<[string, Parameters<typeof resolveViewerKind>[0], ReturnType<typeof resolveViewerKind>]> = [
    ["pdf", { path: "doc/report.pdf" }, "pdf"],
    ["png image", { path: "a/logo.png", previewKind: "image", isBinary: true }, "image"],
    ["jpg by extension", { path: "x.JPG" }, "image"],
    ["svg → image", { path: "icon.svg" }, "image"],
    ["csv", { path: "data/rows.csv" }, "csv"],
    ["tsv", { path: "data/rows.tsv" }, "csv"],
    ["markdown", { path: "README.md" }, "markdown"],
    ["mdx", { path: "page.mdx" }, "markdown"],
    ["plain code", { path: "src/index.ts" }, "code"],
    ["binary fallthrough", { path: "blob.bin", isBinary: true, previewKind: "binary" }, "binary"],
    ["oversized text → largeText", { path: "big.log", isPartial: true }, "largeText"],
    ["oversized code → largeText", { path: "huge.ts", isPartial: true }, "largeText"],
  ];

  for (const [name, ctx, expected] of cases) {
    it(`resolves ${name}`, () => {
      expect(resolveViewerKind(ctx)).toBe(expected);
    });
  }

  it("prefers csv over largeText for an oversized csv (csv viewer streams itself)", () => {
    expect(resolveViewerKind({ path: "huge.csv", isPartial: true })).toBe("csv");
  });

  it("prefers pdf/image over largeText regardless of partial flag", () => {
    expect(resolveViewerKind({ path: "huge.pdf", isPartial: true })).toBe("pdf");
    expect(resolveViewerKind({ path: "huge.png", previewKind: "image", isPartial: true })).toBe("image");
  });

  it("oversized markdown streams as largeText rather than rendering 5MB", () => {
    expect(resolveViewerKind({ path: "huge.md", isPartial: true })).toBe("largeText");
  });

  it("only the code viewer is editable", () => {
    expect(viewerIsEditable("code")).toBe(true);
    for (const kind of ["image", "markdown", "csv", "pdf", "largeText", "binary", "diff", "conflict"] as const) {
      expect(viewerIsEditable(kind)).toBe(false);
    }
  });
});
