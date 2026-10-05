/**
 * `ade screen` (also `ade mac-desktop`, `ade windows-desktop`): the plan
 * builder. The text formatters and the error hints are in
 * `cliMacDesktopFormat.ts`.
 *
 * cli.ts keeps the dispatch case and the output switch. The argv primitives
 * still live there, so this module imports them back. That import cycle is
 * safe under the same rule as launchArgs.ts:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 *
 * Every value use of those imports happens inside a function body. Type
 * annotations are erased and are fine at module scope. The flag list is
 * local, so it can be built at module scope.
 */
import {
  MAC_DESKTOP_PROOF_BACKEND_NAME,
  MAC_DESKTOP_RESOLUTION_PRESETS,
} from "../../desktop/src/shared/types/macDesktop";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  collectGenericObjectArgs,
  firstStandalonePositional,
  isRecord,
  listActionsStep,
  proofCallerRootArgs,
  readFlag,
  readNumberOption,
  readProofOwnerBase,
  readToolClaimArgs,
  readValue,
  requireTypedText,
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
import { recordingStopLeftNoFile } from "./cliMacDesktopFormat";

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
  "--seat",
  "--seat-mode",
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
  // One host-neutral help for the `ade screen` family (the plan builder is
  // reached by `screen`, `mac-desktop` and `windows-desktop` alike, and the
  // primary has already been spliced out of `args`).
  if (sub === "help") return { kind: "help", text: HELP_BY_COMMAND["screen"]! };
  if (sub === "actions")
    return {
      kind: "execute",
      label: "screen actions",
      steps: [listActionsStep("actions", "mac_desktop")],
    };

  // Every subcommand is lane-scoped: a display belongs to a lane, not to a
  // chat, so `--lane` (or `ADE_LANE_ID`) is the one argument they all share.
  // With neither, the lane comes from where this shell stands: every call
  // carries `callerRoot`, and the runtime binds a call with no chat identity
  // made from inside a lane worktree to that lane (an OpenCode agent's shell
  // has no ADE_LANE_ID). Anywhere else the runtime refuses and asks for --lane.
  const claimArgs = readToolClaimArgs(args);
  const callerRootArgs = proofCallerRootArgs();
  const laneClaim = (): JsonObject => ({ ...claimArgs });
  const macDesktopStep = (key: string, method: string, payload: JsonObject) =>
    actionStep(key, "mac_desktop", method, payload, callerRootArgs);
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
      // The Windows key. A Mac host refuses it; on Windows `--cmd` is Ctrl.
      ...(readFlag(args, ["--win", "--windows-key", "--super"]) ? ["win"] : []),
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
      macDesktopStep("result", method, collectGenericObjectArgs(args, payload)),
    ],
  });

  if (sub === "status")
    return desktopAction("screen status", "getStatus", { ...claimArgs }, "mac-desktop-status");
  if (sub === "show" || sub === "reveal") {
    // Same verb as `ade ui show mac-desktop`, spelled where an agent driving
    // the display looks for it. `--floating` asks for the floating card instead.
    const floating = readFlag(args, ["--floating", "--float"]);
    return workToolShowPlan(claimArgs, floating ? "floating-mac-desktop" : "mac-desktop");
  }
  if (sub === "start" || sub === "create") {
    const sharedFlag = readFlag(args, ["--shared", "--main-desktop"]);
    const seatMode = readValue(args, ["--seat-mode", "--seat"]) ?? (sharedFlag ? "shared" : null);
    if (seatMode != null && seatMode !== "private" && seatMode !== "shared") {
      throw new CliUsageError("screen start: --seat-mode must be private or shared.");
    }
    if (seatMode === "shared") {
      // `--consent` is a trusted ADE client saying the user already agreed;
      // a session-bound agent is refused that action. Without it this is the
      // agent's ask: a card in its chat, and the user's answer is the consent.
      if (readFlag(args, ["--consent", "--shared-consent"])) {
        return desktopAction("screen start", "useSharedDesktop", laneClaim(), "mac-desktop-status");
      }
      return desktopAction("screen start --shared", "requestSharedDesktop", {
        ...laneClaim(),
        reason: readValue(args, ["--reason", "--for"]),
      }, "mac-desktop-status");
    }
    return desktopAction("screen start", "start", {
      ...laneClaim(),
      resolution: readValue(args, ["--resolution", "--size"]),
      ...(seatMode ? { seatMode } : {}),
      // The Mode B consent is explicit: `--consent` is the user's yes, and the
      // service refuses a shared seat without it.
      ...(readFlag(args, ["--consent", "--shared-consent"]) ? { sharedDesktopConsent: true } : {}),
    }, "mac-desktop-status");
  }
  if (sub === "setup") {
    // Windows only. `--allow-prompt` is the local user's click on the wizard's
    // first step; without it the helper refuses to raise the admin prompt.
    return desktopAction("screen setup", "setupWindows", {
      allowPrompt: readFlag(args, ["--allow-prompt", "--prompt"]),
      savePassword: readFlag(args, ["--save-password"]),
      forgetPassword: readFlag(args, ["--forget-password"]),
    });
  }
  if (sub === "takeover" || sub === "take-over") {
    // Windows only, and never an agent's own move: it signs the holder out.
    return desktopAction("screen takeover", "takeoverWindows", laneClaim(), "mac-desktop-status");
  }
  if (sub === "stop" || sub === "destroy" || sub === "release-display")
    return desktopAction("screen stop", "stop", laneClaim(), "mac-desktop-stop");
  if (sub === "windows" || sub === "list" || sub === "ls")
    return desktopAction("screen windows", "listWindows", { ...claimArgs }, "mac-desktop-windows");
  if (sub === "claim") {
    const explicit = windowId();
    const positional = explicit == null ? Number(positionals(args)[0]) : explicit;
    if (!Number.isFinite(positional)) {
      throw new CliUsageError(
        "screen claim requires --window <id>. Window ids come from `ade screen windows` and die with their process.",
      );
    }
    return desktopAction("screen claim", "claimWindow", {
      ...laneClaim(),
      windowId: positional,
    });
  }
  if (sub === "release")
    return desktopAction("screen release", "releaseWindow", {
      ...laneClaim(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
    });
  if (sub === "focus" || sub === "raise" || sub === "minimize" || sub === "minimise" || sub === "close") {
    // Windows only: one of this lane's own windows. The Mac driver has no
    // such op and the service says so.
    const explicit = windowId();
    const id = explicit == null ? Number(positionals(args)[0]) : explicit;
    if (!Number.isFinite(id)) {
      throw new CliUsageError(
        `screen ${sub} requires --window <id>. Window ids come from \`ade screen windows --text\`.`,
      );
    }
    const method = sub === "close" ? "closeWindow" : sub === "focus" || sub === "raise" ? "focusWindow" : "minimizeWindow";
    return desktopAction(`screen ${sub}`, method, { ...laneClaim(), windowId: id }, "mac-desktop-window-action");
  }
  if (sub === "quit") {
    // Only apps the lane opened, including ones it released to the user.
    // Nothing named quits them all.
    const app = readValue(args, ["--app"]) ?? positionals(args)[0] ?? null;
    return desktopAction("screen quit", "quitApp", {
      ...laneClaim(),
      ...(app ? { app } : {}),
    });
  }
  if (sub === "open" || sub === "launch") {
    const target = requireValue(
      readValue(args, ["--target", "--app"]) ?? positionals(args)[0] ?? null,
      "app, path, or URL",
    );
    // Everything after `--` is the launched app's argv, not ours, except an
    // output flag at the very end: `open TextEdit -- <file> --text` meant the
    // CLI's --text, and TextEdit got it as a second file.
    const appArgs = [...tail];
    while (appArgs.length && (appArgs[appArgs.length - 1] === "--text" || appArgs[appArgs.length - 1] === "--json")) appArgs.pop();
    return desktopAction("screen open", "open", {
      ...laneClaim(),
      target,
      ...(appArgs.length ? { args: appArgs } : {}),
    }, "mac-desktop-open");
  }
  if (sub === "observe" || sub === "snapshot") {
    const observeArgs = {
      ...laneClaim(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
      ...(readFlag(args, ["--map", "--element-map", "--ui-map"]) ? { map: true } : {}),
      limit: readNumberOption(args, ["--limit"]),
    };
    // A windowed observe is a CROP, not the display, and only argv knows that.
    return desktopAction(
      "screen observe",
      "observe",
      observeArgs,
      windowId() == null ? "mac-desktop-observation" : "mac-desktop-window-observation",
    );
  }
  if (sub === "click" || sub === "tap") {
    const x = readNumberOption(args, ["--x"]);
    const y = readNumberOption(args, ["--y"]);
    if ((x == null) !== (y == null)) {
      throw new CliUsageError("screen click requires both --x and --y when clicking a point.");
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
        "screen click needs a target: a handle from the last observation, --text \"<label>\", or --x/--y.",
      );
    }
    return desktopAction("screen click", "click", {
      ...laneClaim(),
      ...target,
      ...(windowId() == null ? {} : { windowId: windowId() }),
      ...realMode(),
      ...(readFlag(args, ["--right", "--secondary"]) ? { button: "right" } : {}),
      ...(readFlag(args, ["--double", "--double-click"]) ? { count: 2 } : {}),
    }, "mac-desktop-action");
  }
  if (sub === "type" || sub === "type-text") {
    const text = requireTypedText(
      readValue(args, ["--value", "--input-text"]) ?? positionals(args)[0] ?? null,
      "text",
    );
    const target = macDesktopTargetFromToken(readValue(args, ["--target", "--handle"]));
    return desktopAction("screen type", "type", {
      ...laneClaim(),
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
    return desktopAction("screen press", "press", {
      ...laneClaim(),
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
    return desktopAction("screen scroll", "scroll", {
      ...laneClaim(),
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
        "screen drag requires --from <handle|x,y> and --to <handle|x,y>.",
      );
    }
    return desktopAction("screen drag", "drag", {
      ...laneClaim(),
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
        "screen wait requires --text \"<t>\", --gone \"<t>\", or --window-title \"<t>\".",
      );
    }
    return desktopAction("screen wait", "wait", {
      ...laneClaim(),
      ...(text ? { text } : {}),
      ...(gone ? { gone } : {}),
      ...(windowTitle ? { windowTitle } : {}),
      timeoutMs: readNumberOption(args, ["--timeout-ms", "--timeout"]),
    }, "mac-desktop-action");
  }
  if (sub === "screenshot" || sub === "capture")
    return desktopAction("screen screenshot", "screenshot", {
      ...laneClaim(),
      ...(windowId() == null ? {} : { windowId: windowId() }),
      out: readValue(args, ["--out", "--out-path", "--output"]),
    }, "mac-desktop-screenshot");
  if (sub === "record" || sub === "recording") {
    const mode = (positionals(args)[0] ?? "start").toLowerCase();
    if (mode === "start") {
      // Same flags and default as `ade apple record-start`. `--keep-idle` is
      // the old name of `--plain`.
      const plain = readFlag(args, ["--plain", "--keep-idle"]);
      const maxSeconds = readNumberOption(args, ["--max-seconds"]);
      if (maxSeconds != null && maxSeconds <= 0) {
        throw new CliUsageError("screen record start --max-seconds must be greater than 0.");
      }
      return desktopAction("screen record start", "startRecording", {
        ...laneClaim(),
        caption: readValue(args, ["--caption", "--description", "--desc"]),
        fps: readNumberOption(args, ["--fps"]),
        ...(plain ? { plain: true } : {}),
        ...(maxSeconds == null ? {} : { maxSeconds }),
      }, "mac-desktop-recording");
    }
    if (mode === "stop")
      return {
        kind: "execute" as const,
        label: "screen record stop",
        formatter: "mac-desktop-recording",
        steps: [macDesktopStep("result", "stopRecording", collectGenericObjectArgs(args, laneClaim()))],
        // The stop refused to file an empty or unfinished video: the result
        // still prints (with its `error` line), and the exit code says so.
        exitCodeFromResult: (result: unknown) => (recordingStopLeftNoFile(result) ? 1 : 0),
      };
    // The lane's recording, as `app-control record status` reports its own.
    if (mode === "status")
      return desktopAction(
        "screen record status",
        "getStatus",
        laneClaim(),
        "mac-desktop-recording",
      );
    throw new CliUsageError(`Unknown mac-desktop record command: ${mode}. Use start, stop or status.`);
  }
  if (sub === "stream" || sub === "live" || sub === "stream-status")
    return desktopAction("screen stream status", "getStreamStatus", laneClaim());
  if (sub === "lease" || sub === "request-lease" || sub === "input-lease") {
    const laneArgs = laneClaim();
    if (!claimArgs.chatSessionId) {
      throw new CliUsageError(
        "screen lease requires --chat-session <id> or ADE_CHAT_SESSION_ID: the approval is remembered per chat.",
      );
    }
    return desktopAction("screen lease", "requestInputLease", {
      ...laneArgs,
      reason: readValue(args, ["--reason", "--for"]),
    }, "mac-desktop-lease");
  }
  if (sub === "display" || sub === "resolution") {
    const resolution = readValue(args, ["--resolution", "--size"]) ?? positionals(args)[0] ?? null;
    // `display` with no resolution is the read; with one it is the set, which
    // is `start` — start is idempotent and serialized per lane, so setting a
    // resolution on a lane that already has a display re-sizes it rather than
    // racing a second one into existence.
    if (!resolution)
      return desktopAction("screen display", "getStatus", { ...laneClaim() }, "mac-desktop-status");
    // Derived from the shared table: a preset added there and forgotten here
    // was a resolution the service supports and the CLI refuses.
    const presets = Object.keys(MAC_DESKTOP_RESOLUTION_PRESETS);
    if (!presets.includes(resolution)) {
      throw new CliUsageError(
        `mac-desktop display: unknown resolution '${resolution}'. Valid values: ${presets.join(", ")}.`,
      );
    }
    return desktopAction("screen display", "start", {
      ...laneClaim(),
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
    return desktopAction("screen present", "present", {
      ...laneClaim(),
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
        "screen proof requires --caption \"<what this shows>\". Use `ade screen screenshot` for a capture you are not filing.",
      );
    }
    const title = readValue(args, ["--title", "--name"]) ?? caption;
    const ownerBase = readProofOwnerBase(args);
    const laneArgs = laneClaim();
    const captureArgs = collectGenericObjectArgs(args, {
      ...laneArgs,
      ...(windowId() == null ? {} : { windowId: windowId() }),
      out: readValue(args, ["--out", "--out-path", "--output"]),
    });
    return {
      kind: "execute",
      label: "screen proof",
      formatter: "mac-desktop-proof",
      steps: [
        macDesktopStep("screenshot", "screenshot", captureArgs),
        // Re-observe AFTER the capture so the state that is returned is the
        // state that was filed. The agent checks that state against its claim
        // before the record stands.
        macDesktopStep("observation", "observe", {
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
                "screen proof could not find the captured screenshot path.",
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
    `Unknown screen subcommand '${sub}'. Run 'ade screen --help'.`,
  );
}
