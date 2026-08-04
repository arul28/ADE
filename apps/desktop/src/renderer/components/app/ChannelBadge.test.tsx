/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";

import { ChannelBadge } from "./ChannelBadge";
import { ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT } from "../../lib/windowsBetaNotice";

const originalAde = globalThis.window.ade;

function installAde(packageChannel: string, appVersion = "1.2.51", platform = "win32") {
  const getInfo = vi.fn(async () => ({ appVersion, packageChannel }));
  (globalThis.window as unknown as { ade: unknown }).ade = {
    app: { packageChannel, getInfo, runtimeTarget: { platform, arch: "x64" } },
  };
  return { getInfo };
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

describe("ChannelBadge", () => {
  it("renders nothing on stable, and does not call getInfo", () => {
    const { getInfo } = installAde("stable");
    const { container } = render(<ChannelBadge />);
    expect(container.firstChild).toBeNull();
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("renders the channel and version off stable", async () => {
    installAde("beta");
    render(<ChannelBadge />);
    expect(await screen.findByText("BETA")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("1.2.51")).toBeTruthy());
  });

  it("labels alpha builds too", () => {
    installAde("alpha");
    render(<ChannelBadge version="1.3.0-alpha.2" />);
    expect(screen.getByText("ALPHA")).toBeTruthy();
    expect(screen.getByText("1.3.0-alpha.2")).toBeTruthy();
  });

  it("stays channel-gated: a Windows STABLE install has no chip", () => {
    installAde("stable", "1.2.51", "win32");
    const { container } = render(<ChannelBadge platform="win32" />);
    expect(container.firstChild).toBeNull();
  });

  // jsdom drops the `-webkit-app-region` declaration entirely (it is not in its
  // supported property list), so the rendered DOM cannot be asserted against.
  // The invariant still matters — the shell header is the window drag surface
  // and a clickable child that stays draggable is unclickable — so guard the
  // source instead.
  it("opts the chip out of the window drag region", () => {
    const source = readFileSync(
      "src/renderer/components/app/ChannelBadge.tsx",
      "utf8",
    );
    expect(source).toContain('WebkitAppRegion: "no-drag"');
  });

  it("asks for the Windows beta notice when clicked on Windows", () => {
    installAde("beta", "1.2.51", "win32");
    const listener = vi.fn();
    window.addEventListener(ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT, listener);
    render(<ChannelBadge version="1.2.51" platform="win32" />);
    fireEvent.click(screen.getByRole("button"));
    window.removeEventListener(ADE_OPEN_WINDOWS_BETA_NOTICE_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Off Windows there is no notice to re-open, so the chip must not pretend to
  // be a control that does nothing.
  it("is a static label off Windows", () => {
    installAde("beta", "1.2.51", "darwin");
    render(<ChannelBadge version="1.2.51" platform="darwin" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("BETA")).toBeTruthy();
    expect(screen.getByText("1.2.51")).toBeTruthy();
  });
});
