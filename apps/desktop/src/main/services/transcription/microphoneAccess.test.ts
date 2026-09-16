import { describe, expect, it, vi } from "vitest";
import { requestMicrophoneAccess } from "./microphoneAccess";

/** The three macOS statuses that are not "granted", and who owns each answer. */
function preferences(status: string, granted = false) {
  return {
    getMediaAccessStatus: vi.fn(() => status as never),
    askForMediaAccess: vi.fn(async () => granted),
  };
}

describe("requestMicrophoneAccess", () => {
  it("reports the Windows global Win32 microphone policy", async () => {
    const deps = preferences("denied");

    await expect(requestMicrophoneAccess("win32", deps, { isPackaged: true }))
      .resolves.toEqual({ status: "denied", block: "os-denied" });
    expect(deps.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("keeps a Windows development build on the settings sentence", async () => {
    // Windows privacy for desktop apps is one global switch covering every
    // binary, an unsigned Electron included — so the pane really is the fix and
    // "start it from a terminal" would be false advice.
    const deps = preferences("denied");

    await expect(requestMicrophoneAccess("win32", deps, { isPackaged: false }))
      .resolves.toEqual({ status: "denied", block: "os-denied" });
  });

  it("lets Chromium handle Windows microphone access when the global policy is inconclusive", async () => {
    const deps = preferences("unknown");

    await expect(requestMicrophoneAccess("win32", deps, { isPackaged: true }))
      .resolves.toEqual({ status: "granted", block: null });
    expect(deps.askForMediaAccess).not.toHaveBeenCalled();
  });

  it("raises the real OS prompt for an undetermined macOS status", async () => {
    // The one status worth acting on: nobody has been asked yet, and this call
    // is where the prompt comes from.
    const deps = preferences("not-determined", true);

    await expect(requestMicrophoneAccess("darwin", deps, { isPackaged: true }))
      .resolves.toEqual({ status: "granted", block: null });
    expect(deps.askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("calls a refused prompt on a packaged build something the user can grant", async () => {
    const deps = preferences("not-determined", false);

    await expect(requestMicrophoneAccess("darwin", deps, { isPackaged: true }))
      .resolves.toEqual({ status: "denied", block: "os-denied" });
  });

  it("calls the same refusal on an unpackaged build a development build", async () => {
    // `com.github.Electron` has no TCC identity, so this returns false without
    // ever prompting — and the System Settings entry the user is looking at
    // belongs to the packaged app, not to this binary.
    const deps = preferences("not-determined", false);

    await expect(requestMicrophoneAccess("darwin", deps, { isPackaged: false }))
      .resolves.toEqual({ status: "denied", block: "dev-build" });
    expect(deps.askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("attributes a settled macOS denial by who can undo it", async () => {
    for (const status of ["denied", "restricted"] as const) {
      await expect(requestMicrophoneAccess("darwin", preferences(status), { isPackaged: true }))
        .resolves.toEqual({ status, block: "os-denied" });
      await expect(requestMicrophoneAccess("darwin", preferences(status), { isPackaged: false }))
        .resolves.toEqual({ status, block: "dev-build" });
    }
  });

  it("treats a throwing prompt as a refusal rather than a crash", async () => {
    const deps = {
      getMediaAccessStatus: vi.fn(() => "not-determined" as never),
      askForMediaAccess: vi.fn(async () => { throw new Error("no TCC"); }),
    };

    await expect(requestMicrophoneAccess("darwin", deps, { isPackaged: false }))
      .resolves.toEqual({ status: "denied", block: "dev-build" });
  });

  it("leaves unsupported platforms to Chromium permission handling", async () => {
    const deps = preferences("denied");

    await expect(requestMicrophoneAccess("linux", deps, { isPackaged: true }))
      .resolves.toEqual({ status: "granted", block: null });
    expect(deps.getMediaAccessStatus).not.toHaveBeenCalled();
  });
});
