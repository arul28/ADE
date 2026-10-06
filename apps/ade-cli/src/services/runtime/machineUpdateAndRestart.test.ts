import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMachineUpdateControls, runMachineUpdateAndRestart } from "./machineUpdateAndRestart";

const runBrainUpdateCommand = vi.fn();
vi.mock("../../commands/brainUpdate", () => ({
  runBrainUpdateCommand: (...args: unknown[]) => runBrainUpdateCommand(...args),
}));

const available = {
  available: true,
  currentVersion: "1.2.50",
  targetVersion: "1.2.55",
  detail: "Update available — 1.2.55.",
};

const upToDate = {
  available: false,
  currentVersion: "1.2.55",
  targetVersion: "1.2.55",
  detail: "Already on the newest version.",
};

describe("runMachineUpdateAndRestart", () => {
  it("updates, then asks the service to restart", async () => {
    const applyUpdate = vi.fn(async () => ({
      ok: true,
      version: "1.2.55",
      detail: "Installed 1.2.55.",
    }));
    const requestRestart = vi.fn(() => ({ ok: true, detail: "Restarting the background service." }));

    const result = await runMachineUpdateAndRestart(
      { checkForUpdate: async () => available, applyUpdate, requestRestart },
      "1.2.55",
    );

    expect(result.ok).toBe(true);
    expect(result.updateApplied).toBe(true);
    expect(applyUpdate).toHaveBeenCalledWith("1.2.55");
    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["check", "ok"],
      ["apply", "ok"],
      ["restart", "pending"],
    ]);
    expect(result.message).toContain("1.2.55");
    expect(result.route).toBe("standalone");
    expect(result.pendingVersion).toBe("1.2.55");
  });

  it("leaves the restart to the updater when the helper owns it", async () => {
    const requestRestart = vi.fn(() => ({ ok: true, detail: "Restarting the background service." }));

    const result = await runMachineUpdateAndRestart(
      {
        checkForUpdate: async () => available,
        applyUpdate: async () => ({
          ok: true,
          version: "1.2.55",
          detail: "Update staged.",
          restartHandledByUpdater: true,
        }),
        requestRestart,
      },
      "1.2.55",
    );

    expect(result.ok).toBe(true);
    expect(result.updateApplied).toBe(true);
    // Two restart authorities mid-binary-swap is the bug this guards.
    expect(requestRestart).not.toHaveBeenCalled();
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["check", "ok"],
      ["apply", "ok"],
      ["restart", "pending"],
    ]);
    expect(result.message).toContain("1.2.55");
  });

  it("restarts a machine that has no update pending", async () => {
    const applyUpdate = vi.fn();
    const requestRestart = vi.fn(() => ({ ok: true, detail: "Restarting the background service." }));

    const result = await runMachineUpdateAndRestart(
      { checkForUpdate: async () => upToDate, applyUpdate, requestRestart },
      "1.2.55",
    );

    expect(result.ok).toBe(true);
    expect(result.updateApplied).toBe(false);
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["check", "ok"],
      ["apply", "skipped"],
      ["restart", "pending"],
    ]);
  });

  it("names the failed step when the update cannot be installed", async () => {
    const requestRestart = vi.fn();
    const result = await runMachineUpdateAndRestart({
      checkForUpdate: async () => available,
      applyUpdate: async () => ({ ok: false, version: null, detail: "checksum mismatch" }),
      requestRestart,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Couldn't install the update — checksum mismatch");
    expect(requestRestart).not.toHaveBeenCalled();
    expect(result.steps.find((step) => step.id === "restart")?.status).toBe("skipped");
  });

  it("says the app updated but the service did not restart", async () => {
    const result = await runMachineUpdateAndRestart({
      checkForUpdate: async () => available,
      applyUpdate: async () => ({ ok: true, version: "1.2.55", detail: "Installed 1.2.55." }),
      requestRestart: () => ({ ok: false, detail: "click Repair." }),
    });

    expect(result.ok).toBe(false);
    expect(result.updateApplied).toBe(true);
    expect(result.message).toBe(
      "Updated ADE, but the background service didn't restart — click Repair.",
    );
  });

  it("stops at the check step when the release cannot be reached", async () => {
    const applyUpdate = vi.fn();
    const result = await runMachineUpdateAndRestart({
      checkForUpdate: async () => {
        throw new Error("release assets are unavailable");
      },
      applyUpdate,
      requestRestart: () => ({ ok: true, detail: "" }),
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      { id: "check", status: "failed", detail: "release assets are unavailable" },
    ]);
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("treats a throwing apply as a failed apply, not a crash", async () => {
    const result = await runMachineUpdateAndRestart({
      checkForUpdate: async () => available,
      applyUpdate: async () => {
        throw new Error("disk full");
      },
      requestRestart: () => ({ ok: true, detail: "" }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("disk full");
  });
});

describe("runMachineUpdateAndRestart with a desktop app open on the machine", () => {
  const appAnswer = (outcome: string, version: string | null = "1.2.55") => ({
    attached: true as const,
    result: { outcome, currentVersion: "1.2.50", version, message: "" } as never,
  });

  function standaloneDeps() {
    return {
      checkForUpdate: vi.fn(async () => available),
      applyUpdate: vi.fn(async () => ({ ok: true, version: "1.2.55", detail: "Installed 1.2.55." })),
      requestRestart: vi.fn(() => ({ ok: true, detail: "Restarting the background service." })),
    };
  }

  it.each([
    // The app installs its own update; the standalone runtime is never touched,
    // because the open app would put its own runtime straight back over it.
    ["installing", true, "1.2.55", false],
    ["downloading", true, "1.2.55", false],
    ["no_update", false, null, false],
    ["failed", false, null, false],
  ])("an app that answers %s decides the result (ok %s, pending %s)", async (outcome, ok, pending, restarted) => {
    const deps = standaloneDeps();
    const result = await runMachineUpdateAndRestart(
      { ...deps, requestDesktopAppUpdate: async () => appAnswer(outcome) },
      "1.2.55",
    );
    expect(result.route).toBe("desktop_app");
    expect(result.ok).toBe(ok);
    expect(result.pendingVersion).toBe(pending);
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.applyUpdate).not.toHaveBeenCalled();
    expect(deps.requestRestart).toHaveBeenCalledTimes(restarted ? 1 : 0);
  });

  it("only restarts the service when the app is already on the target", async () => {
    const deps = standaloneDeps();
    const result = await runMachineUpdateAndRestart(
      { ...deps, requestDesktopAppUpdate: async () => appAnswer("already_current", "1.2.55") },
      "1.2.55",
    );
    expect(result.ok).toBe(true);
    expect(result.route).toBe("desktop_app");
    expect(deps.applyUpdate).not.toHaveBeenCalled();
    expect(deps.requestRestart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no app is attached", async () => ({ attached: false as const, detail: "No ADE desktop app is attached." })],
    ["the app cannot update itself", async () => appAnswer("unsupported", null)],
    ["asking the app throws", async () => { throw new Error("bridge exploded"); }],
  ])("falls back to the standalone runtime when %s", async (_label, requestDesktopAppUpdate) => {
    const deps = standaloneDeps();
    const result = await runMachineUpdateAndRestart(
      { ...deps, requestDesktopAppUpdate },
      "1.2.55",
    );
    expect(result.route).toBe("standalone");
    expect(result.ok).toBe(true);
    expect(deps.applyUpdate).toHaveBeenCalledWith("1.2.55");
    expect(result.pendingVersion).toBe("1.2.55");
  });
});

describe("createMachineUpdateControls", () => {
  const controls = () =>
    createMachineUpdateControls({
      version: "1.2.55",
      logger: { error: () => {} },
      requestRestart: async () => ({ status: 0, stdout: "", stderr: "" }),
    });

  beforeEach(() => {
    runBrainUpdateCommand.mockReset();
  });

  it("refuses to update to the version it already runs, whatever the tag looks like", async () => {
    for (const target of ["1.2.55", "v1.2.55", "V1.2.55"]) {
      const check = await controls().checkForUpdate(target);
      expect(check.available).toBe(false);
      expect(check.detail).toBe("Already on the newest version.");
    }
    expect(runBrainUpdateCommand).not.toHaveBeenCalled();
  });

  it("reports no update when a null target resolves to the version already installed", async () => {
    // The client can ask without naming a version. The check then resolves one,
    // and if that is the version already running, saying "update available"
    // would send the machine into a swap that installs nothing.
    runBrainUpdateCommand.mockResolvedValue({
      ok: true,
      action: "update-check",
      requestedVersion: "v1.2.55",
      currentVersion: "1.2.55",
    });

    const check = await controls().checkForUpdate(null);

    expect(check.available).toBe(false);
    expect(check.detail).toBe("Already on the newest version.");

    const applyUpdate = vi.fn();
    const requestRestart = vi.fn(() => ({ ok: true, detail: "Restarting the background service." }));
    const result = await runMachineUpdateAndRestart(
      { checkForUpdate: async () => check, applyUpdate, requestRestart },
      null,
    );

    expect(applyUpdate).not.toHaveBeenCalled();
    expect(result.updateApplied).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("fails the check step when the update check comes back not ok", async () => {
    runBrainUpdateCommand.mockResolvedValue({ ok: false, message: "Release assets are missing." });

    await expect(controls().checkForUpdate("1.2.56")).rejects.toThrow("Release assets are missing.");
  });

  it("flags the detached staged-apply helper as owning the restart", async () => {
    runBrainUpdateCommand.mockResolvedValue({
      ok: true,
      detached: true,
      message: "ADE brain update staged.",
    });

    const applied = await controls().applyUpdate("1.2.56");

    expect(applied.ok).toBe(true);
    expect(applied.restartHandledByUpdater).toBe(true);
  });

  it("does not credit a detached helper that was told not to restart", async () => {
    // `--no-restart` staged apply: the helper swaps the runtime and stops. If
    // this side also believed the helper owned the restart, nobody would
    // restart the brain at all.
    runBrainUpdateCommand.mockResolvedValue({
      ok: true,
      detached: true,
      restartService: false,
      message: "ADE brain update staged.",
    });

    expect((await controls().applyUpdate("1.2.56")).restartHandledByUpdater).toBe(false);
  });

  it("flags a foreground apply that restarted as owning the restart", async () => {
    runBrainUpdateCommand.mockResolvedValue({ ok: true, applied: true, restarted: true });

    expect((await controls().applyUpdate(null)).restartHandledByUpdater).toBe(true);
  });

  it("leaves the restart to the caller when the updater skipped it", async () => {
    runBrainUpdateCommand.mockResolvedValue({ ok: true, applied: true, restarted: false });

    expect((await controls().applyUpdate(null)).restartHandledByUpdater).toBe(false);
  });
});
