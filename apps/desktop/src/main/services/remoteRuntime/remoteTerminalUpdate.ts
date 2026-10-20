import { pickLiveCheckout } from "../../../shared/crossMachineHandoff";
import type {
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeUpdateAndRestartResult,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";

/**
 * "Update & restart" for a Windows machine on an ADE build whose app cannot
 * install updates (`isWindowsSelfInstallBlocked`).
 *
 * That machine's own update request goes to its open app, which aborts. So
 * this opens a terminal there, through the same paired connection and role
 * the Work tab's remote shells use, and runs `ade brain update`. That command
 * downloads the newest release's runtime, checks it against the release
 * checksums, and runs it detached; the newer code stops the background
 * service and installs the app (`windowsDesktopRescue` in ade-cli). It works
 * with the app open or closed, which the plain request cannot.
 *
 * The answer comes once the command has staged the update, so a failed
 * download is reported here rather than as a machine that never came back.
 */

const POLL_INTERVAL_MS = 3_000;
/** Progress reads refused in a row, on a live connection, before ADE gives up. */
const MAX_READ_FAILURES = 3;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;

type CallAction = (
  targetId: string,
  projectId: string,
  request: RemoteRuntimeActionRequest,
) => Promise<RemoteRuntimeActionResult>;

/** The lane to open the terminal in: the primary lane, or any lane. */
function pickLaneId(result: unknown): string | null {
  const list = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.lanes) ? result.lanes : [];
  const lanes = list.filter(
    (lane): lane is Record<string, unknown> => isRecord(lane) && typeof lane.id === "string" && Boolean(lane.id.trim()),
  );
  const lane = lanes.find((candidate) => candidate.laneType === "primary") ?? lanes[0];
  return lane ? String(lane.id) : null;
}

/**
 * The command for each Windows shell. `ade` is the app's command, put on the
 * PATH by its installer; the per-user shim is the fallback for a shell that
 * started before PATH had it. The shell exits with the command's code, so the
 * terminal's end says whether staging worked.
 */
export function remoteTerminalUpdateCommands(targetVersion: string | null): {
  powershell: string;
  cmd: string;
  "git-bash": string;
} {
  const versionArgs = targetVersion ? ` --version ${targetVersion.replace(/[^0-9A-Za-z.+-]/g, "")}` : "";
  return {
    powershell:
      "$ade = (Get-Command ade -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; "
      + "if (-not $ade) { $ade = Join-Path $env:LOCALAPPDATA 'ADE\\bin\\ade.cmd' }; "
      + "if (-not (Test-Path -LiteralPath $ade)) { exit 127 }; "
      // A command that never ran leaves $LASTEXITCODE null, which `exit` reads as 0.
      + `& $ade brain update${versionArgs}; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`,
    // Not `& exit /b %ERRORLEVEL%`: cmd expands that when it reads the line,
    // before `ade` runs, so it would report the previous command's code.
    cmd: `ade brain update${versionArgs} && exit 0 || exit 1`,
    "git-bash": `ade brain update${versionArgs}; exit $?`,
  };
}

function failed(
  status: RemoteRuntimeConnectionStatus,
  targetVersion: string | null,
  message: string,
): RemoteRuntimeUpdateAndRestartResult {
  return {
    ok: false,
    updateApplied: false,
    currentVersion: status.version,
    targetVersion,
    steps: [{ id: "apply", status: "failed", detail: message }],
    message,
    route: "terminal",
    pendingVersion: null,
  };
}

function staged(
  status: RemoteRuntimeConnectionStatus,
  targetVersion: string | null,
): RemoteRuntimeUpdateAndRestartResult {
  return {
    ok: true,
    updateApplied: false,
    currentVersion: status.version,
    targetVersion,
    steps: [
      { id: "check", status: "ok", detail: `${status.version ?? "This build"} can't install updates in its app, so ADE ran its updater in a terminal there.` },
      { id: "apply", status: "pending", detail: "Installing the new ADE app." },
      { id: "restart", status: "pending", detail: "The background service restarts on the new build." },
    ],
    message: `Installing ADE ${targetVersion ?? "update"} on ${status.target.name} — ADE there restarts on its own in a few minutes.`,
    route: "terminal",
    pendingVersion: targetVersion,
  };
}

/** How the terminal that runs the update ended, or null while it still runs. */
function terminalOutcome(result: unknown): { exitCode: number | null; output: string | null } | null {
  const session = isRecord(result) && isRecord(result.session) ? result.session : result;
  if (!isRecord(session)) return null;
  if (session.status === "running") return null;
  return {
    exitCode: typeof session.exitCode === "number" ? session.exitCode : null,
    output: typeof session.lastOutputPreview === "string" && session.lastOutputPreview.trim()
      ? session.lastOutputPreview.trim()
      : null,
  };
}

export async function updateViaRemoteTerminal(args: {
  status: RemoteRuntimeConnectionStatus;
  targetVersion: string | null;
  callAction: CallAction;
  /** Whether the paired connection to that machine is still up. */
  isConnected: () => boolean;
  logger: Pick<Logger, "info" | "warn">;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RemoteRuntimeUpdateAndRestartResult> {
  const { status, targetVersion, callAction, logger } = args;
  const targetId = status.target.id;
  const now = args.now ?? Date.now;
  // From the start, so finding a lane and opening the terminal count too and the
  // whole run stays inside the IPC timeout set just above it.
  const deadline = now() + args.timeoutMs;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const manualHint = `On that PC, open a terminal and run: ade brain update${targetVersion ? ` --version ${targetVersion}` : ""}`;

  // A terminal lives in a project's lane. Any project works; the live one is
  // least likely to refuse.
  const project = pickLiveCheckout(status.projects);
  if (!project) {
    return failed(status, targetVersion, `ADE ${status.version ?? ""} on ${status.target.name} can't install updates itself, and it has no project to open a terminal in. ${manualHint}`);
  }
  let laneId: string | null;
  try {
    laneId = pickLaneId((await callAction(targetId, project.projectId, {
      domain: "lane",
      action: "list",
      args: { includeArchived: false, includeStatus: false },
    })).result);
  } catch (error) {
    return failed(status, targetVersion, `Couldn't open a terminal on ${status.target.name}: ${error instanceof Error ? error.message : String(error)}. ${manualHint}`);
  }
  if (!laneId) {
    return failed(status, targetVersion, `${status.target.name} has no lane to open a terminal in. ${manualHint}`);
  }

  const commands = remoteTerminalUpdateCommands(targetVersion);
  let sessionId: string;
  let ptyId: string | null = null;
  try {
    const created = (await callAction(targetId, project.projectId, {
      domain: "pty",
      action: "create",
      args: {
        laneId,
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        title: `Update ADE to ${targetVersion ?? "the newest version"}`,
        tracked: false,
        toolType: "shell",
        startupCommand: commands.powershell,
        windowsStartupCommands: commands,
      },
    })).result;
    if (!isRecord(created) || typeof created.sessionId !== "string") {
      throw new Error("The machine did not return a terminal.");
    }
    sessionId = created.sessionId;
    ptyId = typeof created.ptyId === "string" ? created.ptyId : null;
  } catch (error) {
    return failed(status, targetVersion, `Couldn't open a terminal on ${status.target.name}: ${error instanceof Error ? error.message : String(error)}. ${manualHint}`);
  }
  logger.info("remote_update.terminal_started", { targetId, projectId: project.projectId, sessionId, targetVersion });

  let readFailures = 0;
  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let outcome: ReturnType<typeof terminalOutcome>;
    try {
      outcome = terminalOutcome((await callAction(targetId, project.projectId, {
        domain: "session",
        action: "get",
        arg: sessionId,
      })).result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The update stops the brain that owns this terminal, which drops the
      // connection: that is the install starting, not a failure.
      if (!args.isConnected()) {
        logger.info("remote_update.terminal_connection_ended", { targetId, error: detail });
        return staged(status, targetVersion);
      }
      // Still connected, so the machine refused the read: try again, and give
      // up only when it keeps refusing.
      readFailures += 1;
      logger.warn("remote_update.terminal_read_failed", { targetId, sessionId, attempt: readFailures, error: detail });
      if (readFailures >= MAX_READ_FAILURES) {
        return failed(status, targetVersion, `Couldn't read the update's progress on ${status.target.name}: ${detail}. ${manualHint}`);
      }
      continue;
    }
    readFailures = 0;
    if (!outcome) continue;
    logger.info("remote_update.terminal_finished", { targetId, exitCode: outcome.exitCode });
    if (outcome.exitCode === 0) return staged(status, targetVersion);
    return failed(
      status,
      targetVersion,
      `The update on ${status.target.name} stopped${outcome.exitCode == null ? "" : ` (exit ${outcome.exitCode})`}${outcome.output ? `: ${outcome.output}` : "."} ${manualHint}`,
    );
  }
  logger.warn("remote_update.terminal_timed_out", { targetId, sessionId });
  if (ptyId) {
    try {
      await callAction(targetId, project.projectId, { domain: "pty", action: "dispose", args: { ptyId, sessionId } });
    } catch {
      // Best effort: the terminal ends with the brain anyway.
    }
  }
  return failed(status, targetVersion, `The update on ${status.target.name} was still downloading after ${Math.round(args.timeoutMs / 60_000)} minutes, so ADE stopped waiting. ${manualHint}`);
}
