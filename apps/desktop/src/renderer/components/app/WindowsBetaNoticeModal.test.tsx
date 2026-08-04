/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AppInfo } from "../../../shared/types/core";
import { WindowsBetaNoticeHost, WindowsBetaNoticeModal } from "./WindowsBetaNoticeModal";
import { requestWindowsBetaNotice } from "../../lib/windowsBetaNotice";

const originalAde = globalThis.window.ade;

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    appVersion: "1.2.51",
    packageChannel: "beta",
    isPackaged: true,
    automationsEnabled: true,
    platform: "win32",
    arch: "x64",
    versions: { electron: "33.2.0", chrome: "130.0.0.0", node: "20.18.0", v8: "13.0.0" },
    env: {},
    localRuntime: null,
    ...overrides,
  };
}

/**
 * The platform is injected rather than sniffed: the host reads the synchronous
 * preload bridge in production, and the tests drive both real platforms through
 * the same seam (same pattern as main/services/shared/pathCompare.test.ts).
 */
function installAde(packageChannel: string, platform = "win32") {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const getInfo = vi.fn(async () => appInfo({ platform: platform as AppInfo["platform"] }));
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: {
      packageChannel,
      getInfo,
      openExternal,
      runtimeTarget: { platform, arch: "x64" },
    },
  };
  return { openExternal, getInfo };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalAde === undefined) {
    delete (globalThis.window as unknown as { ade?: unknown }).ade;
  } else {
    (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
  }
});

describe("WindowsBetaNoticeHost platform/channel matrix", () => {
  it("opens on a Windows STABLE install — the notice is about the platform, not the channel", () => {
    installAde("stable", "win32");
    render(<WindowsBetaNoticeHost platform="win32" channel="stable" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("ADE on Windows is in beta")).toBeTruthy();
  });

  it("opens on a Windows beta build too", () => {
    installAde("beta", "win32");
    render(<WindowsBetaNoticeHost platform="win32" channel="beta" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders nothing on a macOS BETA build, and issues no IPC", () => {
    const { getInfo } = installAde("beta", "darwin");
    const { container } = render(<WindowsBetaNoticeHost platform="darwin" channel="beta" />);
    expect(container.firstChild).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("renders nothing on a macOS stable install, and issues no IPC", () => {
    const { getInfo } = installAde("stable", "darwin");
    const { container } = render(<WindowsBetaNoticeHost platform="darwin" channel="stable" />);
    expect(container.firstChild).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("renders nothing on Linux, and issues no IPC", () => {
    const { getInfo } = installAde("alpha", "linux");
    const { container } = render(<WindowsBetaNoticeHost platform="linux" channel="alpha" />);
    expect(container.firstChild).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("falls back to the preload runtime target when no platform is injected", () => {
    installAde("stable", "win32");
    render(<WindowsBetaNoticeHost />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("WindowsBetaNoticeHost open/close", () => {
  it("opens again on the next start after being dismissed", () => {
    installAde("stable", "win32");
    // A start is a fresh mount; the notice is deliberately not persisted.
    const first = render(<WindowsBetaNoticeHost platform="win32" channel="stable" />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();

    render(<WindowsBetaNoticeHost platform="win32" channel="stable" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("re-opens when a surface asks for it", () => {
    installAde("stable", "win32");
    render(<WindowsBetaNoticeHost platform="win32" channel="stable" />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestWindowsBetaNotice());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("ignores an open request off Windows", () => {
    installAde("beta", "darwin");
    render(<WindowsBetaNoticeHost platform="darwin" channel="beta" />);
    act(() => requestWindowsBetaNotice());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("WindowsBetaNoticeModal", () => {
  it("never shows release-channel vocabulary", () => {
    installAde("alpha");
    render(
      <WindowsBetaNoticeModal
        channel="alpha"
        onClose={() => {}}
        appInfoOverride={appInfo({ packageChannel: "alpha" })}
        osReleaseOverride="Windows 11"
      />,
    );
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("ADE on Windows is in beta");
    // The one place an "alpha"/"beta" token may appear is the ADE home PATH of a
    // dev build; no channel label is rendered as chrome.
    expect(text.replace(/~\/\.ade-alpha/g, "")).not.toMatch(/alpha/i);
    expect(text).not.toMatch(/beta 1\.2\.51|1\.2\.51 beta/i);
  });

  it("states the separate ADE home on a channel build that has one", () => {
    installAde("alpha");
    render(
      <WindowsBetaNoticeModal
        channel="alpha"
        onClose={() => {}}
        appInfoOverride={appInfo({ packageChannel: "alpha" })}
        osReleaseOverride={null}
      />,
    );
    expect(screen.getByText(/~\/\.ade-alpha/)).toBeTruthy();
  });

  it("does NOT claim a separate ADE home on a stable install", () => {
    installAde("stable");
    render(
      <WindowsBetaNoticeModal
        channel="stable"
        onClose={() => {}}
        appInfoOverride={appInfo({ packageChannel: "stable" })}
        osReleaseOverride={null}
      />,
    );
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).not.toMatch(/separate ADE home/);
    expect(text).not.toMatch(/~\/\.ade/);
  });

  it("opens the prefilled issue URL through the external-link bridge, and still reports the channel", async () => {
    const { openExternal } = installAde("stable");
    render(
      <WindowsBetaNoticeModal
        channel="stable"
        onClose={() => {}}
        appInfoOverride={appInfo({ packageChannel: "stable" })}
        osReleaseOverride="Windows 11 (platformVersion 15.0.0)"
      />,
    );
    fireEvent.click(screen.getByText("Report a bug"));
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    const url = openExternal.mock.calls[0]?.[0] ?? "";
    expect(url.startsWith("https://github.com/arul28/ADE/issues/new?")).toBe(true);
    const body = new URL(url).searchParams.get("body") ?? "";
    expect(body).toContain("ADE version: 1.2.51");
    expect(body).toContain("Package channel: stable");
    expect(body).toContain("OS release: Windows 11 (platformVersion 15.0.0)");
  });

  it("opens the Windows gaps doc through the external-link bridge", async () => {
    const { openExternal } = installAde("stable");
    render(
      <WindowsBetaNoticeModal
        channel="stable"
        onClose={() => {}}
        appInfoOverride={appInfo()}
        osReleaseOverride={null}
      />,
    );
    fireEvent.click(screen.getByText("Known gaps on Windows"));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/arul28/ADE/blob/main/docs/development/windows-support.md",
      ),
    );
  });

  it("closes on Escape", () => {
    installAde("stable");
    const onClose = vi.fn();
    render(
      <WindowsBetaNoticeModal
        channel="stable"
        onClose={onClose}
        appInfoOverride={appInfo()}
        osReleaseOverride={null}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
