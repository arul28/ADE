import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
  MAC_DESKTOP_HANDLE_EXPIRED_CODE,
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  MAC_DESKTOP_NO_DISPLAY_CODE,
  MAC_DESKTOP_NO_WINDOW_CODE,
  MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
  MAC_DESKTOP_PERMISSION_REQUIRED_CODE,
  MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
  MAC_DESKTOP_USER_HAS_CONTROL_CODE,
} from "../../desktop/src/shared/types/macDesktop";
import {
  buildCliPlan,
  formatOutput,
  macDesktopErrorHint,
  macDesktopRecordingDurationMs,
  macDesktopSocketPlacementWarning,
  parseCliArgs,
} from "./cli";

/**
 * `ade mac-desktop`: what argv produces, and what the text output says.
 *
 * Plans are read through the real `buildCliPlan`, and text through the real
 * `formatOutput`, because the two defects this guards are exactly the ones a
 * stub hides: an argument the builder silently drops (a bare `--force`-shaped
 * flag that `collectGenericObjectArgs` ignores), and a formatter that renders
 * a shape the service does not return.
 */

type ExecutePlan = Extract<ReturnType<typeof buildCliPlan>, { kind: "execute" }>;

function plan(argv: string[]): ExecutePlan {
  const built = buildCliPlan(argv);
  if (built.kind !== "execute") {
    throw new Error(`expected an execute plan for '${argv.join(" ")}', got '${built.kind}'`);
  }
  return built;
}

/** The `run_ade_action` envelope of a plan's named step. */
function actionArgs(built: ExecutePlan, key = "result"): Record<string, unknown> {
  const step = built.steps.find((entry) => entry.key === key);
  const params = step?.params as { arguments?: { domain?: string; action?: string; args?: Record<string, unknown> } };
  expect(params?.arguments?.domain).toBe("mac_desktop");
  return params?.arguments?.args ?? {};
}

function actionName(built: ExecutePlan, key = "result"): string {
  const step = built.steps.find((entry) => entry.key === key);
  const params = step?.params as { arguments?: { action?: string } };
  return params?.arguments?.action ?? "";
}

// Every lane-scoped subcommand needs a lane; the session environment is where
// a real caller's comes from.
beforeEach(() => {
  process.env.ADE_LANE_ID = "lane-1";
  process.env.ADE_CHAT_SESSION_ID = "chat-1";
});

describe("ade mac-desktop dispatch", () => {
  const previousLane = process.env.ADE_LANE_ID;
  const previousChat = process.env.ADE_CHAT_SESSION_ID;
  beforeEach(() => {
    process.env.ADE_LANE_ID = "lane-1";
    process.env.ADE_CHAT_SESSION_ID = "chat-1";
  });
  afterEach(() => {
    if (previousLane === undefined) delete process.env.ADE_LANE_ID;
    else process.env.ADE_LANE_ID = previousLane;
    if (previousChat === undefined) delete process.env.ADE_CHAT_SESSION_ID;
    else process.env.ADE_CHAT_SESSION_ID = previousChat;
  });

  it("does NOT steal `ade desktop`, which is the desktop-app launcher", () => {
    // `ade desktop` shipped first and opens the installed ADE app. The Mac
    // Desktop family is `ade mac-desktop`; taking the shorter word would have
    // silently changed what a shipped command does.
    expect(buildCliPlan(["desktop"]).kind).toBe("desktop");
    expect(buildCliPlan(["mac-desktop", "status"]).kind).toBe("execute");
    expect(plan(["mac-desk", "status"]).label).toBe("mac-desktop status");
    expect(plan(["desk", "status"]).label).toBe("mac-desktop status");
  });

  it("defaults the lane from the session environment, like ios-sim", () => {
    expect(actionArgs(plan(["mac-desktop", "observe"]))).toMatchObject({ laneId: "lane-1" });
    expect(actionArgs(plan(["mac-desktop", "observe", "--lane", "lane-9"])))
      .toMatchObject({ laneId: "lane-9" });
  });

  it("sends where the shell stands when no lane is named, so the runtime can place it", () => {
    // An OpenCode agent's shell has no ADE_LANE_ID. The runtime binds a call
    // with no chat identity to the lane worktree its callerRoot is inside, and
    // refuses the call anywhere else, so the CLI no longer refuses it first.
    delete process.env.ADE_LANE_ID;
    const previousWorkspace = process.env.ADE_WORKSPACE_ROOT;
    delete process.env.ADE_WORKSPACE_ROOT;
    try {
      const built = plan(["mac-desktop", "observe"]);
      expect(actionArgs(built)).not.toHaveProperty("laneId");
      const envelope = (built.steps[0]?.params as { arguments?: Record<string, unknown> }).arguments;
      expect(envelope).toMatchObject({ callerRoot: process.cwd(), callerRootSource: "cwd" });
      // `status` is the capability read and must answer without a lane.
      expect(plan(["mac-desktop", "status"]).label).toBe("mac-desktop status");
    } finally {
      if (previousWorkspace !== undefined) process.env.ADE_WORKSPACE_ROOT = previousWorkspace;
    }
  });

  it("maps every subcommand to its action", () => {
    const cases: Array<[string[], string, string]> = [
      [["mac-desktop"], "mac-desktop status", "getStatus"],
      [["mac-desktop", "start"], "mac-desktop start", "start"],
      [["mac-desktop", "stop"], "mac-desktop stop", "stop"],
      [["mac-desktop", "windows"], "mac-desktop windows", "listWindows"],
      [["mac-desktop", "claim", "--window", "42"], "mac-desktop claim", "claimWindow"],
      [["mac-desktop", "release"], "mac-desktop release", "releaseWindow"],
      [["mac-desktop", "open", "Preview"], "mac-desktop open", "open"],
      [["mac-desktop", "observe"], "mac-desktop observe", "observe"],
      [["mac-desktop", "click", "obs-a1:e:3"], "mac-desktop click", "click"],
      [["mac-desktop", "type", "hi"], "mac-desktop type", "type"],
      [["mac-desktop", "press", "return"], "mac-desktop press", "press"],
      [["mac-desktop", "scroll", "down"], "mac-desktop scroll", "scroll"],
      [["mac-desktop", "drag", "--from", "obs-a1:e:3", "--to", "1,2"], "mac-desktop drag", "drag"],
      [["mac-desktop", "wait", "--text", "Done"], "mac-desktop wait", "wait"],
      [["mac-desktop", "screenshot"], "mac-desktop screenshot", "screenshot"],
      [["mac-desktop", "record", "start"], "mac-desktop record start", "startRecording"],
      [["mac-desktop", "record", "stop"], "mac-desktop record stop", "stopRecording"],
      [["mac-desktop", "stream"], "mac-desktop stream status", "getStreamStatus"],
      [["mac-desktop", "lease"], "mac-desktop lease", "requestInputLease"],
      [["mac-desktop", "display"], "mac-desktop display", "getStatus"],
      [["mac-desktop", "display", "1080p"], "mac-desktop display", "start"],
      [["mac-desktop", "present", "main"], "mac-desktop present", "present"],
    ];
    for (const [argv, label, action] of cases) {
      const built = plan(argv);
      expect(built.label, argv.join(" ")).toBe(label);
      expect(actionName(built), argv.join(" ")).toBe(action);
    }
  });

  it("resolves a click target from a handle, from --text, and from a point", () => {
    expect(actionArgs(plan(["mac-desktop", "click", "obs-a1:e:3"])))
      .toMatchObject({ handle: "obs-a1:e:3" });
    // `--text "<t>"` is the element, not the output mode: the trailing bare
    // `--text` is what asks for text output.
    // `--text <value>` stays a command argument and the trailing bare `--text`
    // becomes the output mode — that split is `parseCliArgs`'s, so the real
    // parser runs here rather than a hand-built command array.
    const parsed = parseCliArgs(["mac-desktop", "click", "--text", "Sign in", "--text"]);
    expect(parsed.options.text).toBe(true);
    expect(actionArgs(plan(parsed.command))).toMatchObject({ text: "Sign in" });
    expect(actionArgs(plan(["mac-desktop", "click", "--x", "900", "--y", "420"])))
      .toMatchObject({ x: 900, y: 420 });
    expect(() => buildCliPlan(["mac-desktop", "click"])).toThrow(/needs a target/);
    expect(() => buildCliPlan(["mac-desktop", "click", "--x", "900"]))
      .toThrow(/both --x and --y/);
  });

  it("carries the input-mode, button and count flags instead of dropping them", () => {
    // A bare flag `collectGenericObjectArgs` ignores is silently no-op'd, which
    // is how `claim --force` was refused as if the caller had never said it.
    expect(actionArgs(plan(["mac-desktop", "click", "obs-a1:e:3", "--real", "--right", "--double"])))
      .toMatchObject({ mode: "real", button: "right", count: 2 });
    expect(actionArgs(plan(["mac-desktop", "click", "obs-a1:e:3"])).mode).toBeUndefined();
    expect(actionArgs(plan(["mac-desktop", "press", "return", "--cmd", "--shift", "--real"])))
      .toMatchObject({ key: "return", modifiers: ["cmd", "shift"], mode: "real" });
    // The Option key is `--alt`/`--opt`, never `--option`: `ade browser` reads
    // `--option` as a value flag, and one spelling cannot be both.
    expect(actionArgs(plan(["mac-desktop", "press", "a", "--alt", "--control"])))
      .toMatchObject({ modifiers: ["option", "control"] });
    expect(actionArgs(plan(["mac-desktop", "type", "hi", "--clear", "--target", "obs-a1:e:7"])))
      .toMatchObject({ text: "hi", clear: true, target: { handle: "obs-a1:e:7" } });
    // `--submit` presses Return after the words, as `apple type --submit` does,
    // and is not read as the text.
    expect(actionArgs(plan(["mac-desktop", "type", "--submit", "reddit"])))
      .toMatchObject({ text: "reddit", submit: true });
    expect(actionArgs(plan(["mac-desktop", "type", "hi"])).submit).toBeUndefined();
    // Typed text is sent as given: a leading space is part of what to type.
    expect(actionArgs(plan(["mac-desktop", "type", " - done "])).text).toBe(" - done ");
    expect(actionArgs(plan(["mac-desktop", "key", "tab"]))).toMatchObject({ key: "tab" });
    expect(actionArgs(plan(["mac-desktop", "observe", "--map", "--limit", "50"])))
      .toMatchObject({ map: true, limit: 50 });
  });

  it("keeps a named window through the whole branch, and refuses a claim with none", () => {
    // `readNumberOption` splices, so a branch that reads `--window` twice drops
    // it on the second read and screenshots the whole display instead of the
    // window the caller named.
    expect(actionArgs(plan(["mac-desktop", "screenshot", "--window", "91"])))
      .toMatchObject({ windowId: 91 });
    expect(actionArgs(plan(["mac-desktop", "observe", "--window", "91"])))
      .toMatchObject({ windowId: 91 });
    expect(actionArgs(plan(["mac-desktop", "release", "--window", "91"])))
      .toMatchObject({ windowId: 91 });
    expect(actionArgs(plan(["mac-desktop", "claim", "--window", "91"])))
      .toMatchObject({ windowId: 91 });
    expect(() => buildCliPlan(["mac-desktop", "claim"])).toThrow(/requires --window/);
  });

  it("fences an opened app's own argv behind `--`", () => {
    expect(actionArgs(plan(["mac-desktop", "open", "Xcode", "--", "-foo", "bar"])))
      .toMatchObject({ target: "Xcode", args: ["-foo", "bar"] });
  });

  it("validates enumerated arguments at the CLI, before a round trip", () => {
    expect(() => buildCliPlan(["mac-desktop", "scroll", "sideways"]))
      .toThrow(/unknown direction 'sideways'/);
    expect(() => buildCliPlan(["mac-desktop", "display", "720p"]))
      .toThrow(/unknown resolution '720p'/);
    expect(() => buildCliPlan(["mac-desktop", "wait"]))
      .toThrow(/--text .*--gone .*--window-title/s);
    expect(() => buildCliPlan(["mac-desktop", "drag", "--from", "obs-a1:e:3"]))
      .toThrow(/requires --from .* and --to/);
    expect(() => buildCliPlan(["mac-desktop", "nonsense"]))
      .toThrow(/Unknown mac-desktop subcommand 'nonsense'/);
  });

  it("refuses proof without a caption, and otherwise captures, re-observes, then ingests", () => {
    expect(() => buildCliPlan(["mac-desktop", "proof"])).toThrow(/requires --caption/);
    const built = plan(["mac-desktop", "proof", "--caption", "Login works"]);
    expect(built.steps.map((step) => step.key)).toEqual(["screenshot", "observation", "result"]);
    expect(actionName(built, "screenshot")).toBe("screenshot");
    // Re-observe AFTER the capture, so the state returned is the state filed.
    expect(actionName(built, "observation")).toBe("observe");
    const ingest = built.steps.find((step) => step.key === "result");
    const params = (ingest?.params as (values: Record<string, unknown>) => Record<string, unknown>)({
      screenshot: { domain: "mac_desktop", action: "screenshot", result: { filePath: "/tmp/shot.png" } },
    });
    expect(params).toMatchObject({
      name: "ingest_computer_use_artifacts",
      arguments: {
        backendStyle: "manual",
        backendName: "ade-mac-desktop",
        toolName: "mac-desktop proof",
        inputs: [{ kind: "screenshot", title: "Login works", description: "Login works", path: "/tmp/shot.png" }],
      },
    });
  });

  it("requires a chat session for the input lease, because the approval is per chat", () => {
    delete process.env.ADE_CHAT_SESSION_ID;
    expect(() => buildCliPlan(["mac-desktop", "lease"])).toThrow(/requires --chat-session/);
  });
});

describe("macDesktopErrorHint", () => {
  it("turns each service code into the command that unblocks it", () => {
    expect(macDesktopErrorHint(`${MAC_DESKTOP_PERMISSION_REQUIRED_CODE}: no screen recording`))
      .toContain("System Settings");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_USER_HAS_CONTROL_CODE}: taken over`))
      .toBe("The user has control; wait for them to hand it back, then retry.");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE}: real input`))
      .toContain("ade mac-desktop lease");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE}: Xcode is held by lane-7`))
      .toContain("single-instance");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_HANDLE_EXPIRED_CODE}: obs-a1:e:3`))
      .toContain("ade mac-desktop observe");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE}: not a Mac`))
      .toContain("macOS runtime host");
    // Both allowed roots are named: the worktree and the OS temp dir, which the
    // proof skill tells agents to write under.
    expect(macDesktopErrorHint(`${MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE}: /etc/x.png is outside both`))
      .toMatch(/lane worktree.*\$TMPDIR/);
    expect(macDesktopErrorHint("something else entirely")).toBeNull();
  });

  it("tells a lane with a display but no window to open an app, not to start", () => {
    // `press n --cmd` on an empty display used to say "run: ade mac-desktop
    // start" for a display that already existed.
    const hint = macDesktopErrorHint(
      `${MAC_DESKTOP_NO_WINDOW_CODE}: Lane lane-1 has a display but no window to send a key to.`,
    );
    expect(hint).toContain("ade mac-desktop open");
    expect(hint).toContain("ade mac-desktop claim --window");
    expect(hint).not.toContain("mac-desktop start");
    expect(macDesktopErrorHint(`${MAC_DESKTOP_NO_DISPLAY_CODE}: Lane lane-1 has no display.`))
      .toContain("ade mac-desktop start");
  });

  it("does not restate the lane the message already names", () => {
    // The service message carries the holding lane; a hint that repeated it
    // would print the id twice in two different sentences.
    const hint = macDesktopErrorHint(`${MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE}: Xcode is held by lane-7`);
    expect(hint).not.toContain("lane-7");
  });
});

describe("ade mac-desktop text output", () => {
  it("prints the capability, the display, and the windows footer", () => {
    const text = formatOutput(
      {
        platform: "darwin",
        supported: true,
        unsupportedReason: null,
        driver: { state: "running", message: "ready" },
        permissions: { screenRecording: "granted", accessibility: "denied" },
        displayMode: "virtual",
        display: { name: "ADE · lane one", displayId: 7, mode: "virtual", width: 2560, height: 1440 },
        windows: [{ id: 91, appName: "Preview", title: "shot.png" }],
        lease: null,
        stream: { running: true, idle: true, fps: 3, bitrateKbps: 900, lastError: null },
        recording: null,
        lanes: [{ laneId: "lane-1", laneName: "lane one", displayId: 7, windowCount: 1, streaming: true }],
        hostIsLocal: true,
      },
      { text: true } as never,
      "mac-desktop-status",
    );
    expect(text).toContain("ADE Mac Desktop");
    expect(text).toContain("2560x1440");
    expect(text).toContain("accessibility");
    expect(text).toContain("denied");
    expect(text).toContain("running (idle rate) @ 3fps");
    expect(text).toContain("#91 Preview — shot.png");
  });

  it("prints stop's quit apps and left-open sentences in full", () => {
    expect(plan(["mac-desktop", "stop"]).formatter).toBe("mac-desktop-stop");
    const message = "TextEdit did not quit, even when forced. It moved to your screen.";
    const text = formatOutput(
      {
        stopped: true,
        releasedWindows: 2,
        quitApps: ["Safari", "Preview"],
        appsLeftOpen: [{ pid: 88, appName: "TextEdit", message }],
      },
      { text: true } as never,
      "mac-desktop-stop",
    );
    expect(text).toContain("stopped");
    expect(text).toContain("yes");
    expect(text).toContain("released windows");
    expect(text).toContain("Quit  Safari, Preview");
    expect(text).toContain(message);
    expect(text).not.toContain("pid");
  });

  it("prints observations as a numbered handle list with the truncation note", () => {
    const text = formatOutput(
      {
        observation: {
          id: "obs-a1",
          laneId: "lane-1",
          screenshotPath: "/tmp/obs.png",
          mapPath: "/tmp/obs-map.png",
          display: { width: 2560, height: 1440, scale: 2 },
          elementCount: 412,
          truncated: true,
          elements: [
            {
              index: 3,
              handle: "obs-a1:e:3",
              role: "AXButton",
              subrole: null,
              title: "Sign in",
              center: { x: 912.4, y: 430.2 },
              enabled: true,
              focused: false,
            },
            {
              index: 4,
              handle: "obs-a1:e:4",
              role: "AXTextField",
              subrole: "AXSecureTextField",
              label: "Password",
              center: { x: 900, y: 380 },
              enabled: false,
              focused: true,
            },
          ],
          windows: [{ id: 91, appName: "Safari", title: "Sign in" }],
        },
      },
      { text: true } as never,
      "mac-desktop-observation",
    );
    expect(text).toContain('[3] AXButton "Sign in" (912,430)');
    expect(text).toContain('[4] AXTextField/AXSecureTextField "Password" (900,380) [disabled] [focused]');
    expect(text).toContain("/tmp/obs-map.png");
    expect(text).toMatch(/Truncated: 2 of 412 elements shown/);
    expect(text).toContain("#91 Safari — Sign in");
  });

  it("names the app that stopped answering instead of advising --limit", () => {
    const observation = (extra: Record<string, unknown>) => formatOutput(
      {
        observation: {
          id: "obs-b2",
          laneId: "lane-1",
          display: { width: 2560, height: 1440, scale: 2 },
          elementCount: 0,
          truncated: true,
          elements: [],
          windows: [{ id: 91, appName: "TextEdit", title: "Open" }],
          ...extra,
        },
      },
      { text: true } as never,
      "mac-desktop-observation",
    );
    const stalled = observation({ truncatedReason: "stalled", stalledApps: ["TextEdit"] });
    expect(stalled).toContain("Incomplete: TextEdit did not answer accessibility");
    expect(stalled).not.toContain("raise --limit");
    expect(observation({ truncatedReason: "timeout", stalledApps: [] })).toContain("ran out of time after 0 elements");
  });

  it("prints an action result as what it hit, whether it changed anything, and the state that followed", () => {
    const text = formatOutput(
      {
        ok: true,
        action: "click",
        mode: "accessibility",
        effect: { status: "unconfirmed", reason: "nothing on screen changed" },
        resolved: {
          index: 3,
          handle: "obs-a1:e:3",
          role: "AXButton",
          title: "Sign in",
          center: { x: 912, y: 430 },
          enabled: true,
        },
        observation: {
          id: "obs-a2",
          laneId: "lane-1",
          screenshotPath: "/tmp/obs2.png",
          elementCount: 1,
          truncated: false,
          elements: [{ index: 0, handle: "obs-a2:e:0", role: "AXStaticText", title: "Welcome", center: { x: 10, y: 10 } }],
          windows: [],
        },
      },
      { text: true } as never,
      "mac-desktop-action",
    );
    expect(text).toContain("ADE Mac Desktop action");
    expect(text.split("\n").slice(0, 2)).toEqual([
      'hit: AXButton "Sign in" (obs-a1:e:3)',
      "effect: unconfirmed — nothing on screen changed; observe again before you continue",
    ]);
    // The follow-up observation rides along, so no second round trip is needed.
    expect(text).toContain('[0] AXStaticText "Welcome" (10,10)');
    expect(text).toContain("windows  (none parked)");
  });
});

describe("ade mac-desktop misplaced --socket", () => {
  it("warns when --socket follows the subcommand, where nothing parses it", () => {
    // Only the GLOBAL prefix reads --socket, so this placement silently talks
    // to the default brain instead of the one the caller named.
    expect(macDesktopSocketPlacementWarning(["observe", "--socket", "/tmp/a.sock"]))
      .toBe("Note: put --socket before the subcommand");
    expect(macDesktopSocketPlacementWarning(["observe", "--socket=/tmp/a.sock"]))
      .toBe("Note: put --socket before the subcommand");
    expect(macDesktopSocketPlacementWarning(["observe", "--window", "91"])).toBeNull();
  });

  it("warns on stderr and still builds the plan", () => {
    const written: string[] = [];
    const original = process.stderr.write;
    (process.stderr as { write: unknown }).write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never;
    try {
      expect(plan(["mac-desktop", "observe", "--socket", "/tmp/a.sock"]).label)
        .toBe("mac-desktop observe");
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expect(written.join("")).toContain("Note: put --socket before the subcommand");
  });
});

describe("mac-desktop recording duration", () => {
  it("prefers a container-measured duration over the stop-time delta", () => {
    // The driver's delta spans record start → finishWriting returned, which
    // overshoots the clip by the warm-up plus the mux.
    expect(macDesktopRecordingDurationMs({ durationMs: 21_400, containerDurationMs: 12_000 }))
      .toBe(12_000);
    expect(macDesktopRecordingDurationMs({ durationMs: 21_400 })).toBe(21_400);
    expect(macDesktopRecordingDurationMs({ durationMs: null })).toBeNull();
    expect(macDesktopRecordingDurationMs({})).toBeNull();
  });

  it("renders the recording status with the container duration", () => {
    const text = formatOutput(
      {
        laneId: "lane-1",
        running: false,
        startedAt: "2026-09-17T10:00:00.000Z",
        filePath: "/tmp/clip.mp4",
        durationMs: 21_400,
        containerDurationMs: 12_000,
        caption: "Login works",
      },
      { text: true } as never,
      "mac-desktop-recording",
    );
    expect(text).toContain("12.0s");
    expect(text).not.toContain("21.4s");
    expect(text).toContain("/tmp/clip.mp4");
  });

  it("passes --keep-idle and --max-seconds the way `apple record-start` does", () => {
    expect(actionArgs(plan(["mac-desktop", "record", "start", "--caption", "flow"])))
      .not.toHaveProperty("keepIdle");
    const args = actionArgs(plan([
      "mac-desktop", "record", "start", "--keep-idle", "--max-seconds", "1200", "--caption", "flow",
    ]));
    expect(args).toMatchObject({ keepIdle: true, maxSeconds: 1200, caption: "flow", chatSessionId: "chat-1" });
    expect(() => buildCliPlan(["mac-desktop", "record", "start", "--max-seconds", "0"]))
      .toThrow(/--max-seconds must be greater than 0/);
  });

  it("prints the real time, the idle cut, and a stop at the cap", () => {
    const text = formatOutput(
      {
        laneId: "lane-1",
        running: false,
        filePath: "/tmp/clip.mp4",
        durationMs: 70_000,
        wallDurationMs: 182_000,
        idleCutMs: 112_000,
        maxDurationMs: 600_000,
        stopReason: "cap",
        caption: "flow",
      },
      { text: true } as never,
      "mac-desktop-recording",
    );
    expect(text).toMatch(/real time\s+3:02 · idle cut 1:52/);
    expect(text).toMatch(/stopped\s+at its 10:00 cap/);
  });
});

describe("mac-desktop observe labels", () => {
  const observation = {
    observation: {
      id: "obs-a1",
      laneId: "lane-1",
      screenshotPath: "/tmp/obs.png",
      display: { width: 1200, height: 800, scale: 2 },
      elementCount: 0,
      truncated: false,
      elements: [],
      windows: [],
    },
  };

  it("calls a whole-display observation's size `display`", () => {
    const text = formatOutput(observation, { text: true } as never, "mac-desktop-observation");
    expect(text).toMatch(/^display\s+1200x800$/m);
  });

  it("calls a --window observation's size `capture`, because it is a crop", () => {
    const text = formatOutput(
      observation,
      { text: true } as never,
      "mac-desktop-window-observation",
    );
    expect(text).toMatch(/^capture\s+1200x800$/m);
    expect(text).not.toMatch(/^display\s/m);
  });

  it("routes `observe --window` to the crop formatter and plain observe to the display one", () => {
    expect(plan(["mac-desktop", "observe"]).formatter).toBe("mac-desktop-observation");
    expect(plan(["mac-desktop", "observe", "--window", "91"]).formatter)
      .toBe("mac-desktop-window-observation");
    // The window id still reaches the service — the formatter choice must not
    // consume the flag the action needs.
    expect(actionArgs(plan(["mac-desktop", "observe", "--window", "91"])))
      .toMatchObject({ windowId: 91 });
  });
});

describe("mac-desktop off-screen fallback", () => {
  const status = (display: Record<string, unknown>) =>
    formatOutput(
      { platform: "darwin", supported: true, display, windows: [], lanes: [] },
      { text: true } as never,
      "mac-desktop-status",
    );

  it("reports no display id at all in offscreen-region mode", () => {
    const text = status({
      name: "ADE · lane one",
      displayId: 0,
      mode: "offscreen-region",
      width: 2560,
      height: 1440,
    });
    expect(text).toMatch(/^display id\s+—$/m);
    expect(text).toContain("off-screen region of the main display");
  });

  it("reports a null display id as none, not as blank", () => {
    // The service answers `displayId: null` when there is no CoreGraphics
    // display behind the lane, which is every off-screen-region display.
    const text = status({
      name: "ADE · lane one",
      displayId: null,
      mode: "offscreen-region",
      width: 2560,
      height: 1440,
    });
    expect(text).toMatch(/^display id\s+—$/m);
  });

  it("still prints a real CoreGraphics id for a virtual display", () => {
    const text = status({
      name: "ADE · lane one",
      displayId: 7,
      mode: "virtual",
      width: 2560,
      height: 1440,
    });
    expect(text).toMatch(/^display id\s+7$/m);
    expect(text).not.toContain("off-screen region");
  });
});

describe("mac-desktop proof text output", () => {
  it("prints id, caption, path, and owners for every filed entry", () => {
    const built = plan(["mac-desktop", "proof", "--caption", "Login works"]);
    expect(built.formatter).toBe("mac-desktop-proof");
    const text = formatOutput(
      {
        artifacts: [
          {
            id: "art-1",
            kind: "screenshot",
            title: "Login works",
            description: "Login works after the fix",
            uri: "/proof/art-1.png",
          },
          { id: "art-2", kind: "screenshot", title: "Second", uri: "/proof/art-2.png" },
        ],
        links: [
          { id: "l1", artifactId: "art-1", ownerKind: "lane", ownerId: "lane-1" },
          { id: "l2", artifactId: "art-1", ownerKind: "chat_session", ownerId: "chat-1" },
        ],
        confirmation: "Filed 2 artifacts",
      },
      { text: true } as never,
      "mac-desktop-proof",
    );
    expect(text).toMatch(/^id\s+art-1$/m);
    // The caption, not the title: the caption is what the record is judged on.
    expect(text).toMatch(/^caption\s+Login works after the fix$/m);
    expect(text).toMatch(/^path\s+\/proof\/art-1\.png$/m);
    expect(text).toMatch(/^owners\s+lane:lane-1, chat_session:chat-1$/m);
    // An entry nobody linked says so rather than printing an empty column.
    expect(text).toMatch(/^owners\s+\(none\)$/m);
    expect(text).toContain("Filed 2 artifacts");
  });

  it("says so when the ingest returned no rows", () => {
    const text = formatOutput({ artifacts: [], links: [] }, { text: true } as never, "mac-desktop-proof");
    expect(text).toContain("(no artifact rows returned)");
  });
});
