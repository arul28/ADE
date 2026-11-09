import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import { attachClipboardImageToRuntime, type TerminalImagePasteRuntime } from "./terminalImagePaste";

const REMOTE_PIN = { kind: "remote", key: "remote:studio:proj", targetId: "studio", projectId: "proj" } as OpenProjectBinding;

function makeRuntime(): TerminalImagePasteRuntime {
  return {
    sessionId: "session-1",
    runtimePin: REMOTE_PIN,
    disposed: false,
    imagePasteNotice: null,
    imagePasteNoticeTimer: null,
  };
}

describe("image paste into a plain shell on another machine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The pasted text is typed at a shell prompt on the session's machine, which
  // can be POSIX or Windows (cmd, PowerShell, Git Bash). A path the shell
  // reads differently names no file, and the paste then attaches nothing.
  it.each([
    ["a plain POSIX path", "/Users/me/proj/.ade/attachments/a.png", "/Users/me/proj/.ade/attachments/a.png "],
    ["a POSIX path with a space", "/Users/me/My Proj/a.png", "'/Users/me/My Proj/a.png' "],
    ["a POSIX path with an apostrophe", "/Users/me/it's/a.png", "'/Users/me/it'\\''s/a.png' "],
    // Git Bash drops an unquoted backslash, so a drive path is never bare.
    ["a Windows drive path", "C:\\Users\\me\\proj\\a.png", "\"C:\\Users\\me\\proj\\a.png\" "],
    ["a Windows drive path with a space", "C:\\Users\\me\\My Proj\\a.png", "\"C:\\Users\\me\\My Proj\\a.png\" "],
    ["a UNC path", "\\\\host\\share\\a.png", "\"\\\\host\\share\\a.png\" "],
  ])("saves the image on the session's machine and pastes %s as one shell word", async (_label, savedPath, pasted) => {
    const saveTempAttachment = vi.fn(async () => ({ path: savedPath }));
    vi.stubGlobal("window", { ade: { agentChat: { saveTempAttachment } } });
    const io = { notify: vi.fn(), writeInput: vi.fn(), pasteText: vi.fn() };

    const handled = await attachClipboardImageToRuntime(
      makeRuntime(),
      io,
      { data: "data:image/png;base64,aGVsbG8=", filename: "clipboard.png", mimeType: "image/png" },
      "path",
    );

    expect(handled).toBe(true);
    // The bytes go to the machine the shell runs on, as bare base64.
    expect(saveTempAttachment).toHaveBeenCalledWith({ data: "aGVsbG8=", filename: "clipboard.png" }, REMOTE_PIN);
    // No newline: at a prompt it would run the line.
    expect(io.pasteText).toHaveBeenCalledTimes(1);
    expect(io.pasteText).toHaveBeenCalledWith(pasted);
    // The agent stub is for a tracked agent CLI only.
    expect(io.writeInput).not.toHaveBeenCalled();
  });
});
