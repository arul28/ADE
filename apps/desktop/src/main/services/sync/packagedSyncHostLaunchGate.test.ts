import { describe, expect, it, vi } from "vitest";
import {
  blockPackagedLaunchForCrossChannelSyncConflict,
  buildPackagedSyncHostConflictDialogContent,
  resolveCrossChannelSyncHostConflict,
  resolveLaunchingDesktopAppName,
} from "./packagedSyncHostLaunchGate";
import type { SyncHostSingletonConflict } from "../../../../../ade-cli/src/services/sync/syncHostSingleton";

const stableConflict: SyncHostSingletonConflict = {
  reason: "listener",
  owner: {
    id: "stable-3735-8828",
    pid: 3735,
    port: 8828,
    appName: "ADE",
    packageChannel: null,
    adeHome: "/Users/admin/.ade",
    serviceName: "com.ade.runtime",
    socketPath: "/Users/admin/.ade/sock/ade.sock",
    projectRoot: null,
    commandLine: null,
    quitCommand:
      "ADE_HOME='/Users/admin/.ade' '/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade' brain stop --text; /bin/kill 3735 2>/dev/null || true",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  },
};

describe("packagedSyncHostLaunchGate", () => {
  it("resolves launching app names for official channels", () => {
    expect(resolveLaunchingDesktopAppName(null)).toBe("ADE");
    expect(resolveLaunchingDesktopAppName("beta")).toBe("ADE Beta");
    expect(resolveLaunchingDesktopAppName("alpha")).toBe("ADE Alpha");
    expect(resolveLaunchingDesktopAppName("beta", { ADE_DESKTOP_APP_NAME: "Custom ADE" })).toBe("Custom ADE");
  });

  it("builds a clear dialog with the stop command", () => {
    const content = buildPackagedSyncHostConflictDialogContent({
      launchingAppName: "ADE Beta",
      conflict: stableConflict,
    });

    expect(content.title).toBe("Cannot launch ADE Beta");
    expect(content.message).toContain("ADE is already running with phone sync");
    expect(content.detail).toContain("Only one official ADE build can host phone sync");
    expect(content.detail).toContain("Running now: ADE (pid 3735) on sync port 8828");
    expect(content.quitCommand).toContain("brain stop --text");
    expect(content.detail).toContain(content.quitCommand);
  });

  it("does not block dev builds", () => {
    const quit = vi.fn();
    const blocked = blockPackagedLaunchForCrossChannelSyncConflict({
      isPackaged: false,
      channel: "beta",
      detectConflict: () => stableConflict,
      quit,
    });

    expect(blocked).toBe(false);
    expect(quit).not.toHaveBeenCalled();
  });

  it("does not block when the conflict owner is the same channel", () => {
    const quit = vi.fn();
    const blocked = blockPackagedLaunchForCrossChannelSyncConflict({
      isPackaged: true,
      channel: "beta",
      env: {
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
      },
      detectConflict: () => ({
        ...stableConflict,
        owner: {
          ...stableConflict.owner,
          appName: "ADE Beta",
          packageChannel: "beta",
          adeHome: "/Users/admin/.ade-beta",
        },
      }),
      quit,
    });

    expect(blocked).toBe(false);
    expect(quit).not.toHaveBeenCalled();
  });

  it("blocks packaged launches, copies the stop command, and quits", () => {
    const showDialog = vi.fn();
    const copyToClipboard = vi.fn();
    const quit = vi.fn();

    const blocked = blockPackagedLaunchForCrossChannelSyncConflict({
      isPackaged: true,
      channel: "beta",
      env: {
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
      },
      detectConflict: () => stableConflict,
      showDialog,
      copyToClipboard,
      quit,
    });

    expect(blocked).toBe(true);
    expect(copyToClipboard).toHaveBeenCalledWith(stableConflict.owner.quitCommand);
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Cannot launch ADE Beta",
      quitCommand: stableConflict.owner.quitCommand,
    }));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("resolveCrossChannelSyncHostConflict ignores same-channel owners", () => {
    const conflict = resolveCrossChannelSyncHostConflict(stableConflict, {
      ADE_PACKAGE_CHANNEL: "beta",
      ADE_HOME: "/Users/admin/.ade-beta",
    });
    expect(conflict).toEqual(stableConflict);

    const sameChannel = resolveCrossChannelSyncHostConflict({
      ...stableConflict,
      owner: {
        ...stableConflict.owner,
        appName: "ADE Beta",
        packageChannel: "beta",
        adeHome: "/Users/admin/.ade-beta",
      },
    }, {
      ADE_PACKAGE_CHANNEL: "beta",
      ADE_HOME: "/Users/admin/.ade-beta",
    });
    expect(sameChannel).toBeNull();
  });
});
