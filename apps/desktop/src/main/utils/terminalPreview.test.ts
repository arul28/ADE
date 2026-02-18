import { describe, expect, it } from "vitest";
import { derivePreviewFromChunk } from "./terminalPreview";

describe("derivePreviewFromChunk", () => {
  it("extracts the latest visible line for standard output", () => {
    const out = derivePreviewFromChunk({
      previousLine: "",
      previousPreview: null,
      chunk: "line one\nline two\n"
    });
    expect(out.preview).toBe("line two");
  });

  it("handles carriage-return progress updates", () => {
    const out = derivePreviewFromChunk({
      previousLine: "",
      previousPreview: null,
      chunk: "Downloading 10%\rDownloading 70%\rDownloading 100%\n"
    });
    expect(out.preview).toBe("Downloading 100%");
  });

  it("strips ANSI formatting before extracting preview", () => {
    const out = derivePreviewFromChunk({
      previousLine: "",
      previousPreview: null,
      chunk: "\u001b[31mERROR\u001b[0m permission denied\n"
    });
    expect(out.preview).toBe("ERROR permission denied");
  });

  it("continues partial lines across chunks", () => {
    const first = derivePreviewFromChunk({
      previousLine: "",
      previousPreview: null,
      chunk: "Waiting for input"
    });
    const second = derivePreviewFromChunk({
      previousLine: first.nextLine,
      previousPreview: first.preview,
      chunk: "...\n"
    });
    expect(second.preview).toBe("Waiting for input...");
  });
});
