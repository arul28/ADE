import { describe, expect, it, vi } from "vitest";
import { runAdeCliAutoInstall } from "./adeCliAutoInstall";
import type { GlobalState } from "../state/globalState";
import type { AdeCliInstallResult, AdeCliStatus } from "../../../shared/types";

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function status(overrides: Partial<AdeCliStatus> = {}): AdeCliStatus {
  return {
    command: "ade",
    platform: "darwin",
    isPackaged: true,
    bundledAvailable: true,
    bundledBinDir: "/Applications/ADE.app/Contents/Resources/ade-cli/bin",
    bundledCommandPath: "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
    installerPath: "/Applications/ADE.app/Contents/Resources/ade-cli/install.sh",
    agentPathReady: true,
    terminalInstalled: false,
    terminalCommandPath: null,
    installAvailable: true,
    installTargetPath: "/Users/someone/.local/bin/ade",
    installTargetDirOnPath: false,
    message: "",
    nextAction: null,
    ...overrides,
  };
}

function harness(args: {
  state?: GlobalState;
  getStatus?: () => Promise<AdeCliStatus>;
  installForUser?: () => Promise<AdeCliInstallResult>;
  env?: NodeJS.ProcessEnv;
}) {
  let state: GlobalState = args.state ?? {};
  const installForUser = vi.fn(
    args.installForUser
      ?? (async () => ({ ok: true, message: "Installed ade.", status: status({ terminalInstalled: true }) })),
  );
  const getStatus = vi.fn(args.getStatus ?? (async () => status()));
  const log = logger();
  return {
    installForUser,
    getStatus,
    log,
    readState: () => state,
    run: () =>
      runAdeCliAutoInstall({
        adeCli: { getStatus, installForUser },
        logger: log,
        readState: () => state,
        writeState: (next) => {
          state = next;
        },
        env: args.env ?? {},
        now: () => new Date("2026-08-19T00:00:00.000Z"),
      }),
  };
}

describe("runAdeCliAutoInstall", () => {
  it("does nothing when ade already resolves on the user's PATH", async () => {
    // Homebrew, install.sh's ~/.ade/bin/ade, or a hand-made symlink: ADE must
    // never clobber or shadow an install it does not own.
    const h = harness({
      getStatus: async () =>
        status({ terminalInstalled: true, terminalCommandPath: "/opt/homebrew/bin/ade" }),
    });

    await expect(h.run()).resolves.toBe("already-available");
    expect(h.installForUser).not.toHaveBeenCalled();
    expect(h.readState().adeCliAutoInstall).toEqual({
      completedAt: "2026-08-19T00:00:00.000Z",
      outcome: "already-available",
      command: "ade",
    });
  });

  it("does not run again once a previous launch settled the machine", async () => {
    // The user deleting the binary or stripping the PATH line is deliberate.
    const h = harness({
      state: {
        adeCliAutoInstall: {
          completedAt: "2026-08-01T00:00:00.000Z",
          outcome: "installed",
          command: "ade",
        },
      },
    });

    await expect(h.run()).resolves.toBe("already-settled");
    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.installForUser).not.toHaveBeenCalled();
  });

  it("installs once and records the marker when ade is missing", async () => {
    const h = harness({});

    await expect(h.run()).resolves.toBe("installed");
    expect(h.installForUser).toHaveBeenCalledTimes(1);
    expect(h.readState().adeCliAutoInstall).toEqual({
      completedAt: "2026-08-19T00:00:00.000Z",
      outcome: "installed",
      command: "ade",
    });

    // Second launch: the marker alone stops it.
    await expect(h.run()).resolves.toBe("already-settled");
    expect(h.installForUser).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated global state when it records the marker", async () => {
    const h = harness({ state: { lastProjectRoot: "/repo" } });

    await h.run();

    expect(h.readState().lastProjectRoot).toBe("/repo");
  });

  it("reports a failed install without marking the machine settled", async () => {
    // No marker: a build that shipped a broken installer must self-heal on the
    // next update rather than leave the user without the command forever.
    const h = harness({
      installForUser: async () => ({
        ok: false,
        message: "The ADE CLI installer is missing from this app build.",
        status: status(),
      }),
    });

    await expect(h.run()).resolves.toBe("failed");
    expect(h.readState().adeCliAutoInstall).toBeUndefined();
    expect(h.log.warn).toHaveBeenCalledWith("ade_cli.auto_install_failed", expect.anything());
  });

  it("never throws when the installer rejects, so startup is unaffected", async () => {
    const h = harness({
      installForUser: async () => {
        throw new Error("spawn EACCES");
      },
    });

    await expect(h.run()).resolves.toBe("failed");
    expect(h.readState().adeCliAutoInstall).toBeUndefined();
    expect(h.log.warn).toHaveBeenCalledWith("ade_cli.auto_install_failed", {
      error: "spawn EACCES",
    });
  });

  it("skips builds that cannot install without marking them settled", async () => {
    const h = harness({ getStatus: async () => status({ installAvailable: false }) });

    await expect(h.run()).resolves.toBe("unavailable");
    expect(h.installForUser).not.toHaveBeenCalled();
    expect(h.readState().adeCliAutoInstall).toBeUndefined();
  });

  it("honours ADE_DISABLE_CLI_AUTO_INSTALL", async () => {
    const h = harness({ env: { ADE_DISABLE_CLI_AUTO_INSTALL: "1" } });

    await expect(h.run()).resolves.toBe("disabled");
    expect(h.getStatus).not.toHaveBeenCalled();
  });
});
