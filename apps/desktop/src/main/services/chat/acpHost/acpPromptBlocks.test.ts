import { describe, expect, it } from "vitest";
import { buildAcpPromptBlocks, type AcpResolvedAttachment } from "./acpPromptBlocks";

const imagePrompt = ({
  base64Data,
  mimeType,
  uri,
}: {
  base64Data: string;
  mimeType: string;
  uri?: string | null;
}) => ({
  type: "image" as const,
  data: base64Data,
  mimeType,
  ...(uri ? { uri } : {}),
});

function attachment(
  path: string,
  type: AcpResolvedAttachment["type"],
  extra: Partial<AcpResolvedAttachment> = {},
): AcpResolvedAttachment {
  return {
    path,
    type,
    _resolvedPath: path,
    _rootPath: "/lane",
    ...extra,
  } as AcpResolvedAttachment;
}

describe("buildAcpPromptBlocks", () => {
  it("sends supported local images as ACP image blocks", async () => {
    const blocks = await buildAcpPromptBlocks({
      promptText: "Describe this image.",
      attachments: [attachment("assets/example.png", "image")],
      agentSupportsImages: true,
      imagePrompt,
      readAttachmentBytes: async () => Buffer.from("png-bytes"),
    });

    expect(blocks).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("keeps unsupported images visible as an explicit provider hint", async () => {
    const blocks = await buildAcpPromptBlocks({
      promptText: "Review the attachment.",
      attachments: [attachment("assets/example.png", "image")],
      agentSupportsImages: false,
      imagePrompt: null,
      readAttachmentBytes: async () => Buffer.from("png-bytes"),
    });

    expect(blocks).toEqual([
      { type: "text", text: "Review the attachment." },
      {
        type: "text",
        text: "\nImage attachment omitted: assets/example.png (this provider does not support image prompts).",
      },
    ]);
  });

  it("forwards image URLs through the dialect image behavior without downloading them", async () => {
    const blocks = await buildAcpPromptBlocks({
      promptText: "Review the remote image.",
      attachments: [attachment("https://example.test/image.webp", "image-url", {
        url: "https://example.test/image.webp",
      })],
      agentSupportsImages: true,
      imagePrompt,
      readAttachmentBytes: async () => {
        throw new Error("the URL must not be downloaded by the host");
      },
    });

    expect(blocks).toEqual([
      { type: "text", text: "Review the remote image." },
      {
        type: "image",
        data: "",
        mimeType: "image/webp",
        uri: "https://example.test/image.webp",
      },
    ]);
  });

  it("includes bounded text files in the ACP request", async () => {
    const blocks = await buildAcpPromptBlocks({
      promptText: "Review the file.",
      attachments: [attachment("README.md", "file")],
      agentSupportsImages: false,
      imagePrompt: null,
      readAttachmentBytes: async () => Buffer.from("# Hello"),
    });

    expect(blocks).toEqual([
      { type: "text", text: "Review the file." },
      { type: "text", text: "\n[File: README.md]\n# Hello" },
    ]);
  });
});
