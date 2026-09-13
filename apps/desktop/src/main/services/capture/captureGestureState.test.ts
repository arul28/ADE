import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureAttachmentFilename,
  captureFailureFor,
  captureGestureHealth,
  captureHelperExecutableName,
  evaluateCaptureChord,
  parseCaptureHelperOutput,
  resolveCaptureHelperExecutablePath,
} from "./captureGestureState";

describe("capture helper path resolution", () => {
  it("resolves packaged and development paths per platform", () => {
    expect(resolveCaptureHelperExecutablePath({
      isPackaged: true,
      resourcesPath: "/Applications/ADE.app/Contents/Resources",
      appPath: "/repo/apps/desktop",
      platform: "darwin",
    })).toBe(path.join("/Applications/ADE.app/Contents/Resources", "native", "ade-capture-helper"));

    expect(resolveCaptureHelperExecutablePath({
      isPackaged: false,
      resourcesPath: "/ignored",
      appPath: "/repo/apps/desktop",
      platform: "darwin",
    })).toBe(path.join("/repo/apps/desktop", "resources", "native", "ade-capture-helper"));
  });

  it("uses the .exe name on Windows so spawn can find it", () => {
    expect(captureHelperExecutableName("win32")).toBe("ade-capture-helper.exe");
    expect(captureHelperExecutableName("darwin")).toBe("ade-capture-helper");
    expect(resolveCaptureHelperExecutablePath({
      isPackaged: true,
      resourcesPath: "C:\\Program Files\\ADE\\resources",
      appPath: "C:\\repo",
      platform: "win32",
    })).toContain("ade-capture-helper.exe");
  });
});

describe("chord admission", () => {
  const base = { enabled: true, captureInFlight: false, lastCaptureAtMs: null, nowMs: 1_000, cooldownMs: 1_200 };

  it("captures on a clean chord", () => {
    expect(evaluateCaptureChord(base)).toEqual({ action: "capture" });
  });

  it("refuses while the gesture is off", () => {
    expect(evaluateCaptureChord({ ...base, enabled: false }))
      .toEqual({ action: "ignore", reason: "disabled" });
  });

  it("refuses a second chord while a capture is running", () => {
    expect(evaluateCaptureChord({ ...base, captureInFlight: true }))
      .toEqual({ action: "ignore", reason: "in-flight" });
  });

  it("refuses a re-press inside the cooldown and allows one after it", () => {
    expect(evaluateCaptureChord({ ...base, lastCaptureAtMs: 500, nowMs: 1_000 }))
      .toEqual({ action: "ignore", reason: "cooldown" });
    expect(evaluateCaptureChord({ ...base, lastCaptureAtMs: 500, nowMs: 2_000 }))
      .toEqual({ action: "capture" });
  });

  it("puts the disabled refusal ahead of the cooldown", () => {
    // Order matters for the log line, and "disabled" is the honest reason when
    // the user switched the gesture off mid-press.
    expect(evaluateCaptureChord({ ...base, enabled: false, lastCaptureAtMs: 999 }))
      .toEqual({ action: "ignore", reason: "disabled" });
  });
});

describe("helper output parsing", () => {
  it("parses each known message", () => {
    expect(parseCaptureHelperOutput('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseCaptureHelperOutput('{"type":"chord"}')).toEqual({ type: "chord" });
    expect(parseCaptureHelperOutput('{"type":"no-window"}')).toEqual({ type: "no-window" });
    expect(parseCaptureHelperOutput('{"type":"permission-denied"}'))
      .toEqual({ type: "permission-denied" });
  });

  it("keeps a captured message's optional fields optional", () => {
    expect(parseCaptureHelperOutput('{"type":"captured","path":"/tmp/a.png"}')).toEqual({
      type: "captured",
      path: "/tmp/a.png",
      appName: null,
      windowTitle: null,
      ownerPid: null,
      bounds: null,
    });
  });

  it("carries app, pid and bounds when the helper knows them", () => {
    const parsed = parseCaptureHelperOutput(JSON.stringify({
      type: "captured",
      path: "/tmp/a.png",
      appName: "Safari",
      windowTitle: "ADE",
      ownerPid: 77,
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    }));
    expect(parsed).toEqual({
      type: "captured",
      path: "/tmp/a.png",
      appName: "Safari",
      windowTitle: "ADE",
      ownerPid: 77,
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
  });

  it("drops a captured message with no path rather than delivering a pathless shot", () => {
    expect(parseCaptureHelperOutput('{"type":"captured"}')).toBeNull();
    expect(parseCaptureHelperOutput('{"type":"captured","path":""}')).toBeNull();
  });

  it("rejects malformed bounds instead of trusting them for the flash geometry", () => {
    const parsed = parseCaptureHelperOutput(JSON.stringify({
      type: "captured",
      path: "/tmp/a.png",
      bounds: { x: 0, y: 0, width: 0, height: 100 },
    }));
    expect(parsed).toMatchObject({ bounds: null });
  });

  it("ignores junk and message types from a newer helper", () => {
    expect(parseCaptureHelperOutput("not json")).toBeNull();
    expect(parseCaptureHelperOutput('{"type":"tomorrow"}')).toBeNull();
    expect(parseCaptureHelperOutput('["chord"]')).toBeNull();
  });

  it("defaults a capture-failed message that carries no text", () => {
    expect(parseCaptureHelperOutput('{"type":"capture-failed"}')).toEqual({
      type: "capture-failed",
      message: "The window could not be captured.",
    });
  });
});

describe("failure presentation", () => {
  it("tells the user exactly where the permission lives, per platform", () => {
    // The platform is passed rather than read off the host: this is pure logic,
    // and a test that says "Screen Recording" only because the developer is on
    // a Mac is a test that goes red on a Windows contributor's machine.
    const mac = captureFailureFor({ type: "permission-denied" }, "chord", "darwin");
    expect(mac.reason).toBe("permission-denied");
    expect(mac.message).toContain("Screen Recording");

    // Windows has no Screen Recording pane, so sending a Windows user there is
    // worse than saying nothing.
    const win = captureFailureFor({ type: "permission-denied" }, "chord", "win32");
    expect(win.message).toContain("keyboard hook");
    expect(win.message).not.toContain("System Settings");

    // A platform the gesture does not support yet gets neither story.
    const other = captureFailureFor({ type: "permission-denied" }, "chord", "linux");
    expect(other.message).not.toContain("Screen Recording");
    expect(other.message).not.toContain("Windows");
  });

  it("keeps the source so the renderer can tell a chord from a palette run", () => {
    expect(captureFailureFor({ type: "no-window" }, "command").source).toBe("command");
  });
});

describe("health", () => {
  const base = {
    platform: "darwin" as const,
    enabled: true,
    executableExists: true,
    running: true,
    permissionDenied: false,
    exhaustedRestarts: false,
  };

  it("answers unsupported before anything else on Linux", () => {
    // Even a Linux machine with the setting on and a file at the helper path
    // must not be told to "turn the gesture on" — there is no helper to run.
    const health = captureGestureHealth({ ...base, platform: "linux", enabled: false });
    expect(health.state).toBe("unsupported");
    expect(health.recovery).toBeNull();
  });

  it("names the platform's own chord in the running and disabled copy", () => {
    expect(captureGestureHealth(base).message).toContain("⌘");
    expect(captureGestureHealth({ ...base, platform: "win32" }).message).toContain("Ctrl");
    expect(captureGestureHealth({ ...base, enabled: false }).state).toBe("disabled");
  });

  it("reports a missing binary as a reinstall, not a retry", () => {
    const health = captureGestureHealth({ ...base, executableExists: false, running: false });
    expect(health.state).toBe("missing");
    expect(health.recovery).toBe("reinstall_or_update");
  });

  it("puts permission refusal ahead of running", () => {
    const health = captureGestureHealth({ ...base, permissionDenied: true });
    expect(health.state).toBe("permission_denied");
    expect(health.recovery).toBe("grant_permission");
  });

  it("reports an exhausted restart budget as a crash loop", () => {
    expect(captureGestureHealth({ ...base, running: false, exhaustedRestarts: true }).state)
      .toBe("crash_loop");
    expect(captureGestureHealth({ ...base, running: false }).state).toBe("starting");
  });
});

describe("attachment filename", () => {
  it("is sortable, padded and .png", () => {
    expect(captureAttachmentFilename(new Date(2026, 8, 13, 9, 5, 3)))
      .toBe("ade-capture-20260913-090503.png");
  });
});
