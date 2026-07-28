// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./browserRuntimeBridge", () => ({
  attachBrowserRuntimeBridge: vi.fn(async () => false),
}));

beforeAll(async () => {
  const browserWindow = window as unknown as {
    ade?: unknown;
    __adeBrowserMock?: boolean;
  };
  delete browserWindow.ade;
  delete browserWindow.__adeBrowserMock;
  await import("./browserMock");
});

describe("browserMock prompt stashes", () => {
  it("round-trips image URL attachments through create, list, and delete", async () => {
    const imageUrl = "https://example.com/reference.png";
    const created = await window.ade.agentChat.promptStashes.create({
      text: "Use this reference",
      attachments: [{ path: imageUrl, type: "image-url", url: imageUrl }],
      provider: "codex",
      modelId: "openai/gpt-5.6-sol",
    });

    expect(created).toMatchObject({
      text: "Use this reference",
      attachments: [{ path: imageUrl, type: "image-url", url: imageUrl }],
      attachmentCount: 1,
      attachmentsAvailable: true,
    });
    await expect(window.ade.agentChat.promptStashes.list()).resolves.toContainEqual(created);
    await expect(window.ade.agentChat.promptStashes.delete({ id: created.id })).resolves.toBe(true);
    await expect(window.ade.agentChat.promptStashes.list()).resolves.not.toContainEqual(created);
  });

  it("returns valid image data and round-trips a saved local image attachment", async () => {
    const { dataUrl } = await window.ade.agentChat.getImageDataUrl("/tmp/reference.png");
    expect(dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);

    const saved = await window.ade.agentChat.saveTempAttachment({
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      filename: "reference.png",
    });
    const created = await window.ade.agentChat.promptStashes.create({
      text: "",
      attachments: [{ path: saved.path, type: "image" }],
    });

    await expect(window.ade.agentChat.promptStashes.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: created.id,
        attachments: [{ path: saved.path, type: "image" }],
        attachmentCount: 1,
        attachmentsAvailable: true,
      }),
    );
    await expect(window.ade.agentChat.promptStashes.delete({ id: created.id })).resolves.toBe(true);
    await expect(window.ade.agentChat.promptStashes.list()).resolves.not.toContainEqual(created);
  });
});
