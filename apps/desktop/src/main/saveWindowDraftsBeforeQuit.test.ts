import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_WILL_QUIT_EVENT } from "../shared/appWillQuit";
import { saveWindowDraftsBeforeQuit } from "./saveWindowDraftsBeforeQuit";

function fakeWindow(state: { destroyed?: boolean; crashed?: boolean; answer: () => Promise<unknown> }) {
  const executeJavaScript = vi.fn(state.answer);
  const win = {
    isDestroyed: () => state.destroyed === true,
    webContents: {
      isDestroyed: () => state.destroyed === true,
      isCrashed: () => state.crashed === true,
      executeJavaScript,
    },
  } as unknown as BrowserWindow;
  return { win, executeJavaScript };
}

describe("saveWindowDraftsBeforeQuit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks every live window to save, and a window that never answers holds Quit for 500 ms at most", async () => {
    vi.useFakeTimers();
    const answers = fakeWindow({ answer: () => Promise.resolve(undefined) });
    const fails = fakeWindow({ answer: () => Promise.reject(new Error("render frame was disposed")) });
    const hung = fakeWindow({ answer: () => new Promise(() => {}) });
    const destroyed = fakeWindow({ destroyed: true, answer: () => Promise.resolve(undefined) });
    const crashed = fakeWindow({ crashed: true, answer: () => Promise.resolve(undefined) });
    const warn = vi.fn();

    let done = false;
    const saving = saveWindowDraftsBeforeQuit(
      [answers.win, fails.win, hung.win, destroyed.win, crashed.win],
      warn,
    ).then(() => { done = true; });

    expect(answers.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining(APP_WILL_QUIT_EVENT));
    expect(hung.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(destroyed.executeJavaScript).not.toHaveBeenCalled();
    expect(crashed.executeJavaScript).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await saving;
    expect(done).toBe(true);
    expect(warn).toHaveBeenCalledWith("desktop.quit_window_drafts_failed", { errorText: "render frame was disposed" });
    expect(warn).toHaveBeenCalledWith("desktop.quit_window_drafts_timeout", { windows: 3, limitMs: 500 });
  });
});
