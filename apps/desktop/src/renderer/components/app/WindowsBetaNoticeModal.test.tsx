/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AppInfo } from "../../../shared/types/core";
import { ChannelNoticeHost, ChannelNoticeModal } from "./ChannelNoticeModal";
import { requestChannelNotice } from "../../lib/packageChannel";

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

describe("ChannelNoticeHost", () => {
  it("renders nothing on stable and issues no IPC", () => {
    const { getInfo } = installAde("stable");
    const { container } = render(<ChannelNoticeHost />);
    expect(container.firstChild).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("opens on start for a beta build", () => {
    installAde("beta");
    render(<ChannelNoticeHost />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens again on the next start after being dismissed", () => {
    installAde("beta");
    // A start is a fresh mount; the notice is deliberately not persisted.
    const first = render(<ChannelNoticeHost />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();

    render(<ChannelNoticeHost />);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("re-opens when the header badge asks for it", () => {
    installAde("beta");
    render(<ChannelNoticeHost />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestChannelNotice());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("ignores the badge request on stable", () => {
    installAde("stable");
    render(<ChannelNoticeHost />);
    act(() => requestChannelNotice());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ChannelNoticeModal", () => {
  it("names Windows only on Windows", () => {
    installAde("beta");
    render(
      <ChannelNoticeModal
        channel="beta"
        platform="win32"
        onClose={() => {}}
        appInfoOverride={appInfo()}
        osReleaseOverride="Windows 11"
      />,
    );
    expect(screen.getByText("ADE on Windows is an early beta.")).toBeTruthy();
  });

  it("uses neutral copy on other platforms", () => {
    installAde("beta", "darwin");
    render(
      <ChannelNoticeModal
        channel="beta"
        platform="darwin"
        onClose={() => {}}
        appInfoOverride={appInfo({ platform: "darwin" })}
        osReleaseOverride="macOS 15"
      />,
    );
    expect(screen.getByText("This is an early beta build of ADE.")).toBeTruthy();
    expect(screen.queryByText("ADE on Windows is an early beta.")).toBeNull();
  });

  it("states the channel-specific ADE home", () => {
    installAde("alpha");
    render(
      <ChannelNoticeModal
        channel="alpha"
        platform="win32"
        onClose={() => {}}
        appInfoOverride={appInfo({ packageChannel: "alpha" })}
        osReleaseOverride={null}
      />,
    );
    expect(screen.getByText(/~\/\.ade-alpha/)).toBeTruthy();
  });

  it("opens the prefilled issue URL through the external-link bridge", async () => {
    const { openExternal } = installAde("beta");
    render(
      <ChannelNoticeModal
        channel="beta"
        platform="win32"
        onClose={() => {}}
        appInfoOverride={appInfo()}
        osReleaseOverride="Windows 11 (platformVersion 15.0.0)"
      />,
    );
    fireEvent.click(screen.getByText("Report a bug"));
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    const url = openExternal.mock.calls[0]?.[0] ?? "";
    expect(url.startsWith("https://github.com/arul28/ADE/issues/new?")).toBe(true);
    const body = new URL(url).searchParams.get("body") ?? "";
    expect(body).toContain("ADE version: 1.2.51");
    expect(body).toContain("Package channel: beta");
  });

  it("opens the Windows gaps doc through the external-link bridge", async () => {
    const { openExternal } = installAde("beta");
    render(
      <ChannelNoticeModal
        channel="beta"
        platform="win32"
        onClose={() => {}}
        appInfoOverride={appInfo()}
        osReleaseOverride={null}
      />,
    );
    fireEvent.click(screen.getByText("docs/development/windows-support.md"));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/arul28/ADE/blob/main/docs/development/windows-support.md",
      ),
    );
  });
});
