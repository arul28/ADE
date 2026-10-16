import { describe, expect, it } from "vitest";
import {
  attachmentIndexForOrdinal,
  formatAttachedImageLegend,
  formatAttachmentToken,
  isImageAttachmentRef,
  labelAttachments,
  labelAttachmentsByRef,
  parseAttachmentTokens,
  renumberAttachmentTokens,
  resolveAttachmentToken,
} from "./attachmentLabels";

/** `AgentChatFileRef`-shaped refs, which is what every caller passes. */
const image = (path: string) => ({ type: "image", path });
const imageUrl = (url: string) => ({ type: "image-url", path: url, url });
const file = (path: string) => ({ type: "file", path });

describe("labelAttachments", () => {
  it("numbers images and files separately, in list order", () => {
    const attachments = [
      file("/lane/notes.md"),
      image("/lane/a.png"),
      file("/lane/config.json"),
      image("/lane/b.png"),
    ];
    expect(labelAttachments(attachments).map((label) => label.token)).toEqual([
      "[File #1: notes.md]",
      "[Image #1]",
      "[File #2: config.json]",
      "[Image #2]",
    ]);
  });

  it("counts an image-url as an image, named from the URL's last segment", () => {
    const url = "https://example.test/screens/diagram.png";
    const labels = labelAttachments([image("/lane/a.png"), imageUrl(url)]);
    expect(isImageAttachmentRef({ type: "image-url" })).toBe(true);
    expect(labels[1]).toMatchObject({ kind: "image", ordinal: 2, token: "[Image #2]" });
    expect(labels[1]!.name).toBe("diagram.png");
  });

  it("keeps the labels parallel to the input so a filtered walk still numbers right", () => {
    const attachments = [image("/lane/a.png"), file("/lane/notes.md")];
    const byRef = labelAttachmentsByRef(attachments);
    // The file is `#1` among files even though an image precedes it, which is
    // what lets a builder label a filtered subset against the whole list.
    expect(byRef.get(attachments[1] as typeof attachments[number])?.token).toBe("[File #1: notes.md]");
  });
});

describe("file token names", () => {
  it("replaces the characters that would end or split the token", () => {
    // A file called `a]b.txt` must not close the token early and leave `b.txt]`
    // behind as stray prompt text.
    const token = formatAttachmentToken("file", 1, "a]b[c\rd\ne.txt");
    expect(token).toBe("[File #1: a_b_c_d_e.txt]");
    expect(parseAttachmentTokens(token)).toHaveLength(1);
    expect(parseAttachmentTokens(token)[0]).toMatchObject({ kind: "file", ordinal: 1, name: "a_b_c_d_e.txt" });
  });
});

describe("resolveAttachmentToken", () => {
  it("finds nothing for an ordinal with no attachment, so the token stays text", () => {
    const attachments = [image("/lane/a.png"), image("/lane/b.png")];
    // A draft restored against a shorter list: `[Image #3]` is syntactically
    // fine but resolves to nothing, which is what keeps it plain text.
    const [token] = parseAttachmentTokens("look at [Image #3] please");
    expect(token).toMatchObject({ kind: "image", ordinal: 3 });
    expect(resolveAttachmentToken(attachments, token!)).toBeNull();
    expect(resolveAttachmentToken(attachments, { kind: "image", ordinal: 2 })).toEqual(attachments[1]);
  });

  it("never matches a file ordinal against an image", () => {
    const attachments = [image("/lane/a.png"), file("/lane/notes.md")];
    expect(attachmentIndexForOrdinal(attachments, "file", 1)).toBe(1);
    expect(attachmentIndexForOrdinal(attachments, "image", 2)).toBe(-1);
  });
});

describe("renumberAttachmentTokens", () => {
  it("follows an attachment to its new number, and drops a removed one's token", () => {
    const a = image("/lane/a.png");
    const b = image("/lane/b.png");
    const c = image("/lane/c.png");
    expect(renumberAttachmentTokens("see [Image #1] and [Image #3].", [a, b, c], [b, c]))
      .toBe("see  and [Image #2].");
  });

  it("leaves a token that never resolved exactly as it was", () => {
    const a = image("/lane/a.png");
    expect(renumberAttachmentTokens("literal [Image #9] here", [a], [a]))
      .toBe("literal [Image #9] here");
  });
});

describe("formatAttachedImageLegend", () => {
  it("names the images in order and skips files", () => {
    const labels = labelAttachments([
      image("/lane/a.png"),
      file("/lane/notes.md"),
      imageUrl("https://example.test/b.png"),
    ]);
    expect(formatAttachedImageLegend(labels))
      .toBe("Attached images, in order: [Image #1] a.png, [Image #2] b.png");
  });

  it("is empty when the turn carries no image", () => {
    expect(formatAttachedImageLegend(labelAttachments([file("/lane/notes.md")]))).toBe("");
  });
});
