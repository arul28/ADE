import { describe, expect, it, vi } from "vitest";
import { requestMicrophoneAccess } from "./microphoneAccess";

describe("requestMicrophoneAccess", () => {
  it("reports the Windows global Win32 microphone policy", async () => {
    const getMediaAccessStatus = vi.fn(() => "denied" as const);
    const askForMediaAccess = vi.fn();

    await expect(requestMicrophoneAccess("win32", {
      getMediaAccessStatus,
      askForMediaAccess,
    })).resolves.toEqual({ status: "denied" });
    expect(getMediaAccessStatus).toHaveBeenCalledWith("microphone");
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });

  it("lets Chromium handle Windows microphone access when the global policy is inconclusive", async () => {
    const getMediaAccessStatus = vi.fn(() => "unknown" as const);
    const askForMediaAccess = vi.fn();

    await expect(requestMicrophoneAccess("win32", {
      getMediaAccessStatus,
      askForMediaAccess,
    })).resolves.toEqual({ status: "granted" });
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });

  it("requests undetermined macOS microphone access", async () => {
    const getMediaAccessStatus = vi.fn(() => "not-determined" as const);
    const askForMediaAccess = vi.fn(async () => true);

    await expect(requestMicrophoneAccess("darwin", {
      getMediaAccessStatus,
      askForMediaAccess,
    })).resolves.toEqual({ status: "granted" });
    expect(askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("leaves unsupported platforms to Chromium permission handling", async () => {
    const getMediaAccessStatus = vi.fn();
    const askForMediaAccess = vi.fn();

    await expect(requestMicrophoneAccess("linux", {
      getMediaAccessStatus,
      askForMediaAccess,
    })).resolves.toEqual({ status: "granted" });
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
  });
});
