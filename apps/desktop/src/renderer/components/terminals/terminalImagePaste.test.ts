/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_PASTE_NOTICE_MS,
  attachClipboardImageToRuntime,
  pasteRuntimeClipboardImageAttachment,
  type TerminalImagePasteRuntime,
} from "./terminalImagePaste";

function makeRuntime(): TerminalImagePasteRuntime & { disposed: boolean } {
  return {
    sessionId: "session-1",
    runtimePin: null,
    disposed: false,
    imagePasteNotice: null,
    imagePasteNoticeTimer: null,
  };
}

describe("terminal image paste", () => {
  const saveTempAttachment = vi.fn();
  const readClipboardImage = vi.fn();
  let io: { notify: ReturnType<typeof vi.fn>; writeInput: ReturnType<typeof vi.fn> };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    io = { notify: vi.fn(), writeInput: vi.fn() };
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { agentChat: { saveTempAttachment }, app: { readClipboardImage } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    vi.clearAllMocks();
  });

  it("pastes the saved path as a bracketed stub and sends no pin for a bound session", async () => {
    saveTempAttachment.mockResolvedValue({ path: "/p/.ade/attachments/x.png" });
    const runtime = makeRuntime();

    await expect(attachClipboardImageToRuntime(runtime, io, {
      data: "data:image/png;base64,QUJD",
      filename: "clipboard.png",
      mimeType: "image/png",
    })).resolves.toBe(true);

    expect(saveTempAttachment).toHaveBeenCalledWith({ data: "QUJD", filename: "clipboard.png" }, undefined);
    expect(io.writeInput).toHaveBeenCalledWith(
      "\x1b[200~ADE clipboard image attached.\nPath: /p/.ade/attachments/x.png\nType: image/png\n\x1b[201~",
    );
  });

  it("shows why a save failed, counts it as handled, and clears the message after the timeout", async () => {
    saveTempAttachment.mockRejectedValue(new Error("Error: File \"clipboard.png\" is too large (20 MB). Maximum allowed size is 12 MB."));
    const runtime = makeRuntime();

    await expect(attachClipboardImageToRuntime(runtime, io, {
      data: "QUJD",
      filename: "clipboard.png",
      mimeType: "image/png",
    })).resolves.toBe(true);

    expect(io.writeInput).not.toHaveBeenCalled();
    expect(runtime.imagePasteNotice).toBe(
      "Couldn't attach the image: File \"clipboard.png\" is too large (20 MB). Maximum allowed size is 12 MB.",
    );
    expect(io.notify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(IMAGE_PASTE_NOTICE_MS);
    expect(runtime.imagePasteNotice).toBeNull();
    expect(io.notify).toHaveBeenCalledTimes(2);
  });

  it("gives a neutral reason when a clipboard read fails with none, since nothing was saved", async () => {
    readClipboardImage.mockRejectedValue(new Error(""));
    const runtime = makeRuntime();

    await expect(pasteRuntimeClipboardImageAttachment(runtime, io)).resolves.toBe(true);

    expect(saveTempAttachment).not.toHaveBeenCalled();
    expect(runtime.imagePasteNotice).toBe("Couldn't attach the image: no reason was given.");
    expect(warn).toHaveBeenCalledWith(
      "[ade-term] image paste failed session=session-1 machine=bound reason=no reason was given.",
    );
  });

  it("logs but shows nothing once the terminal is gone", async () => {
    saveTempAttachment.mockRejectedValue(new Error("Remote ADE service connection closed."));
    const runtime = makeRuntime();
    const pending = attachClipboardImageToRuntime(runtime, io, {
      data: "QUJD",
      filename: "clipboard.png",
      mimeType: "image/png",
    });
    runtime.disposed = true;
    await pending;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(runtime.imagePasteNotice).toBeNull();
    expect(io.notify).not.toHaveBeenCalled();
  });
});
