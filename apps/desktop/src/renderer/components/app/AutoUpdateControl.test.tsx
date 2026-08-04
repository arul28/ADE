/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoUpdateControl } from "./AutoUpdateControl";
import type { AppInfo, AutoUpdateSnapshot } from "../../../shared/types";

const idleSnapshot: AutoUpdateSnapshot = {
  status: "idle",
  currentVersion: "1.2.0",
  latestKnownVersion: "1.2.0",
  version: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  releaseNotesUrl: null,
  error: null,
  errorDetails: null,
  recentlyInstalled: null,
  parked: null,
  lastInstallFailed: null,
  autoApplyPending: null,
  autoApplySuppressedUntil: null,
};

function appInfoWithRuntimeSkew(
  state: NonNullable<AppInfo["localRuntime"]>["versionSkew"]["state"],
): AppInfo {
  return {
    appVersion: "1.2.0",
    packageChannel: "stable",
    isPackaged: true,
    automationsEnabled: true,
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
  const updateQuitAndInstall = vi.fn(async () => true);
  const capture = vi.fn(async () => ({ accepted: true, reason: "accepted" as const }));
  const openExternal = vi.fn(async () => undefined);
  const updateDismissInstalledNotice = vi.fn(async () => undefined);
  let updateListener: ((snapshot: AutoUpdateSnapshot) => void) | null = null;
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      app: {
        getInfo: vi.fn(async () => args.appInfo ?? appInfoWithRuntimeSkew("none")),
        openExternal,
      },
      updateGetState: vi.fn(async () => args.snapshot ?? idleSnapshot),
      updateCheckForUpdates,
      updateGetInstallImpact: vi.fn(async () => ({ connectedPhones: [] })),
      updateQuitAndInstall,
      analytics: { capture },
      updateDismissInstalledNotice,
      onUpdateEvent: vi.fn((listener: (snapshot: AutoUpdateSnapshot) => void) => {
        updateListener = listener;
        return () => {
          updateListener = null;
        };
      }),
    },
  });
  return {
    updateCheckForUpdates,
    updateQuitAndInstall,
    capture,
    openExternal,
    updateDismissInstalledNotice,
    emitUpdate(snapshot: AutoUpdateSnapshot) {
      updateListener?.(snapshot);
    },
  };
}

const installedSnapshot: AutoUpdateSnapshot = {
  ...idleSnapshot,
  recentlyInstalled: {
    version: "1.2.18",
    installedAt: "2026-07-09T00:00:00.000Z",
    releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.18",
    githubReleaseUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.18",
  },
};

const diskSpaceErrorSnapshot: AutoUpdateSnapshot = {
  ...idleSnapshot,
  status: "error",
  version: "1.3.0",
  releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.3.0",
  error: "Not enough space to update ADE.",
  errorDetails: {
    kind: "insufficient_space",
    phase: "install",
    message: "Not enough space to update ADE.",
    availableBytes: 1024 ** 3,
    requiredBytes: 3 * (1024 ** 3),
    volumePath: "/Applications/ADE.app/Contents/MacOS/ADE",
    preservesDownload: true,
  },
};

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
    expect(chip.closest("button")?.getAttribute("title")).toBe(
      "ADE has an update. Update ADE before continuing. Check for ADE updates.",
    );

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

  it("records accepted and deferred manual update decisions", async () => {
    const readySnapshot = { ...idleSnapshot, status: "ready" as const, version: "1.3.0" };
    const mock = installAdeMock({ snapshot: readySnapshot });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<AutoUpdateControl />);
    const install = await screen.findByRole("button", { name: /install update v1\.3\.0/i });
    fireEvent.click(install);
    await waitFor(() => {
      expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ user_action: "deferred" }),
      }));
    });

    fireEvent.click(install);
    await waitFor(() => {
      expect(mock.updateQuitAndInstall).toHaveBeenCalledTimes(1);
    });
    expect(mock.capture).toHaveBeenCalledWith(expect.objectContaining({
      event: "ade_update_prompted",
      properties: {
        from_version: "1.2.0",
        to_version: "1.3.0",
        user_action: "accepted",
      },
    }));
  });

  it("keeps update failures visible and shows capacity recovery details", async () => {
    installAdeMock({ snapshot: diskSpaceErrorSnapshot });

    render(<AutoUpdateControl />);

    const warning = await screen.findByRole("button", { name: "Not enough space to update" });
    expect(warning.getAttribute("aria-haspopup")).toBe("dialog");
    await userEvent.click(warning);

    expect(await screen.findByRole("dialog", { name: "Not enough space to update" })).toBeTruthy();
    expect(screen.getByText("v1.2.0 → v1.3.0")).toBeTruthy();
    expect(screen.getByText("Install")).toBeTruthy();
    expect(screen.getByText("1.0 GB")).toBeTruthy();
    expect(screen.getByText("3.0 GB")).toBeTruthy();
    expect(screen.getByText("/Applications/ADE.app/Contents/MacOS/ADE")).toBeTruthy();
    expect(screen.getByText(/downloaded update was kept/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close update error details" })).toBeTruthy();
  });

  it("retries from the error dialog and clears the persistent warning on progress", async () => {
    const mock = installAdeMock({ snapshot: diskSpaceErrorSnapshot });

    render(<AutoUpdateControl />);
    await userEvent.click(await screen.findByRole("button", { name: "Not enough space to update" }));
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(mock.updateCheckForUpdates).toHaveBeenCalledTimes(1);
    mock.emitUpdate({
      ...idleSnapshot,
      status: "checking",
      version: "1.3.0",
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Not enough space to update" })).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Not enough space to update" })).toBeNull();
    });
    expect(screen.getByText("Checking for updates")).toBeTruthy();
  });

  it("opens and closes update recovery details with the keyboard", async () => {
    installAdeMock({ snapshot: diskSpaceErrorSnapshot });
    const user = userEvent.setup();

    render(<AutoUpdateControl />);
    const warning = await screen.findByRole("button", { name: "Not enough space to update" });
    warning.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Not enough space to update" })).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Not enough space to update" })).toBeNull();
    });
  });

  it("shows the simplified installed modal with Changelog and View on GitHub actions", async () => {
    installAdeMock({ snapshot: installedSnapshot });

    render(<AutoUpdateControl />);

    expect(await screen.findByText("Updated to v1.2.18")).toBeTruthy();
    expect(screen.getByRole("button", { name: /changelog/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /view on github/i })).toBeTruthy();
    // Redundant copy and the old text buttons are gone.
    expect(screen.queryByText(/open release notes/i)).toBeNull();
    expect(screen.queryByText(/the update is installed and ade is ready/i)).toBeNull();
  });

  it("opens the docs changelog and dismisses when Changelog is clicked", async () => {
    const { openExternal, updateDismissInstalledNotice } = installAdeMock({ snapshot: installedSnapshot });

    render(<AutoUpdateControl />);

    fireEvent.click(await screen.findByRole("button", { name: /changelog/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("https://www.ade-app.dev/docs/changelog/v1.2.18");
    });
    expect(updateDismissInstalledNotice).toHaveBeenCalledTimes(1);
  });

  it("opens the GitHub release page and dismisses when View on GitHub is clicked", async () => {
    const { openExternal, updateDismissInstalledNotice } = installAdeMock({ snapshot: installedSnapshot });

    render(<AutoUpdateControl />);

    fireEvent.click(await screen.findByRole("button", { name: /view on github/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("https://github.com/arul28/ADE/releases/tag/v1.2.18");
    });
    expect(updateDismissInstalledNotice).toHaveBeenCalledTimes(1);
  });
});
