import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { adeRendererSenderState, isTrustedAdeRendererSender } from "./trustedRendererSender";

const ADE_RENDERER = "file:///Applications/ADE.app/Contents/Resources/app.asar/dist/renderer/index.html#/work";

type Frame = { url: string } | null;

function eventFor(frame: Frame | "disposed", opts: { contentsUrl?: string; destroyed?: boolean } = {}) {
  const senderFrame = frame === "disposed"
    ? Object.defineProperty({}, "url", {
        get() {
          throw new Error("Render frame was disposed before WebFrameMain could be accessed");
        },
      })
    : frame;
  return {
    sender: {
      isDestroyed: () => opts.destroyed === true,
      getURL: () => opts.contentsUrl ?? ADE_RENDERER,
    },
    senderFrame,
  } as any;
}

describe("adeRendererSenderState", () => {
  beforeEach(() => {
    delete process.env.VITE_DEV_SERVER_URL;
  });

  // The gate in front of every ADE-only IPC channel: only "trusted" runs the handler.
  it.each([
    ["ADE's renderer frame in a live window", () => eventFor({ url: ADE_RENDERER }), "trusted"],
    ["no frame, the window's contents are ADE's renderer", () => eventFor(null), "trusted"],
    // A frame disposed under the call must never borrow the window's URL and pass.
    ["a frame whose URL read throws (disposed)", () => eventFor("disposed"), "gone"],
    ["a frame with no page yet", () => eventFor({ url: "" }), "gone"],
    ["a destroyed WebContents", () => eventFor({ url: ADE_RENDERER }, { destroyed: true }), "gone"],
    ["a foreign page in ADE's window", () => eventFor({ url: "https://example.com/" }), "untrusted"],
    ["a foreign subframe whose window is ADE's", () => eventFor({ url: "https://example.com/" }, { contentsUrl: ADE_RENDERER }), "untrusted"],
  ])("%s", (_name, makeEvent, expected) => {
    const event = makeEvent();
    expect(adeRendererSenderState(event)).toBe(expected);
    expect(isTrustedAdeRendererSender(event)).toBe(expected === "trusted");
  });
});
