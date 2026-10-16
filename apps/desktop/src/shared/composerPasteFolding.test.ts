import { describe, expect, it } from "vitest";
import { isPastedTextAttachmentFile, pastedTextAttachmentFile } from "./composerPasteFolding";

describe("pastedTextAttachmentFile", () => {
  it("stages the exact pasted text under the name iOS stages", async () => {
    const text = "line one\r\nline two\n";
    const file = pastedTextAttachmentFile(text);
    // `pasted-<epoch ms>.<ext>`. The staged file keeps this name, which is what
    // makes the agent's `[File #k: <name>]` label match the chip.
    expect(file.name).toMatch(/^pasted-\d+\.txt$/);
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe(text);
  });

  it("marks only the files it built, so a dropped file is not a paste", () => {
    expect(isPastedTextAttachmentFile(pastedTextAttachmentFile("x"))).toBe(true);
    expect(isPastedTextAttachmentFile(new File(["x"], "pasted-1.txt", { type: "text/plain" }))).toBe(false);
  });
});
