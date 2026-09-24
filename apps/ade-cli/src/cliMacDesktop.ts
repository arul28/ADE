/**
 * `ade mac-desktop`: the plan builder and the text formatters.
 *
 * cli.ts keeps the dispatch case and the output switch. The argv primitives
 * and the shared render helpers still live there, so this module imports them
 * back. That import cycle is safe under the same rule as launchArgs.ts:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 *
 * Every value use of those imports happens inside a function body. Type
 * annotations are erased and are fine at module scope. The flag list and the
 * error-hint table are local, so they can be built at module scope.
 */
import { formatProofDuration, proofIdleCutLabel } from "../../desktop/src/shared/proofProvenance";
import {
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
  MAC_DESKTOP_PROOF_BACKEND_NAME,
  MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE,
  MAC_DESKTOP_RESOLUTION_PRESETS,
  MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
  MAC_DESKTOP_USER_HAS_CONTROL_CODE,
  MAC_DESKTOP_WINDOW_NOT_FOUND_CODE,
} from "../../desktop/src/shared/types/macDesktop";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  collectGenericObjectArgs,
  firstArray,
  firstRecord,
  firstStandalonePositional,
  isRecord,
  listActionsStep,
  readFlag,
  readNumberOption,
  readProofOwnerBase,
  readToolClaimArgs,
  readValue,
  renderKeyValues,
  renderTable,
  requireValue,
  standalonePositionals,
  takeArgsAfterTerminator,
  unwrapActionEnvelope,
  workToolShowPlan,
  type CliPlan,
  type FormatterId,
  type JsonObject,
  type ToolClaimArgs,
  type ValueCarrierFlags,
} from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   MAC DESKTOP — `ade desktop`.

   One private macOS screen per lane: observe it, act on it by handle, and file
   proof from it. The grammar is `ade browser`'s, not `ade ios-sim`'s, because
   the unit of work is the same one — observe, act by handle, re-observe — and
   because `--text "<t>"` has to mean "the element whose text reads this" here
   the way it does there.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * `ade desktop`'s own value-carrying flags.
 *
 * A local table for the same reason `ade browser` has one: `--text` carries a
 * value here (the element to act on) and must NOT become a CLI-wide carrier,
 * or `ade session show --text s1` silently reads the ambient session instead
 * of "s1". Only flags read with `readValue`/`readNumberOption` belong here;
 * a boolean read with `readFlag` (`--real`, `--map`, `--clear`, `--right`,
 * `--double`, `--cmd`, `--shift`, `--option`, `--control`) must stay out, or
 * the next positional is swallowed as its value.
 */
export const MAC_DESKTOP_VALUE_FLAGS: readonly string[] = [
  "--amount",
  "--arg",
  "--arg-json",
  "--caption",
  "--chat-session",
  "--chat-session-id",
  "--count",
  "--desc",
  "--description",
  "--duration-ms",
  "--for",
  "--fps",
  "--from",
  "--gone",
  "--handle",
  "--input",
  "--input-json",
  "--json-input",
  "--label",
  "--lane",
  "--lane-id",
  "--limit",
  "--max-seconds",
  "--name",
  "--out",
  "--out-path",
  "--output",
  "--owner",
  "--owner-id",
  "--owner-kind",
  "--reason",
  "--resolution",
  "--session",
  "--session-id",
  "--set",
  "--set-json",
  "--target",
  "--text",
  "--timeout",
  "--timeout-ms",
  "--title",
  "--to",
  "--window",
  "--window-id",
  "--window-title",
  "--x",
  "--y",
];

export const MAC_DESKTOP_VALUE_CARRIER_FLAGS: ValueCarrierFlags = new Set(MAC_DESKTOP_VALUE_FLAGS);

/**
 * One row per code, in the order they are checked.
 *
 * A table rather than a ladder of ifs: the codes are a closed set that lives in
 * the shared contract, and a table is the shape that can be read against it.
 */
const MAC_DESKTOP_ERROR_HINTS: ReadonlyArray<readonly [code: string, hint: string]> = [
  [
    MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
    "Mac Desktop needs a macOS runtime host. Run this against a Mac runtime, or use `ade browser` / `ade app-control` here.",
  ],
  [
    MAC_DESKTOP_PERMISSION_REQUIRED_CODE,
    "Grant the missing permission in System Settings → Privacy & Security → Screen Recording and Accessibility, then re-run: ade mac-desktop status --text",
  ],
  [
    MAC_DESKTOP_DRIVER_UNAVAILABLE_CODE,
    "The ADE desktop driver is not running. Check it with: ade mac-desktop status --text",
  ],
  [
    MAC_DESKTOP_DISPLAY_UNAVAILABLE_CODE,
    "No virtual display could be created on this Mac. `ade mac-desktop status --text` reports the mode it fell back to.",
  ],
  [MAC_DESKTOP_NO_DISPLAY_CODE, "This lane has no display yet — run: ade mac-desktop start"],
  [
    // The display exists; there is nothing on it to act on. `start` would not help.
    MAC_DESKTOP_NO_WINDOW_CODE,
    "This lane's display has no window — open an app (ade mac-desktop open <app>) or claim a window (ade mac-desktop claim --window <id>).",
  ],
  [
    // The message already names the holding lane; the hint does not restate it.
    MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE_CODE,
    "That app is single-instance and the lane named above holds it. Wait for that lane, or drive a different app.",
  ],
  [
    MAC_DESKTOP_WINDOW_NOT_FOUND_CODE,
    "Window ids die with their process — re-enumerate with: ade mac-desktop windows --text",
  ],
  [
    MAC_DESKTOP_HANDLE_EXPIRED_CODE,
    "That handle belongs to an older observation — re-observe with: ade mac-desktop observe --text",
  ],
  [
    MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
    "Real pointer and keyboard input needs the user's approval once per chat — run: ade mac-desktop lease",
  ],
  [
    MAC_DESKTOP_USER_HAS_CONTROL_CODE,
    "The user has control; wait for them to hand it back, then retry.",
  ],
  [
    MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
    "Another controller holds the input lease. Wait for it to lapse, or use accessibility input (drop --real).",
  ],
  [
    MAC_DESKTOP_RECORDING_NOT_RUNNING_CODE,
    "No recording is running — start one with: ade mac-desktop record start",
  ],
  [
    MAC_DESKTOP_OUT_PATH_OUTSIDE_ROOT_CODE,
    "--out must land inside the lane worktree named above or the OS temp directory ($TMPDIR) — drop --out to use the default scratch path.",
  ],
];

export function macDesktopErrorHint(message: string): string | null {
  return MAC_DESKTOP_ERROR_HINTS.find(([code]) => message.includes(code))?.[1] ?? null;
}

/** `handle` / `x,y` / bare text, as the service's target trio. */
function macDesktopTargetFromToken(token: string | null): JsonObject {
  if (!token) return {};
  if (isMacDesktopHandleToken(token)) return { handle: token };
  const point = token.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  return { text: token };
}

function isMacDesktopHandleToken(value: string): boolean {
  return /^obs-[A-Za-z0-9_-]+:e:\d+$/.test(value);
}

/**
 * `--socket` is a GLOBAL flag, and only the global prefix parses it.
 *
 * `ade mac-desktop observe --socket /tmp/other.sock` therefore reaches here as
 * an ordinary subcommand argument, is ignored, and the command silently runs
 * against the DEFAULT brain — a wrong answer that looks like a right one. The
 * guard cannot fix the placement (the socket is chosen before the plan is
 * built) but it can refuse to be silent about it.
 */
export function macDesktopSocketPlacementWarning(args: string[]): string | null {
  return args.some((token) => token === "--socket" || token.startsWith("--socket="))
    ? "Note: put --socket before the subcommand"
    : null;
}

export function buildMacDesktopPlan(args: string[]): CliPlan {
  const socketWarning = macDesktopSocketPlacementWarning(args);
  if (socketWarning) process.stderr.write(`${socketWarning}\n`);
  const tail = takeArgsAfterTerminator(args, MAC_DESKTOP_VALUE_CARRIER_FLAGS) ?? [];
  const positionals = (rest: string[]): string[] => [
    ...standalonePositionals(rest, MAC_DESKTOP_VALUE_CARRIER_FLAGS),
    ...tail,
  ];
  const sub =
    firstStandalonePositional(args, MAC_DESKTOP_VALUE_CARRIER_FLAGS) ?? tail.shift() ?? "status";
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND["mac-desktop"]! };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "mac-desktop actions",
      steps: [listActionsStep("actions", "mac_desktop")],
    };

  // Every subcommand is lane-scoped: a display belongs to a lane, not to a
  // chat, so `--lane` (or `ADE_LANE_ID`) is the one argument they all share.
  const claimArgs = readToolClaimArgs(args);
  const requireLane = (): JsonObject => {
    if (!claimArgs.laneId) {
      throw new CliUsageError(
        `mac-desktop ${sub} requires --lane <lane-id> or ADE_LANE_ID.`,
      );
    }
    return { ...claimArgs };
  };
  // Read ONCE and memoized: `readNumberOption` splices the flag out of argv,
  // so the second call in `windowId() == null ? {} : { windowId: windowId() }`
  // would answer null and drop the window the caller named.
  let windowIdRead = false;
  let windowIdValue: number | null = null;
  const windowId = (): number | null => {
    if (!windowIdRead) {
      windowIdValue = readNumberOption(args, ["--window", "--window-id"]) ?? null;
      windowIdRead = true;
    }
    return windowIdValue;
  };
  const realMode = (): JsonObject =>
    readFlag(args, ["--real", "--cg-event", "--pointer"]) ? { mode: "real" } : {};
  const modifiers = (): JsonObject => {
    const pressed = [
      ...(readFlag(args, ["--cmd", "--command-key", "--meta"]) ? ["cmd"] : []),
      ...(readFlag(args, ["--shift"]) ? ["shift"] : []),
      // `--alt`/`--opt`, never `--option`: `ade browser` reads `--option` as a
      // VALUE flag (the <select> option to pick), and a flag that is a value
      // in one family and a boolean in another swallows the next positional.
      ...(readFlag(args, ["--alt", "--opt"]) ? ["option"] : []),
      ...(readFlag(args, ["--control", "--ctrl"]) ? ["control"] : []),
    ];
    return pressed.length ? { modifiers: pressed } : {};
  };
  const desktopAction = (
    label: string,
    method: string,
    payload: JsonObject = {},
    formatter?: FormatterId,
  ): CliPlan => ({
    kind: "execute" as const,
    label,
    ...(formatter ? { formatter } : {}),
    steps: [
      actionStep("result", "mac_desktop", method, collectGenericObjectArgs(args, payload)),
    ],
  });

  if (sub === "status")
    return desktopAction("mac-desktop status", "getStatus", { ...claimArgs }, "mac-desktop-status");
  if (sub === "show" || sub === "reveal") {
    // Same verb as `ade ui show mac-desktop`, spelled where an agent driving
    // the display looks for it. `--floating` asks for the floating card instead.
    const floating = readFlag(args, ["--floating", "--float"]);
    return workToolShowPlan(claimArgs, floating ? "floating-mac-desktop" : "mac-desktop");
  }
  if (sub === "start" || sub === "create")
    return desktopAction("mac-desktop start", "start", {
      ...requireLane(),
      resolution: readValue(args, ["--resolution", "--size"]),
    }, "mac-desktop-status");
  if (sub === "stop" || sub === "destroy" || sub === "release-display")
    return desktopAction("mac-desktop stop", "stop", requireLane(), "mac-desktop-stop");
  if (sub === "windows" || sub === "list" || sub === "ls")
    return desktopAction("mac-desktop windows", "listWindows", { ...claimArgs }, "mac-desktop-windows");
  if (sub === "claim") {
    const explicit = windowId();
    const positional = explicit == null ? Number(positionals(args)[0]) : explicit;
    if (!Number.isFinite(positional)) {
      throw new CliUsageError(
        "mac-desktop claim requires --window <id>. Window ids come from `ade mac-desktop windows` and die with their process.",
      );
    }
    return desktopAction("mac-desktop claim", "claimWindow", {
      ...requireLane(),
      windowId: positional,
    });
  }
  if (sub === "release")
    return desktopAction("mac-desktop release", "releaseWindow", {
      ...requireLane(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
    });
  if (sub === "open" || sub === "launch") {
    const target = requireValue(
      readValue(args, ["--target", "--app"]) ?? positionals(args)[0] ?? null,
      "app, path, or URL",
    );
    // Everything after `--` is the launched app's argv, not ours.
    return desktopAction("mac-desktop open", "open", {
      ...requireLane(),
      target,
      ...(tail.length ? { args: [...tail] } : {}),
    });
  }
  if (sub === "observe" || sub === "snapshot") {
    const observeArgs = {
      ...requireLane(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
      ...(readFlag(args, ["--map", "--element-map", "--ui-map"]) ? { map: true } : {}),
      limit: readNumberOption(args, ["--limit"]),
    };
    // A windowed observe is a CROP, not the display, and only argv knows that.
    return desktopAction(
      "mac-desktop observe",
      "observe",
      observeArgs,
      windowId() == null ? "mac-desktop-observation" : "mac-desktop-window-observation",
    );
  }
  if (sub === "click" || sub === "tap") {
    const x = readNumberOption(args, ["--x"]);
    const y = readNumberOption(args, ["--y"]);
    if ((x == null) !== (y == null)) {
      throw new CliUsageError("mac-desktop click requires both --x and --y when clicking a point.");
    }
    // Read once each: `readValue` SPLICES the flag out of argv, so a second
    // read of the same flag answers null and the value is silently lost.
    const handle = readValue(args, ["--handle"]);
    const text = readValue(args, ["--text", "--label"]);
    const explicit: JsonObject = {
      ...(handle ? { handle } : {}),
      ...(text ? { text } : {}),
      ...(x == null ? {} : { x, y }),
    };
    const target = Object.keys(explicit).length
      ? explicit
      : macDesktopTargetFromToken(positionals(args)[0] ?? null);
    if (Object.keys(target).length === 0) {
      throw new CliUsageError(
        "mac-desktop click needs a target: a handle from the last observation, --text \"<label>\", or --x/--y.",
      );
    }
    return desktopAction("mac-desktop click", "click", {
      ...requireLane(),
      ...target,
      ...(windowId() == null ? {} : { windowId: windowId() }),
      ...realMode(),
      ...(readFlag(args, ["--right", "--secondary"]) ? { button: "right" } : {}),
      ...(readFlag(args, ["--double", "--double-click"]) ? { count: 2 } : {}),
    }, "mac-desktop-action");
  }
  if (sub === "type" || sub === "type-text") {
    const text = requireValue(
      readValue(args, ["--value", "--input-text"]) ?? positionals(args)[0] ?? null,
      "text",
    );
    const target = macDesktopTargetFromToken(readValue(args, ["--target", "--handle"]));
    return desktopAction("mac-desktop type", "type", {
      ...requireLane(),
      text,
      ...(readFlag(args, ["--clear", "--replace"]) ? { clear: true } : {}),
      // Return after the words, as `apple type --submit` does.
      ...(readFlag(args, ["--submit"]) ? { submit: true } : {}),
      ...(Object.keys(target).length ? { target } : {}),
      ...realMode(),
    }, "mac-desktop-action");
  }
  if (sub === "press" || sub === "key") {
    const key = requireValue(
      readValue(args, ["--key"]) ?? positionals(args)[0] ?? null,
      "key",
    );
    return desktopAction("mac-desktop press", "press", {
      ...requireLane(),
      key,
      ...modifiers(),
      ...realMode(),
    }, "mac-desktop-action");
  }
  if (sub === "scroll") {
    const rest = positionals(args);
    const direction = requireValue(
      readValue(args, ["--direction"]) ?? rest[0] ?? null,
      "direction",
    );
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new CliUsageError(
        `mac-desktop scroll: unknown direction '${direction}'. Valid values: up, down, left, right.`,
      );
    }
    return desktopAction("mac-desktop scroll", "scroll", {
      ...requireLane(),
      direction,
      amount: readNumberOption(args, ["--amount", "--lines"]),
      ...macDesktopTargetFromToken(rest[1] ?? null),
      ...(windowId() == null ? {} : { windowId: windowId() }),
      ...realMode(),
    }, "mac-desktop-action");
  }
  if (sub === "drag") {
    const from = macDesktopTargetFromToken(readValue(args, ["--from", "--start"]));
    const to = macDesktopTargetFromToken(readValue(args, ["--to", "--end"]));
    if (!Object.keys(from).length || !Object.keys(to).length) {
      throw new CliUsageError(
        "mac-desktop drag requires --from <handle|x,y> and --to <handle|x,y>.",
      );
    }
    return desktopAction("mac-desktop drag", "drag", {
      ...requireLane(),
      from,
      to,
      durationMs: readNumberOption(args, ["--duration-ms", "--duration"]),
    }, "mac-desktop-action");
  }
  if (sub === "wait" || sub === "wait-for") {
    const text = readValue(args, ["--text", "--label"]);
    const gone = readValue(args, ["--gone", "--hidden"]);
    const windowTitle = readValue(args, ["--window-title"]);
    if (!text && !gone && !windowTitle) {
      throw new CliUsageError(
        "mac-desktop wait requires --text \"<t>\", --gone \"<t>\", or --window-title \"<t>\".",
      );
    }
    return desktopAction("mac-desktop wait", "wait", {
      ...requireLane(),
      ...(text ? { text } : {}),
      ...(gone ? { gone } : {}),
      ...(windowTitle ? { windowTitle } : {}),
      timeoutMs: readNumberOption(args, ["--timeout-ms", "--timeout"]),
    }, "mac-desktop-action");
  }
  if (sub === "screenshot" || sub === "capture")
    return desktopAction("mac-desktop screenshot", "screenshot", {
      ...requireLane(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
      out: readValue(args, ["--out", "--out-path", "--output"]),
    });
  if (sub === "record" || sub === "recording") {
    const mode = (positionals(args)[0] ?? "start").toLowerCase();
    if (mode === "start") {
      // Same flags and default as `ade apple record-start`.
      const keepIdle = readFlag(args, ["--keep-idle"]);
      const maxSeconds = readNumberOption(args, ["--max-seconds"]);
      if (maxSeconds != null && maxSeconds <= 0) {
        throw new CliUsageError("mac-desktop record start --max-seconds must be greater than 0.");
      }
      return desktopAction("mac-desktop record start", "startRecording", {
        ...requireLane(),
        caption: readValue(args, ["--caption", "--description", "--desc"]),
        fps: readNumberOption(args, ["--fps"]),
        ...(keepIdle ? { keepIdle: true } : {}),
        ...(maxSeconds == null ? {} : { maxSeconds }),
      }, "mac-desktop-recording");
    }
    if (mode === "stop")
      return desktopAction(
        "mac-desktop record stop",
        "stopRecording",
        requireLane(),
        "mac-desktop-recording",
      );
    throw new CliUsageError(`Unknown mac-desktop record command: ${mode}. Use start or stop.`);
  }
  if (sub === "stream" || sub === "live" || sub === "stream-status")
    return desktopAction("mac-desktop stream status", "getStreamStatus", requireLane());
  if (sub === "lease" || sub === "request-lease" || sub === "input-lease") {
    const laneArgs = requireLane();
    if (!claimArgs.chatSessionId) {
      throw new CliUsageError(
        "mac-desktop lease requires --chat-session <id> or ADE_CHAT_SESSION_ID: the approval is remembered per chat.",
      );
    }
    return desktopAction("mac-desktop lease", "requestInputLease", {
      ...laneArgs,
      reason: readValue(args, ["--reason", "--for"]),
    });
  }
  if (sub === "display" || sub === "resolution") {
    const resolution = readValue(args, ["--resolution", "--size"]) ?? positionals(args)[0] ?? null;
    // `display` with no resolution is the read; with one it is the set, which
    // is `start` — start is idempotent and serialized per lane, so setting a
    // resolution on a lane that already has a display re-sizes it rather than
    // racing a second one into existence.
    if (!resolution)
      return desktopAction("mac-desktop display", "getStatus", { ...requireLane() }, "mac-desktop-status");
    // Derived from the shared table: a preset added there and forgotten here
    // was a resolution the service supports and the CLI refuses.
    const presets = Object.keys(MAC_DESKTOP_RESOLUTION_PRESETS);
    if (!presets.includes(resolution)) {
      throw new CliUsageError(
        `mac-desktop display: unknown resolution '${resolution}'. Valid values: ${presets.join(", ")}.`,
      );
    }
    return desktopAction("mac-desktop display", "start", {
      ...requireLane(),
      resolution,
    }, "mac-desktop-status");
  }
  if (sub === "present" || sub === "bring") {
    const destination = (positionals(args)[0] ?? "main").toLowerCase();
    if (!["main", "display"].includes(destination)) {
      throw new CliUsageError(
        `mac-desktop present: unknown destination '${destination}'. Use main or display.`,
      );
    }
    return desktopAction("mac-desktop present", "present", {
      ...requireLane(),
      destination,
    });
  }
  if (sub === "proof" || sub === "promote") {
    // Proof is intentional, and a caption is what makes it reviewable. A proof
    // record with no caption is a screenshot nobody can judge, so this refuses
    // rather than inventing one — `ade desktop screenshot` is the way to take
    // a picture without filing it.
    const caption = readValue(args, ["--caption", "--description", "--desc"]);
    if (!caption) {
      throw new CliUsageError(
        "mac-desktop proof requires --caption \"<what this shows>\". Use `ade mac-desktop screenshot` for a capture you are not filing.",
      );
    }
    const title = readValue(args, ["--title", "--name"]) ?? caption;
    const ownerBase = readProofOwnerBase(args);
    const laneArgs = requireLane();
    const captureArgs = collectGenericObjectArgs(args, {
      ...laneArgs,
      ...(windowId() == null ? {} : { windowId: windowId() }),
      out: readValue(args, ["--out", "--out-path", "--output"]),
    });
    return {
      kind: "execute",
      label: "mac-desktop proof",
      formatter: "mac-desktop-proof",
      steps: [
        actionStep("screenshot", "mac_desktop", "screenshot", captureArgs),
        // Re-observe AFTER the capture so the state that is returned is the
        // state that was filed. The agent checks that state against its claim
        // before the record stands.
        actionStep("observation", "mac_desktop", "observe", {
          ...laneArgs,
          ...(windowId() == null ? {} : { windowId: windowId() }),
        }),
        {
          key: "result",
          method: "ade/actions/call",
          unwrapToolResult: true,
          params: (values) => {
            // `ade/actions/call` answers with the `{domain, action, result}`
            // envelope, so the screenshot record has to be unwrapped before
            // its written path is readable.
            const screenshot = unwrapActionEnvelope(values.screenshot);
            const filePath = isRecord(screenshot) ? asString(screenshot.filePath) : null;
            if (!filePath) {
              throw new CliUsageError(
                "mac-desktop proof could not find the captured screenshot path.",
              );
            }
            return {
              name: "ingest_computer_use_artifacts",
              arguments: {
                backendStyle: "manual",
                backendName: MAC_DESKTOP_PROOF_BACKEND_NAME,
                toolName: "mac-desktop proof",
                callerRoot: process.cwd(),
                // The lane and the calling chat are named explicitly rather
                // than inferred from the caller's cwd: a display is lane-scoped
                // and `--lane` may point somewhere the shell is not, so
                // inferring would file the proof against the wrong owner — or
                // against none. `resolveComputerUseOwners` reads both, and the
                // lane owner is what the PR-linked owner then hangs off.
                ...laneArgs,
                ...ownerBase,
                inputs: [
                  {
                    kind: "screenshot",
                    title,
                    description: caption,
                    path: filePath,
                  },
                ],
              },
            };
          },
        },
      ],
    };
  }
  throw new CliUsageError(
    `Unknown mac-desktop subcommand '${sub}'. Run 'ade mac-desktop --help'.`,
  );
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
  const header = renderKeyValues("ADE Mac Desktop observation", [
    ["observation", observation.id],
    ["lane", observation.laneId],
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
  const header = renderKeyValues("ADE Mac Desktop", [
    ["platform", status.platform],
    ["supported", status.supported],
    ["reason", status.unsupportedReason],
    ["driver", driver?.state],
    ["driver message", driver?.message],
    ["screen recording", permissions?.screenRecording],
    ["accessibility", permissions?.accessibility],
    ["mode", display?.mode ?? status.displayMode],
    ["display", display?.name],
    // `offscreen-region` is the fallback where no CoreGraphics display was
    // created at all: there is no id to report, and printing `0` read as a
    // real display id (0 is the MAIN display's id on macOS) — the one thing
    // this mode is emphatically NOT using. An em dash says "none".
    ["display id", macDesktopDisplayIdCell(display, status)],
    [
      "size",
      display?.width && display?.height ? `${display.width}x${display.height}` : null,
    ],
    ["windows", windows.length || display?.windowCount],
    ["lease", lease ? `${lease.holder} ${lease.holderLabel ?? lease.holderId}` : null],
    ["lease expires", lease?.expiresAt],
    ["stream", stream ? `${stream.running ? "running" : "stopped"}${stream.idle ? " (idle rate)" : ""} @ ${stream.fps ?? "?"}fps` : null],
    ["stream error", stream?.lastError],
    ["recording", recording?.running === true ? `running since ${recording.startedAt ?? "?"}` : null],
    ["host is local", status.hostIsLocal],
  ]);
  const sections = [header];
  // A supported host with no display reads as a wall of green rows that never
  // says the one thing the caller has to do next.
  if (status.supported === true && !display) {
    sections.push("", "No display for this lane yet — run: ade mac-desktop start");
  }
  if (macDesktopIsOffscreenRegion(display, status)) {
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
        ["lane", "display", "windows", "streaming"],
        lanes.map((lane) => [
          lane.laneName ?? lane.laneId,
          lane.displayId == null || lane.displayId === 0 ? "—" : lane.displayId,
          lane.windowCount,
          lane.streaming,
        ]),
        "(no lanes hold a display)",
      ),
    );
  }
  return sections.join("\n");
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
    renderKeyValues("ADE Mac Desktop stop", [
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
  );
}

/**
 * The "resolved" cell: the element line, or one of the three no-element sentences.
 *
 * A key press has no target element and no point either — saying it "acted on
 * a point" described a click that never happened. Only a click or a drag can
 * land on a point. A wait result carries waitedMs and no action: a timed-out
 * wait was printed as a key "sent to the focused window".
 */
function macDesktopResolvedLine(result: JsonObject, resolved: JsonObject | null): string {
  if (resolved) return macDesktopElementLine(resolved);
  if (result.action === "click" || result.action === "drag") {
    return "(no element; acted on a point)";
  }
  if (result.action === "wait" || typeof result.waitedMs === "number") {
    return "(no element matched)";
  }
  return "(no element; sent to the focused window)";
}

/**
 * An acting command's answer: what it resolved, then what the screen looks
 * like now.
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
  const header = renderKeyValues("ADE Mac Desktop action", [
    ["ok", result.ok ?? true],
    ["action", result.action],
    ["mode", result.mode],
    [
      "resolved",
      macDesktopResolvedLine(result, resolved),
    ],
    ["waited", typeof result.waitedMs === "number" ? `${result.waitedMs}ms` : null],
  ]);
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

/** `record start` / `record stop`: is it running, where is the file, how long. */
export function formatMacDesktopRecording(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const status = firstRecord(record, ["recording", "status"]) ?? record;
  const durationMs = macDesktopRecordingDurationMs(status);
  const finite = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const wallDurationMs = finite(status.wallDurationMs);
  const idleCut = proofIdleCutLabel(finite(status.idleCutMs));
  const maxDurationMs = finite(status.maxDurationMs);
  return renderKeyValues("ADE Mac Desktop recording", [
    ["lane", status.laneId],
    ["running", status.running],
    ["started", status.startedAt],
    ["file", status.filePath],
    // A stop that failed still flips `running` to false; without this line the
    // failure was invisible and the file looked like a finished recording.
    ["error", status.lastError],
    ["duration", durationMs == null ? null : `${(durationMs / 1000).toFixed(1)}s`],
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
  ]);
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
    ]),
  );
  const confirmation = asString(record.confirmation);
  return [
    artifacts.length
      ? sections.join("\n\n")
      : "proof\n(no artifact rows returned)",
    ...(confirmation ? ["", confirmation] : []),
  ].join("\n");
}
