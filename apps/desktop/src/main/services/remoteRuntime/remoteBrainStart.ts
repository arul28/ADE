import { RUNTIME_SERVICE_START_WAIT_MS } from "../../../../../ade-cli/src/serviceManager/runtimeServiceBudgets";
import { markExpected } from "../../../shared/expectedError";
import { RemoteRuntimeConnectError } from "../../../shared/types/remoteRuntime";
import { sleep } from "../shared/utils";
import type { SshExecResult } from "./sshTransport";
import { findInErrorCauses } from "./pairedRuntimeRoutes";

/**
 * Starting a remote machine's ADE brain during a connect.
 *
 * The desktop reaches a POSIX remote through `ade --socket … rpc --stdio`. An
 * explicit `--socket` turns off the CLI's own spawn and service repair, so a
 * machine with no brain running (a headless Linux box with no ADE app) answers
 * with ENOENT or ECONNREFUSED on its socket. On a connect the person asked for,
 * the desktop then runs `ade brain start` there, which installs the login
 * service (or ADE's own supervised process where no service manager answers)
 * and waits for the brain's handover, and dials again until the socket
 * answers. Background reconnects never start a brain: one the person stopped
 * stays stopped. Neither does a layout whose environment forbids a service
 * install (`ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1`).
 *
 * A Windows remote runs `ade rpc --stdio` with no `--socket`, so the relay
 * there starts a brain itself; only the suggested command is needed for it.
 */

/** `brain start` waits up to RUNTIME_SERVICE_START_WAIT_MS for the handover; this adds room for the install. */
const REMOTE_BRAIN_START_TIMEOUT_MS = RUNTIME_SERVICE_START_WAIT_MS + 30_000;
/** How long the brain may take to accept connections after a start that reported success. */
export const REMOTE_BRAIN_SOCKET_WAIT_MS = RUNTIME_SERVICE_START_WAIT_MS;
const REMOTE_BRAIN_SOCKET_RETRY_MS = 2_000;

/** Who asked for this connect. Only a person's own connect may start a brain. */
export type RemoteConnectInitiator = "user" | "background";

/** Who asked for a dial, and whether it was given up (the target was disconnected or removed). */
export type RemoteConnectIntent = { initiatedBy: RemoteConnectInitiator; isAbandoned: () => boolean };

export type RemoteBrainStartOutcome = { started: boolean; output: string };

/**
 * The command a person would run to start the brain (`display`), and the one
 * the desktop runs over SSH (`exec`): the same binary and channel, the second
 * with the bootstrap's environment prefix (PATH, NODE_PATH) and `--text`.
 */
export type PosixBrainStartCommand = { display: string; exec: string };

/**
 * What the SSH server says when it opened the connection but would not run a
 * command on it: it refused the exec (or subsystem) request, or closed the
 * channel before answering. ssh2 reports these as bare sentences ("Unable to
 * exec", from a CHANNEL_FAILURE or CHANNEL_CLOSE reply).
 */
const SSH_COMMAND_REFUSED_PATTERN = /\bUnable to (?:exec|start subsystem)\b|\(SSH\) Channel open failure|\bChannel open failure\b/i;

/** The SSH server refused to run a command (see SSH_COMMAND_REFUSED_PATTERN), here or in a cause. */
export function isSshCommandRefusedError(error: unknown): boolean {
  return causeMatches(error, (candidate) => SSH_COMMAND_REFUSED_PATTERN.test(errorText(candidate)));
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** `test` holds for the error or one of the errors that caused it (`findInErrorCauses`). */
function causeMatches(error: unknown, test: (candidate: unknown) => boolean): boolean {
  if (error == null) return false;
  if (typeof error !== "object") return test(error);
  return findInErrorCauses(error, (candidate) => (test(candidate) ? true : undefined)) === true;
}

/** No brain answers at the runtime's socket or named pipe. */
export function isRemoteBrainNotRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:ENOENT|ECONNREFUSED)\b[^\n]*(?:\.sock\b|\\\\[.?]\\pipe\\)/i.test(message);
}


function homeRelative(expression: string): string {
  return expression.replace(/^\$HOME\//, "~/").replace(/"/g, "");
}

/** A POSIX remote: `binaryExpr` is the uploaded binary's expression or `ade` on the PATH. */
export function posixBrainStartCommand(args: {
  homeDirExpr: string;
  channel: string | null;
  binaryExpr: string;
  runtimeEnvPrefix: string;
}): PosixBrainStartCommand {
  const channelEnv = args.channel
    ? `ADE_HOME=${homeRelative(args.homeDirExpr)} ADE_PACKAGE_CHANNEL=${args.channel} `
    : "";
  return {
    display: `${channelEnv}${homeRelative(args.binaryExpr)} brain start`,
    exec: `${args.runtimeEnvPrefix}${args.binaryExpr} brain start --text`,
  };
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A Windows remote's start command, as a PowerShell line for a person. Never run by the desktop (see above). */
export function windowsBrainStartCommand(args: {
  adeHome: string;
  channel: string | null;
  binary: string;
}): string {
  const env = args.channel
    ? [`$env:ADE_HOME = ${powerShellLiteral(args.adeHome)}`, `$env:ADE_PACKAGE_CHANNEL = ${powerShellLiteral(args.channel)}`]
    : [];
  return [...env, `& ${powerShellLiteral(args.binary)} brain start`].join("; ");
}

function shortCommandOutput(result: SshExecResult): string {
  const text = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  const firstLines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 3).join(" ");
  return firstLines.length > 400 ? `${firstLines.slice(0, 400)}…` : firstLines;
}

/**
 * Open the runtime; when no brain answers and `startBrain` is given, start
 * one and dial again until it answers or REMOTE_BRAIN_SOCKET_WAIT_MS passes.
 * `isAbandoned` (the target was disconnected or removed) stops the wait.
 * `onStart` hears `null` as the start begins, then what it did.
 */
export async function openRuntimeStartingBrain<T>(args: {
  openRuntime: () => Promise<T>;
  startBrain: ((timeoutMs: number) => Promise<SshExecResult>) | null;
  isAbandoned: () => boolean;
  onStart: (outcome: RemoteBrainStartOutcome | null) => void;
}): Promise<T> {
  try {
    return await args.openRuntime();
  } catch (firstError) {
    if (!args.startBrain || !isRemoteBrainNotRunningError(firstError) || args.isAbandoned()) throw firstError;
    args.onStart(null);
    let outcome: RemoteBrainStartOutcome;
    try {
      const started = await args.startBrain(REMOTE_BRAIN_START_TIMEOUT_MS);
      outcome = { started: started.code === 0, output: shortCommandOutput(started) };
    } catch (startError) {
      if (isSshCommandRefusedError(startError)) throw startError;
      const message = startError instanceof Error ? startError.message : String(startError);
      outcome = { started: false, output: message.slice(0, 400) };
    }
    args.onStart(outcome);
    if (!outcome.started) throw firstError;
    const deadline = Date.now() + REMOTE_BRAIN_SOCKET_WAIT_MS;
    for (;;) {
      try {
        return await args.openRuntime();
      } catch (retryError) {
        if (!isRemoteBrainNotRunningError(retryError) || Date.now() >= deadline || args.isAbandoned()) throw retryError;
        await sleep(REMOTE_BRAIN_SOCKET_RETRY_MS);
      }
    }
  }
}

/** Not-running errors from a dial that did not start the brain but a person's connect would have. */
const brainStartableByUserErrors = new WeakSet<object>();

/** Whether dialing again as `"user"` would start the brain this error says is not running. */
export function isBrainStartableByUserError(error: unknown): boolean {
  return typeof error === "object" && error !== null && brainStartableByUserErrors.has(error);
}

/**
 * The connect error for a machine whose brain is not running, with what a
 * start did. `startableByUser`: this machine's layout lets a person's connect
 * start the brain (and none was tried here).
 */
export function remoteBrainNotRunningConnectError(
  display: string,
  detail: string,
  cause: unknown,
  start: RemoteBrainStartOutcome | null,
  startableByUser: boolean,
): RemoteRuntimeConnectError {
  const message = start?.started
    ? "ADE started its background service (the ADE brain) on this machine, but the brain did not accept "
      + `connections within ${Math.round(REMOTE_BRAIN_SOCKET_WAIT_MS / 1000)}s. Check \`${display.replace(/ start$/, " status")}\` there, then press Try again.`
    : start
      ? "ADE could not start its background service (the ADE brain) on this machine"
        + `${start.output ? `: ${start.output}` : "."} Start it there with \`${display}\`, then press Try again.`
      : "ADE is installed on this machine, but its background service (the ADE brain) is not running. "
        + `Start it there with \`${display}\` (or open the ADE app on that machine), then press Try again.`;
  const error = markExpected(new RemoteRuntimeConnectError({
    kind: "generic",
    message,
    detail: start?.output ? `${detail}\nbrain start: ${start.output}` : detail,
  }, cause), "environment");
  if (startableByUser && !start) brainStartableByUserErrors.add(error);
  return error;
}
