import { describe, expect, it } from "vitest";
import { contentSupportsTextEditing, resolveViewerKind, tabIsTextEditable, viewerIsEditable } from "./viewerRegistry";

describe("resolveViewerKind", () => {
  const cases: Array<[string, Parameters<typeof resolveViewerKind>[0], ReturnType<typeof resolveViewerKind>]> = [
    ["pdf", { path: "doc/report.pdf" }, "pdf"],
    ["png image", { path: "a/logo.png", previewKind: "image", isBinary: true }, "image"],
    ["jpg by extension", { path: "x.JPG" }, "image"],
    ["svg → image", { path: "icon.svg" }, "image"],
    ["audio by extension", { path: "soundtrack.mp3", isBinary: true }, "audio"],
    ["audio by mime", { path: "soundtrack.bin", mimeType: "audio/wav", isBinary: true }, "audio"],
    ["video by extension", { path: "demo.mov", isBinary: true }, "video"],
    ["video by mime", { path: "demo.bin", mimeType: "video/mp4", isBinary: true }, "video"],
    ["csv", { path: "data/rows.csv" }, "csv"],
    ["tsv", { path: "data/rows.tsv" }, "csv"],
    ["word document", { path: "docs/spec.docx", isBinary: true }, "document"],
    ["powerpoint document", { path: "deck.pptx", isBinary: true }, "document"],
    ["excel document", { path: "budget.xlsx", isBinary: true }, "document"],
    ["html", { path: "public/index.html" }, "html"],
    ["htm", { path: "legacy/index.htm" }, "html"],
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

  it("oversized HTML streams as largeText rather than constructing a large iframe document", () => {
    expect(resolveViewerKind({ path: "huge.html", isPartial: true })).toBe("largeText");
  });

  it("text-backed viewers (code, markdown source, HTML source, csv source) are editable; others stay read-only viewers", () => {
    for (const kind of ["code", "markdown", "html", "csv"] as const) {
      expect(viewerIsEditable(kind)).toBe(true);
    }
    for (const kind of ["image", "pdf", "audio", "video", "document", "largeText", "binary", "diff", "conflict"] as const) {
      expect(viewerIsEditable(kind)).toBe(false);
    }
  });

  it("editability requires a full text payload — honest boundaries, not trust gates", () => {
    const fullText = { isBinary: false, isPartial: false, encoding: "utf-8" };
    // Writable text-backed files are editable immediately: no trust toggle,
    // no enable-editing step, no read-only default.
    expect(tabIsTextEditable("code", fullText)).toBe(true);
    expect(tabIsTextEditable("markdown", fullText)).toBe(true);
    expect(tabIsTextEditable("html", fullText)).toBe(true);
    expect(tabIsTextEditable("csv", fullText)).toBe(true);
    // A partial (streamed) buffer would truncate the file on save.
    expect(contentSupportsTextEditing({ ...fullText, isPartial: true })).toBe(false);
    expect(tabIsTextEditable("csv", { ...fullText, isPartial: true })).toBe(false);
    // Binary/base64/omitted payloads cannot round-trip through the text editor.
    expect(contentSupportsTextEditing({ ...fullText, isBinary: true })).toBe(false);
    expect(contentSupportsTextEditing({ ...fullText, encoding: "base64" })).toBe(false);
    expect(contentSupportsTextEditing({ ...fullText, contentOmitted: true })).toBe(false);
    // Non-text viewers stay read-only even with a full text payload.
    expect(tabIsTextEditable("binary", fullText)).toBe(false);
    expect(tabIsTextEditable("image", fullText)).toBe(false);
  });
});
