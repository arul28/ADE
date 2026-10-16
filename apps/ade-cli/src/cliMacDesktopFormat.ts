/**
 * `ade screen` text output: the status, observation, action and recording
 * formatters, the host-aware title, and the error-hint table.
 *
 * Split from `cliMacDesktop.ts`, which keeps the plan builder. The same import
 * cycle rule applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 *
 * The hint table is built at module scope from the shared contract only.
 */
import { formatProofDuration, proofIdleCutLabel } from "../../desktop/src/shared/proofProvenance";
import { proofCitationMarkdown } from "../../desktop/src/shared/proofCitation";
import {
  LANE_SCREEN_LINUX_UNSUPPORTED_MESSAGE,
  MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
  MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE,
  MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE,
  MAC_DESKTOP_HANDLE_EXPIRED_CODE,
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
  MAC_DESKTOP_NO_DISPLAY_CODE,
  MAC_DESKTOP_NO_WINDOW_CODE,
  MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
  MAC_DESKTOP_PERMISSION_REQUIRED_CODE,
  MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE,
  MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
  MAC_DESKTOP_USER_HAS_CONTROL_CODE,
  MAC_DESKTOP_WINDOW_NOT_FOUND_CODE,
  WINDOWS_DESKTOP_CANCELLED_CODE,
  WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE,
  WINDOWS_DESKTOP_HELD_CODE,
  WINDOWS_DESKTOP_LOCKED_CODE,
  WINDOWS_DESKTOP_NEXT_STEP,
  WINDOWS_DESKTOP_NOT_CONSOLE_SESSION_CODE,
  WINDOWS_DESKTOP_SETUP_REQUIRED_CODE,
  WINDOWS_DESKTOP_SIGN_IN_FAILED_CODE,
  WINDOWS_DESKTOP_WRONG_PASSWORD_CODE,
  describeDesktopSeat,
  desktopProductName,
  desktopSeatKind,
  type DesktopSeatSummary,
  type MacDesktopDisplay,
  type WindowsDesktopStatus,
} from "../../desktop/src/shared/types/macDesktop";
import {
  asString,
  firstArray,
  firstRecord,
  formatActionAnswerLines,
  isRecord,
  renderKeyValues,
  renderTable,
  type JsonObject,
} from "./cli";

/**
 * The host the CLI is asked about.
 *
 * An agent's shell runs on the runtime host, so the CLI's own platform names
 * the screen correctly; a reply that carries `platform` (status, observation)
 * overrides it for the rare remote caller.
 */
export function hostPlatform(value?: unknown): string {
  if (isRecord(value)) {
    const direct = asString(value.platform);
    if (direct) return direct;
    const observation = firstRecord(value, ["observation"]);
    const nested = observation ? asString(observation.platform) : null;
    if (nested) return nested;
  }
  return process.platform;
}

/** "ADE Windows Desktop" on a Windows host, "ADE Mac Desktop" on a Mac. */
export function screenTitle(value: unknown, suffix = ""): string {
  return `ADE ${desktopProductName(hostPlatform(value))}${suffix ? ` ${suffix}` : ""}`;
}

/**
 * One row per code, in the order they are checked.
 *
 * A table rather than a ladder of ifs: the codes are a closed set that lives in
 * the shared contract, and a table is the shape that can be read against it.
 * Every hint names `ade screen`, the family's neutral spelling, so the same
 * line is right on a Mac and on a Windows PC; a row whose fix differs by host
 * is a function of the host.
 */
const MAC_DESKTOP_ERROR_HINTS: ReadonlyArray<readonly [code: string, hint: string | ((host: string) => string)]> = [
  [
    MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
    (host) => host === "win32"
      ? "This needs a Windows host with the ADE desktop driver installed (or the verb is Mac-only). Check: ade screen status --text"
      : "This needs a macOS runtime host (or the verb is Windows-only). Run it against a Mac runtime, or use `ade browser` / `ade app-control` here.",
  ],
  [
    MAC_DESKTOP_PERMISSION_REQUIRED_CODE,
    "Grant the missing permission in System Settings → Privacy & Security → Screen Recording and Accessibility, then re-run: ade screen status --text",
  ],
  [
    MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE,
    "The ADE desktop driver is not running. Check it with: ade screen status --text",
  ],
  [
    MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE,
    "No lane screen could be created. `ade screen status --text` reports the mode it fell back to.",
  ],
  [MAC_DESKTOP_NO_DISPLAY_CODE, "This lane has no screen yet — run: ade screen start --text"],
  [
    // The display exists; there is nothing on it to act on. `start` would not help.
    MAC_DESKTOP_NO_WINDOW_CODE,
    "This lane's screen has no window — open an app (ade screen open <app>) or claim a window (ade screen claim --window <id>).",
  ],
  [
    // The message already names the holding lane; the hint does not restate it.
    MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
    "That window or app belongs to the lane named above. Act only on your lane's windows (ade screen windows --text).",
  ],
  [
    MAC_DESKTOP_WINDOW_NOT_FOUND_CODE,
    "Window ids die with their process — re-enumerate with: ade screen windows --text",
  ],
  [
    MAC_DESKTOP_HANDLE_EXPIRED_CODE,
    "That handle belongs to an older observation — re-observe with: ade screen observe --text",
  ],
  [
    MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
    (host) => host === "win32"
      ? "Real input on the user's main desktop needs the user's yes once per chat — run: ade screen lease --reason \"<what for>\" (a private Windows screen never needs this)."
      : "Real pointer and keyboard input moves the user's one Mac pointer, so it needs the user's approval once per chat — run: ade screen lease --reason \"<what for>\"",
  ],
  [
    MAC_DESKTOP_USER_HAS_CONTROL_CODE,
    "The user has control; wait for them to hand it back, then retry.",
  ],
  [
    MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
    "Another chat or lane holds real input on this screen. Wait for it to lapse (about a minute after its last action), or use accessibility input (drop --real, act by handle).",
  ],
  [
    MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE,
    "No recording is running — start one with: ade screen record start --caption \"<what>\"",
  ],
  [
    MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
    "--out must land inside the lane worktree named above or the OS temp directory (%TEMP% on Windows, $TMPDIR elsewhere) — drop --out to use the default scratch path.",
  ],
  // The Windows rows read the one next-step table the status `next` line uses;
  // the service's message states only the fact.
  [WINDOWS_DESKTOP_SETUP_REQUIRED_CODE, WINDOWS_DESKTOP_NEXT_STEP.setup_required],
  [WINDOWS_DESKTOP_HELD_CODE, WINDOWS_DESKTOP_NEXT_STEP.held],
  [WINDOWS_DESKTOP_LOCKED_CODE, WINDOWS_DESKTOP_NEXT_STEP.locked],
  [WINDOWS_DESKTOP_NOT_CONSOLE_SESSION_CODE, WINDOWS_DESKTOP_NEXT_STEP.not_console_session],
  [WINDOWS_DESKTOP_CONSENT_REQUIRED_CODE, WINDOWS_DESKTOP_NEXT_STEP.consent],
  [
    WINDOWS_DESKTOP_WRONG_PASSWORD_CODE,
    "The saved Windows password was rejected and forgotten. Ask the user to save their current password in the Windows Desktop pane.",
  ],
  [
    WINDOWS_DESKTOP_SIGN_IN_FAILED_CODE,
    "The private sign-in did not finish. Retry once with: ade screen start --text; if it fails again, ask the user to check the PC.",
  ],
  [
    WINDOWS_DESKTOP_CANCELLED_CODE,
    "The user cancelled the Windows sign-in. Ask before trying again.",
  ],
];

export function macDesktopErrorHint(message: string, host: string = process.platform): string | null {
  const hint = MAC_DESKTOP_ERROR_HINTS.find(([code]) => message.includes(code))?.[1] ?? null;
  return typeof hint === "function" ? hint(host) : hint;
}


/* ── Mac Desktop text output ─────────────────────────────────────────────── */

/** `[3] AXButton "Sign in" (912,430)` — the line an agent acts on. */
function macDesktopElementLine(element: JsonObject): string {
  const center = firstRecord(element, ["center"]);
  const x = typeof center?.x === "number" ? Math.round(center.x) : null;
  const y = typeof center?.y === "number" ? Math.round(center.y) : null;
  const name = asString(element.title) ?? asString(element.label) ?? asString(element.value);
  const role = asString(element.role) ?? "?";
  const subrole = asString(element.subrole);
  const point = x == null || y == null ? "" : ` (${x},${y})`;
  const disabled = element.enabled === false ? " [disabled]" : "";
  const focused = element.focused === true ? " [focused]" : "";
  return `[${element.index ?? "?"}] ${role}${subrole ? `/${subrole}` : ""}`
    + `${name ? ` "${name}"` : ""}${point}${disabled}${focused}`;
}

/** The `windows` footer every observation and action result ends with. */
function macDesktopWindowsFooter(windows: JsonObject[]): string[] {
  if (!windows.length) return ["", "windows  (none parked)"];
  return [
    "",
    `windows  ${windows.length}`,
    ...windows.map((window) => {
      const title = asString(window.title);
      return `  #${window.id ?? "?"} ${asString(window.appName) ?? "?"}`
        + `${title ? ` — ${title}` : ""}`;
    }),
  ];
}

/**
 * `true` when the observation covers one window rather than the whole display.
 *
 * `--window <id>` crops the capture to that window, so the WxH on the header
 * is the window's size and calling it "display" told the caller the screen had
 * changed resolution. The caller's own argv is the authority here — the
 * observation record carries no window id — so the plan picks the formatter.
 */
function macDesktopObservationSections(
  observation: JsonObject,
  options: { windowCapture?: boolean } = {},
): string[] {
  const elements = firstArray(observation, ["elements"]);
  const windows = firstArray(observation, ["windows"]);
  const display = firstRecord(observation, ["display"]);
  const sizeLabel = options.windowCapture === true ? "capture" : "display";
  const header = renderKeyValues(screenTitle(observation, "observation"), [
    ["observation", observation.id],
    ["lane", observation.laneId],
    ["seat", asString(observation.seatMode)],
    ["captured", observation.capturedAt],
    ["image", observation.screenshotPath],
    ["element map", observation.mapPath],
    [
      sizeLabel,
      display?.width && display?.height ? `${display.width}x${display.height}` : null,
    ],
    ["caption", observation.caption],
    ["elements", `${elements.length}/${observation.elementCount ?? elements.length}`],
    // The bracketed number on each line below is an index, not a handle. Say
    // once how the two compose so a --text caller never has to guess the shape
    // `click` accepts.
    ["handles", observation.id ? `obs-${observation.id}:e:<#>` : null],
  ]);
  const sections = [header];
  if (elements.length) {
    sections.push("", ...elements.map((element) => macDesktopElementLine(element)));
  } else {
    sections.push("", "(no accessibility elements)");
  }
  // Truncation is a fact the agent has to act on — it means the element it
  // wants may simply not be in the list — so it is stated, not implied by two
  // numbers in the header. A timeout or a stalled app is a different fact from
  // a cap: part of the display was never read, and --limit cannot bring it back.
  const stalledApps = (Array.isArray(observation.stalledApps) ? observation.stalledApps : [])
    .filter((app): app is string => typeof app === "string" && app.length > 0);
  if (observation.truncatedReason === "stalled" || observation.truncatedReason === "timeout") {
    sections.push(
      "",
      stalledApps.length
        ? `Incomplete: ${stalledApps.join(", ")} did not answer accessibility, so those elements are missing. Take a screenshot to see it, or observe again in a few seconds.`
        : `Incomplete: the element walk ran out of time after ${elements.length} elements. Narrow with --window <id>.`,
    );
  } else if (observation.truncated === true) {
    sections.push(
      "",
      `Truncated: ${elements.length} of ${observation.elementCount ?? "?"} elements shown. Narrow with --window <id>, or raise --limit.`,
    );
  }
  sections.push(...macDesktopWindowsFooter(windows));
  return sections;
}

export function formatMacDesktopObservation(
  value: unknown,
  options: { windowCapture?: boolean } = {},
): string {
  const result = isRecord(value) ? value : {};
  const observation = firstRecord(result, ["observation"]) ?? result;
  return macDesktopObservationSections(observation, options).join("\n");
}

/** The fail-closed fallback: no virtual display was created for this lane. */
function macDesktopIsOffscreenRegion(
  display: JsonObject | null,
  status: JsonObject,
): boolean {
  return (asString(display?.mode) ?? asString(status.displayMode)) === "offscreen-region";
}

/**
 * `7`, or `—` when there is no CoreGraphics display behind the lane.
 *
 * The service answers `displayId: null` in `offscreen-region` mode. The `0`
 * case is still folded in: an older runtime on the other end of the wire is a
 * real shape this CLI meets, and `0` is not a display anybody can open.
 */
function macDesktopDisplayIdCell(
  display: JsonObject | null,
  status: JsonObject,
): string | number | null {
  const raw = display?.displayId;
  if (raw == null) return display ? "—" : null;
  if (typeof raw !== "number") return null;
  if (macDesktopIsOffscreenRegion(display, status) || raw === 0) return "—";
  return raw;
}

export function formatMacDesktopStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const driver = firstRecord(status, ["driver"]);
  const permissions = firstRecord(status, ["permissions"]);
  const display = firstRecord(status, ["display"]);
  const lease = firstRecord(status, ["lease"]);
  const stream = firstRecord(status, ["stream"]);
  const recording = firstRecord(status, ["recording"]);
  const windows = firstArray(status, ["windows"]);
  const lanes = firstArray(status, ["lanes"]);
  const windowsDesktop = firstRecord(status, ["windowsDesktop"]);
  const platform = hostPlatform(status);
  const windowsHost = platform === "win32";
  // The service attaches the summary; an older runtime's reply is summarized
  // here with the same shared function, field by field, so a summary from a
  // runtime that predates a field still gets it.
  const derived = describeDesktopSeat({
    platform,
    supported: status.supported === true,
    display: display as MacDesktopDisplay | null,
    windowsDesktop: windowsDesktop as WindowsDesktopStatus | null,
  });
  const seat: DesktopSeatSummary = { ...derived, ...(firstRecord(status, ["seat"]) as Partial<DesktopSeatSummary> | null) };
  const operation = windowsDesktop ? firstRecord(windowsDesktop, ["operation"]) : null;
  const yesNo = (flag: unknown): string | null => (typeof flag === "boolean" ? (flag ? "yes" : "no") : null);
  // A lane on the private seat is its holder; "held by" itself is noise.
  const holdsPrivate = Boolean(display) && seat.seat === "private";
  const common: Array<[string, unknown]> = [
    ["platform", platform],
    ["supported", status.supported],
    ["reason", status.unsupportedReason],
    ["driver", driver?.state],
    ["driver message", driver?.message],
  ];
  // The seat line is the answer to "whose screen is this?". On Windows the
  // private seat shows the user's wallpaper and taskbar and is still not
  // their screen, so it is stated, not left to be inferred from a picture.
  const seatRows: Array<[string, unknown]> = [
    ["seat", display ? seat.seatDescription ?? seat.seat : "none (no screen for this lane yet)"],
    ["real input", seat.realInputSentence ?? null],
  ];
  const macRows: Array<[string, unknown]> = [
    // Windows has no grants to show.
    ["screen recording", permissions?.screenRecording],
    ["accessibility", permissions?.accessibility],
    ...seatRows,
    ["mode", display?.mode ?? status.displayMode],
    ["display", display?.name],
    // `offscreen-region` is the fallback where no CoreGraphics display was
    // created at all: there is no id to report, and printing `0` read as a
    // real display id (0 is the MAIN display's id on macOS) — the one thing
    // this mode is emphatically NOT using. An em dash says "none".
    ["display id", macDesktopDisplayIdCell(display, status)],
  ];
  const windowsRows: Array<[string, unknown]> = [
    ...seatRows,
    ["session", display?.displayId],
  ];
  const shared: Array<[string, unknown]> = [
    ["size", display?.width && display?.height ? `${display.width}x${display.height}` : null],
    ["windows", windows.length || display?.windowCount],
    ["lease", lease ? `${lease.holder} ${lease.holderLabel ?? lease.holderId}` : null],
    ["lease expires", lease?.expiresAt],
    ["stream", stream ? `${stream.running ? "running" : "stopped"}${stream.idle ? " (idle rate)" : ""} @ ${stream.fps ?? "?"}fps` : null],
    ["stream error", stream?.lastError],
    ["recording", recording?.running === true ? `running since ${recording.startedAt ?? "?"}` : null],
  ];
  // Windows host facts, every one an agent has had to guess at.
  const windowsFacts: Array<[string, unknown]> = [
    ["private seat", typeof seat.privateAvailable === "boolean" && !holdsPrivate
      ? seat.privateAvailable ? "available" : `unavailable — ${seat.privateUnavailable ?? "see the next step"}`
      : null],
    ["held by", holdsPrivate ? null : seat.heldBy ?? null],
    ["setup done", yesNo(seat.setupDone)],
    ["password saved", yesNo(seat.passwordSaved)],
    ["locked", yesNo(seat.locked)],
    ["in progress", operation ? `${asString(operation.kind) ?? "operation"} since ${asString(operation.startedAt) ?? "?"}` : null],
  ];
  const header = renderKeyValues(screenTitle(status), [
    ...common,
    ...(windowsHost ? windowsRows : macRows),
    ...shared,
    ...(windowsHost ? windowsFacts : []),
    ["host is local", status.hostIsLocal],
    ["next", seat.nextStep ?? null],
  ], ["seat", "real input", "next", "private seat", "held by"]);
  // Linux has no lane screen at all. Say that first, in words, before a table
  // of empty rows an agent might read as "not started yet".
  const sections = platform === "linux" && status.supported !== true
    ? [asString(status.unsupportedReason) ?? LANE_SCREEN_LINUX_UNSUPPORTED_MESSAGE, "", header]
    : [header];
  // The Windows shared seat reports `offscreen-region` too; its seat line
  // already says what that means there.
  if (!windowsHost && macDesktopIsOffscreenRegion(display, status)) {
    sections.push(
      "",
      "Windows are parked in an off-screen region of the main display — this Mac has no virtual display.",
    );
  }
  sections.push(...macDesktopWindowsFooter(windows));
  if (lanes.length) {
    sections.push(
      "",
      renderTable(
        windowsHost ? ["lane", "seat", "windows", "streaming"] : ["lane", "display", "windows", "streaming"],
        lanes.map((lane) => [
          lane.laneName ?? lane.laneId,
          windowsHost
            ? desktopSeatKind({ platform, display: { seatMode: asString(lane.seatMode) === "shared" ? "shared" : null } }) === "windows-shared"
              ? "shared"
              : "private"
            : lane.displayId == null || lane.displayId === 0 ? "—" : lane.displayId,
          lane.windowCount,
          lane.streaming,
        ]),
        "(no lanes hold a screen)",
      ),
    );
  }
  return sections.join("\n");
}

/** `screen open`: what launched, the windows that appeared, or why none did. */
export function formatMacDesktopOpen(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const windows = firstArray(result, ["windows"]);
  const header = renderKeyValues(screenTitle(result, "open"), [
    ["lane", result.laneId],
    ["app", result.appName],
    ["pid", result.pid],
    ["resolved", result.resolvedPath],
    ["profile", result.profileDir],
  ]);
  const lines = [header];
  if (windows.length) {
    lines.push(...macDesktopWindowsFooter(windows));
  } else if (result.handedOff === true) {
    lines.push(
      "",
      `No window: ${asString(result.message) ?? "the app handed the request to an instance that was already running, and exited."}`,
      "Next: open it with its full path and a fresh profile or file, or claim the existing window (ade screen windows --text, then ade screen claim --window <id>).",
    );
  } else if (result.watching === true) {
    lines.push(
      "",
      "No window yet; ADE is watching for it. Next: ade screen wait --window-title \"<part of its title>\" --text",
    );
  } else {
    lines.push(
      "",
      "No window appeared and ADE is not watching for one. Check the screen: ade screen observe --text",
    );
  }
  return lines.join("\n");
}

/** `screen screenshot`: where the picture is; not filed as proof. */
export function formatMacDesktopScreenshot(value: unknown): string {
  const result = isRecord(value) ? value : {};
  return renderKeyValues(screenTitle(result, "screenshot"), [
    ["lane", result.laneId],
    ["file", result.filePath],
    ["size", result.width && result.height ? `${result.width}x${result.height}` : null],
    ["captured", result.capturedAt],
    ["filed", result.proofArtifactId ? "yes" : "no — use `ade screen proof --caption \"<what>\"` to file proof"],
  ], ["filed"]);
}

/** `screen lease`: granted, not needed, or refused, and what to do next. */
export function formatMacDesktopLease(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const lease = firstRecord(result, ["lease"]);
  const code = asString(result.code);
  return renderKeyValues(screenTitle(result, "lease"), [
    ["granted", result.notRequired === true ? "not needed" : result.granted],
    ["holder", lease ? `${lease.holder} ${lease.holderLabel ?? lease.holderId}` : null],
    ["expires", lease?.expiresAt],
    ["note", result.message],
    ["refused", code],
    ["next", code ? macDesktopErrorHint(code) : null],
  ], ["note", "next"]);
}

/** `screen focus|minimize|close`: what happened, then the lane's windows. */
export function formatMacDesktopWindowAction(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const action = asString(result.action) ?? "window";
  const lines = [
    renderKeyValues(screenTitle(result, action), [
      ["lane", result.laneId],
      ["window", result.windowId],
      ["closed", action === "close" ? result.closed : null],
      ["note", action === "close" && result.closed === false
        ? "The window is still open (it may be asking to save). Observe it: ade screen observe --window <id> --text"
        : null],
    ], ["note"]),
    ...macDesktopWindowsFooter(firstArray(result, ["windows"])),
  ];
  return lines.join("\n");
}

/**
 * `mac-desktop stop`: which apps quit, and which stayed on the user's screen.
 *
 * The generic result formatter clips each cell at 96 characters and prints an
 * `appsLeftOpen` object as JSON, so the sentence the service wrote — "TextEdit
 * did not quit, even when forced. It moved to your screen." — never arrives
 * whole. Each left-open app is its own line, and the message is that line.
 */
export function formatMacDesktopStop(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const quitApps = (Array.isArray(result.quitApps) ? result.quitApps : [])
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  const leftOpen = (Array.isArray(result.appsLeftOpen) ? result.appsLeftOpen : [])
    .filter(isRecord);
  const sections = [
    renderKeyValues(screenTitle(result, "stop"), [
      ["stopped", result.stopped],
      ["released windows", result.releasedWindows],
    ]),
    "",
    quitApps.length ? `Quit  ${quitApps.join(", ")}` : "Quit  (none)",
  ];
  if (!leftOpen.length) {
    sections.push("Left open  (none)");
  } else {
    sections.push("Left open");
    for (const app of leftOpen) {
      const message = asString(app.message);
      const name = asString(app.appName) ?? "An app";
      sections.push(`  ${message ?? `${name} did not quit. It moved to your screen.`}`);
    }
  }
  return sections.join("\n");
}

export function formatMacDesktopWindows(value: unknown): string {
  const windows = firstArray(value, ["windows", "result"]);
  return renderTable(
    ["id", "app", "title", "lane", "origin", "display"],
    windows.map((window) => [
      window.id,
      window.appName,
      window.title,
      window.laneId,
      window.origin,
      window.onDisplayId,
    ]),
    "(no windows)",
    { fullColumns: ["id", "lane"] },
  );
}

/**
 * The `hit` / `effect` lines, in the one format every computer-use surface
 * prints.
 *
 * A key press has no target element and no point either — saying it "acted on
 * a point" described a click that never happened. Only a click or a drag can
 * land on a point. A wait result carries waitedMs and no action: a timed-out
 * wait was printed as a key "sent to the focused window". A silent action
 * took no observation, so it had nothing to compare.
 */
function macDesktopAnswerLines(result: JsonObject, resolved: JsonObject | null): string[] {
  const isWait = result.action === "wait" || typeof result.waitedMs === "number";
  const pointAction = result.action === "click" || result.action === "drag";
  return formatActionAnswerLines(result, {
    action: isWait ? "wait" : asString(result.action),
    resolved,
    noElement: isWait
      ? "no element matched"
      : pointAction
        ? "no element; acted on a point"
        : "no element; sent to the focused window",
    fallbackEffect: isWait
      ? { status: "not_checked", reason: "a wait checks a condition; it does not act" }
      : { status: "not_checked", reason: "no observation was taken after the action" },
  });
}

/**
 * An acting command's answer: what it hit and whether the screen changed,
 * then what the screen looks like now.
 *
 * The observation is printed in full rather than summarized to one line,
 * because the whole point of the contract is that a caller never has to
 * observe again to learn whether its click landed — a summary would send it
 * back for the element list it was just handed.
 */
export function formatMacDesktopAction(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const resolved = firstRecord(result, ["resolved", "matched"]);
  const observation = firstRecord(result, ["observation"]);
  const header = [
    ...macDesktopAnswerLines(result, resolved),
    "",
    renderKeyValues(screenTitle(result, "action"), [
      ["ok", result.ok ?? true],
      ["action", result.action],
      ["mode", result.mode],
      ["waited", typeof result.waitedMs === "number" ? `${result.waitedMs}ms` : null],
    ]),
  ].join("\n");
  if (!observation) return header;
  return [header, "", ...macDesktopObservationSections(observation)].join("\n");
}

/**
 * How long the clip actually is.
 *
 * The container is the authority: the driver's own stop-time delta includes
 * everything between `record start` and the moment `finishWriting` settled —
 * stream warm-up before the first frame and the mux after the last one — so it
 * reports a clip longer than the file plays. When the service hands back a
 * container-measured duration, that wins.
 */
export function macDesktopRecordingDurationMs(record: JsonObject): number | null {
  for (const key of ["containerDurationMs", "clipDurationMs", "durationMs"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * True when a `record stop` ended with an error and no file: nothing was
 * recorded that can be played or filed. Shared by every `record stop` whose
 * result is a recording status (`screen`, `app-control`).
 */
export function recordingStopLeftNoFile(result: unknown): boolean {
  const outer = isRecord(result) ? result : {};
  // An action envelope (`{ domain, action, result }`) wraps the status.
  const record = typeof outer.domain === "string" && isRecord(outer.result) ? outer.result : outer;
  const status = firstRecord(record, ["recording", "status"]) ?? record;
  const lastError = typeof status.lastError === "string" ? status.lastError.trim() : "";
  const filePath = typeof status.filePath === "string" ? status.filePath.trim() : "";
  return status.running !== true && lastError.length > 0 && filePath.length === 0;
}

/** `record start` / `record stop`: is it running, where is the file, how long. */
export function formatMacDesktopRecording(value: unknown): string {
  const record = isRecord(value) ? value : {};
  // `record status` reads the display's status, whose `recording` is null when
  // the lane has never recorded: that is "not running", not a blank record.
  const status = firstRecord(record, ["recording", "status"])
    ?? ("recording" in record && record.recording == null ? { laneId: record.laneId, running: false } : record);
  const durationMs = macDesktopRecordingDurationMs(status);
  const finite = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const wallDurationMs = finite(status.wallDurationMs);
  const idleCut = proofIdleCutLabel(finite(status.idleCutMs));
  const maxDurationMs = finite(status.maxDurationMs);
  return renderKeyValues(screenTitle(record, "recording"), [
    ["lane", status.laneId],
    ["running", status.running],
    ["started", status.startedAt],
    ["file", status.filePath],
    // A stop that failed still flips `running` to false; without this line the
    // failure was invisible and the file looked like a finished recording.
    ["error", status.lastError],
    // Filed uncut (no demo engine, or the demo failed): never let that read as
    // a finished demo.
    ["demo", status.demoNote],
    // A finished file reported as 0s is a measurement that failed, not an
    // empty video: say so, and give the real time it covered instead.
    ["duration", durationMs == null
      ? null
      : durationMs === 0 && status.running !== true && status.filePath
        ? `not measured${wallDurationMs ? ` (covered ${formatProofDuration(wallDurationMs)} of real time)` : ""} — check the file before citing it`
        : `${(durationMs / 1000).toFixed(1)}s`],
    // The video is shorter than the real time it covers when still time was
    // cut; the same "idle cut m:ss" the proof drawer prints.
    ["real time", idleCut && wallDurationMs != null ? `${formatProofDuration(wallDurationMs)} · ${idleCut}` : null],
    ["stopped", status.stopReason === "cap" && maxDurationMs != null
      ? `at its ${formatProofDuration(maxDurationMs)} cap`
      : null],
    ["caption", status.caption],
    [
      "filed",
      status.running === true || status.lastError
        ? null
        : status.caption
          ? "yes — a captioned recording goes to the proof drawer"
          : "no — add --caption to file it as proof",
    ],
    ["cite", typeof status.proofArtifactId === "string" && status.proofArtifactId
      ? proofCitationMarkdown(status.proofArtifactId, asString(status.caption))
      : null],
  ], ["cite", "duration", "caption"]);
}

/**
 * `mac-desktop proof`: the record that was filed, per entry.
 *
 * Four facts make a proof record reviewable, and the shared `proof-filed`
 * formatter printed only three of them — it showed the artifact's *title* and
 * dropped the owners entirely, so a caller could not tell which lane or chat
 * the capture had landed against, which is the exact thing `mac-desktop proof`
 * takes pains to name explicitly.
 */
export function formatMacDesktopProofFiled(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const artifacts = firstArray(record, ["artifacts"]);
  const links = firstArray(record, ["links"]);
  const ownersFor = (artifactId: unknown): string => {
    const owners = links
      .filter((link) => link.artifactId === artifactId)
      .map((link) => `${asString(link.ownerKind) ?? "?"}:${asString(link.ownerId) ?? "?"}`);
    return owners.length ? [...new Set(owners)].join(", ") : "(none)";
  };
  const sections = artifacts.map((artifact) =>
    renderKeyValues("proof", [
      ["id", artifact.id],
      // The caption is what the record is judged on; the title is usually the
      // same string and never the more specific one.
      ["caption", artifact.description ?? artifact.title],
      ["path", artifact.uri ?? artifact.path],
      ["owners", ownersFor(artifact.id)],
      // Pasted into the answer, this shows the proof next to the claim.
      ["cite", typeof artifact.id === "string" ? proofCitationMarkdown(artifact.id, asString(artifact.description) ?? asString(artifact.title)) : null],
    ], ["cite", "path", "caption"]),
  );
  const confirmation = asString(record.confirmation);
  return [
    artifacts.length
      ? sections.join("\n\n")
      : "proof\n(no artifact rows returned)",
    ...(confirmation ? ["", confirmation] : []),
  ].join("\n");
}
