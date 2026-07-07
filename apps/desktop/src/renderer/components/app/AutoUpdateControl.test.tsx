/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoUpdateControl } from "./AutoUpdateControl";
import type { AppInfo, AutoUpdateSnapshot } from "../../../shared/types";

const idleSnapshot: AutoUpdateSnapshot = {
  status: "idle",
  version: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  releaseNotesUrl: null,
  error: null,
  recentlyInstalled: null,
};

function appInfoWithRuntimeSkew(
  state: NonNullable<AppInfo["localRuntime"]>["versionSkew"]["state"],
): AppInfo {
  return {
    appVersion: "1.2.0",
    isPackaged: true,
    platform: "darwin",
    arch: "arm64",
    versions: {
      electron: "38.0.0",
      chrome: "140.0.0",
      node: "22.0.0",
      v8: "14.0.0",
    },
    env: {},
    localRuntime: {
      connectionState: "connected",
      runtimeMode: state === "runtime_newer" ? "isolated" : "primary",
      versionSkew: {
        state,
        appVersion: "1.2.0",
        runtimeVersion: state === "runtime_newer" ? "1.3.0" : null,
        message: state === "runtime_newer"
          ? "ADE service version 1.3.0 does not match desktop version 1.2.0."
          : null,
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
      serviceInstall: {
        state: "installed",
        attempted: true,
        path: "/Users/admin/.ade/bin/ade",
        message: null,
        exitCode: 0,
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
      serviceHealth: {
        state: "running",
        installed: true,
        running: true,
        path: "/Users/admin/.ade/bin/ade",
        message: null,
        checkedAt: "2026-07-07T00:00:00.000Z",
      },
    },
  };
}

function installAdeMock(args: {
  appInfo?: AppInfo;
  snapshot?: AutoUpdateSnapshot;
  updateCheckForUpdates?: () => Promise<void>;
} = {}) {
  const updateCheckForUpdates = vi.fn(args.updateCheckForUpdates ?? (async () => undefined));
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      app: {
        getInfo: vi.fn(async () => args.appInfo ?? appInfoWithRuntimeSkew("none")),
      },
      updateGetState: vi.fn(async () => args.snapshot ?? idleSnapshot),
      updateCheckForUpdates,
      updateGetInstallImpact: vi.fn(async () => ({ connectedPhones: [] })),
      updateQuitAndInstall: vi.fn(async () => true),
      updateDismissInstalledNotice: vi.fn(async () => undefined),
      onUpdateEvent: vi.fn(() => () => undefined),
    },
  });
  return { updateCheckForUpdates };
}

describe("AutoUpdateControl", () => {
  beforeEach(() => {
    installAdeMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "ade");
  });

  it("shows an update-required chip when the local brain is newer than the desktop", async () => {
    const { updateCheckForUpdates } = installAdeMock({
      appInfo: appInfoWithRuntimeSkew("runtime_newer"),
    });

    render(<AutoUpdateControl />);

    const chip = await screen.findByText("Update required");
    expect(chip).toBeTruthy();

    fireEvent.click(chip.closest("button")!);

    await waitFor(() => {
      expect(updateCheckForUpdates).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the normal install chip ahead of the runtime-skew chip", async () => {
    installAdeMock({
      appInfo: appInfoWithRuntimeSkew("runtime_newer"),
      snapshot: {
        ...idleSnapshot,
        status: "ready",
        version: "1.3.0",
      },
    });

    render(<AutoUpdateControl />);

    expect(await screen.findByText("Install update v1.3.0")).toBeTruthy();
    expect(screen.queryByText("Update required")).toBeNull();
  });
});
