// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";

/** The machine every call names. The browser mock has one machine. */
const TEST_PIN = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as const;

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
    const created = await window.ade.agentChat.drafts.create({
      text: "Use this reference",
      attachments: [{ path: imageUrl, type: "image-url", url: imageUrl }],
      provider: "codex",
      modelId: "openai/gpt-5.6-sol",
    }, TEST_PIN);

    expect(created).toMatchObject({
      text: "Use this reference",
      attachments: [{ path: imageUrl, type: "image-url", url: imageUrl }],
      attachmentCount: 1,
      attachmentsAvailable: true,
    });
    await expect(window.ade.agentChat.drafts.list(TEST_PIN)).resolves.toContainEqual(created);
    await expect(window.ade.agentChat.drafts.delete({ id: created.id }, TEST_PIN)).resolves.toBe(true);
    await expect(window.ade.agentChat.drafts.list(TEST_PIN)).resolves.not.toContainEqual(created);
  });

  it("returns valid image data and round-trips a saved local image attachment", async () => {
    const { dataUrl } = await window.ade.agentChat.getImageDataUrl("/tmp/reference.png", TEST_PIN);
    expect(dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);

    const saved = await window.ade.agentChat.saveTempAttachment({
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      filename: "reference.png",
    }, TEST_PIN);
    const created = await window.ade.agentChat.drafts.create({
      text: "",
      attachments: [{ path: saved.path, type: "image" }],
    }, TEST_PIN);

    await expect(window.ade.agentChat.drafts.list(TEST_PIN)).resolves.toContainEqual(
      expect.objectContaining({
        id: created.id,
        attachments: [{ path: saved.path, type: "image" }],
        attachmentCount: 1,
        attachmentsAvailable: true,
      }),
    );
    await expect(window.ade.agentChat.drafts.delete({ id: created.id }, TEST_PIN)).resolves.toBe(true);
    await expect(window.ade.agentChat.drafts.list(TEST_PIN)).resolves.not.toContainEqual(created);
  });
});

describe("browserMock proof contracts", () => {
  it("returns complete delete, prune, and recovery results", async () => {
    await expect(window.ade.computerUse.deleteArtifacts({ artifactId: "proof-1" }, TEST_PIN)).resolves.toEqual({
      deleted: [],
      missing: [],
      failed: [],
      freedBytes: 0,
    });
    await expect(window.ade.computerUse.pruneBrokenArtifacts()).resolves.toEqual({
      deleted: [],
      missing: [],
      failed: [],
      freedBytes: 0,
    });
    await expect(window.ade.computerUse.recoverArtifact({ artifactId: "proof-1" }, TEST_PIN)).resolves.toMatchObject({
      id: "browser-proof-recovered",
      availability: "available",
      links: [],
      reviewState: "pending",
      workflowState: "evidence_only",
    });
  });
});

describe("browserMock iOS Simulator bridge", () => {
  it("answers the Apple device reads the preview can actually serve", async () => {
    // The window-capture era's methods — window state, window sources, the
    // parking holds, Reveal, and the Screen Recording pane opener — are gone
    // from the bridge along with the backend that needed them.
    await expect(window.ade.iosSimulator.getStreamStatus(TEST_PIN)).resolves.toMatchObject({ streaming: false });
    await expect(window.ade.iosSimulator.tap({ x: 1, y: 1 }, TEST_PIN)).resolves.toEqual({ ok: true });
  });
});
