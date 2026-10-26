/**
 * Failures that are an answer, not a bug, and so never become a Sentry issue:
 * a peer on an older version that does not know an action, an action the
 * caller is not allowed or not able to call, and the outcomes below. One list,
 * so the IPC capture in main, the action endpoint in the brain and every
 * process's `beforeSend` cannot disagree.
 *
 * A handler's own validation error is reported by default; it joins
 * `EXPECTED_OUTCOME_PATTERNS` once Sentry shows it is a state the user can be
 * in rather than a defect. Callers keep these as budgeted Sentry Logs, so a
 * misroute that suddenly answers "not found" everywhere is still searchable.
 */
import {
  ACTION_NOT_CALLABLE_CODE,
  ACTION_NOT_EXPOSED_CODE,
  isUnsupportedAdeActionError,
  parseCodedErrorMessage,
} from "../codedError";
import { expectedErrorKind } from "../expectedError";
import { GITHUB_AUTOLINKS_REFUSED } from "../githubAutolinks";
import { PENDING_INPUT_SEND_BLOCKED_MESSAGE } from "../pendingInputAnswers";
import { SIMCTL_MISSING } from "../xcodeToolchain";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matched against the error message (or event text). Added from real Sentry traffic, 2026-10-14 and 2026-10-16. */
export const EXPECTED_OUTCOME_PATTERNS: readonly RegExp[] = [
  // A lane or chat that was deleted, archived or moved while a view still held its id.
  /\bLane not found: /,
  /That chat does not exist on this machine/,
  /\bchat session '[^']+' was not found/i,
  // The project's runtime is still starting (or reconnecting) after a launch or switch.
  /unavailable until ADE is connected to the project runtime/,
  /Local runtime project is not available for this window/,
  // The brain restarting to apply an update, or a project mid-move or mid-switch: the window retries when it is back.
  /ADE is applying an update\. The background service is restarting/,
  /\bproject_moving: This project is being moved/,
  /Project is switching\. Wait for the current project to finish loading/,
  // A project that is set to follow another ADE machine. Hosting it here is not
  // a thing this computer can do, and the message names the machine to open it
  // on, so a caller (or a retrying brain) is being answered, not broken.
  /^This project is set to follow another ADE machine\b/,
  // Mac-only surfaces asked for before the runtime that owns them connected.
  /^(Mac Desktop is not available on this machine|iOS Simulator service is not available)\.$/,
  // A paired machine that is asleep, offline or stopped.
  /Can't reach .+ it may be asleep or ADE may be stopped there/,
  /Remote ADE service connection failed recently/,
  /Remote ADE service timed out waiting for method/,
  /Account Activity is reconnecting/,
  /is not sharing this project/,
  // The link to a paired machine dropping or lagging; the pool reconnects on its own.
  /Remote ADE service connection closed\b/,
  /Runtime RPC channel fell behind the sync connection/,
  /^Sync WebSocket is not open\.$/,
  /^IPC handler for 'ade\.remoteRuntime\.callAction' timed out after/,
  /push relay \w+ failed: (account owner changed|HTTP 5\d\d)/,
  // Git states the user is told about and resolves themselves.
  /\bDIRTY_WORKTREE:/,
  /nothing to commit, working tree clean/,
  /Lane worktree is missing\. Restore or recreate/,
  /GitHub auth missing\./,
  /This credential cannot access /,
  /Unable to detect GitHub repo from git remote/,
  /The base branch ".+" was not found\./,
  /\bfatal: invalid reference: /,
  /\bfatal: not a git repository\b/,
  /\bgit_untrusted_folder:/,
  /Refusing to register the user home directory or filesystem root/,
  /This chat already started — delete its lane/,
  // A screenshot or image attachment cleaned up while a chat still shows it.
  /\bPath does not exist: .+\.(png|jpe?g|gif|webp)$/i,
  // Answers to an agent driving a browser or a desktop: it fixes its call and retries.
  /Invalid element selector: /,
  /\b(MAC|WINDOWS)_DESKTOP_(NO_DISPLAY|NO_WINDOW|WINDOW_NOT_FOUND|HANDLE_EXPIRED|CONSENT_REQUIRED|OUT_PATH_OUTSIDE_ROOT|INPUT_LEASE_REQUIRED|PERMISSION_REQUIRED|UNSUPPORTED_PLATFORM):/,
  // Windows host states the user resolves (set up, unlock, free the screen, sign in again).
  /\bWINDOWS_DESKTOP_(SETUP_REQUIRED|HELD|LOCKED|NOT_CONSOLE_SESSION|WRONG_PASSWORD|CANCELLED|ELEVATED_WINDOW|WINDOW_ACTION_FAILED):/,
  /is not on this lane's display/,
  /already has an active writer/,
  /^No matching element was found\.$/,
  /Timed out waiting for the App Control condition after/,
  /\bAPP_CONTROL_RECORDING_NOT_RUNNING:/,
  /^Artifact file not found: /,
  /\bAPP_CONTROL_DEBUG_PORT_CLOSED:/,
  // A PR, review thread or PR creation GitHub refuses; the agent is told why.
  /^PR not found: /,
  /\bdoes not belong to PR \d+/,
  /Failed to create pull request for .+: Validation Failed/,
  // An agent filing the same proof twice; the caller is told which one it matches.
  /\bPROOF_DUPLICATE:/,
  // A provider login that lost access; the user re-signs in.
  /signed in but reports no available models/,
  // GitHub's own outage, not ADE's.
  /GitHub API request failed \(HTTP 5\d\d\)/,
  // Added from Sentry traffic, 2026-10-23.
  // GitHub, Jira and remote-machine sign-ins the user has to fix in Settings.
  /GitHub auth is invalid or missing required access/,
  // Added from Sentry traffic, 2026-10-25: a repository the credential cannot see.
  /^GitHub auth cannot access [^:]+: .+\. Update it in Settings to sync pull requests\.$/,
  /\bAPI rate limit (?:already )?exceeded for user ID\b/,
  /\[jira:unauthenticated\]/,
  GITHUB_AUTOLINKS_REFUSED,
  /^SSH authentication failed for user\(s\) /,
  /^ADE couldn't connect to this machine\. Check that ADE is open there/,
  /\bWINDOWS_DESKTOP_SIGN_IN_FAILED: Windows could not verify the password\.|^(?:invalid_argument: )?Enter a Windows user name and password\.$/,
  // A remote machine the user disconnected, or a reconnect mid-call; the pool reconnects on its own.
  /^Remote machine was manually disconnected\. Connect again to use this remote project\.$/,
  /^Remote ADE service connection was interrupted before ADE could confirm the action result\./,
  // ADE quitting while a call was still in flight.
  /^Local runtime connection pool is disposed\.$/,
  // A project whose folder or database moved or vanished; ADE tells the user where.
  /The project database is no longer available at its original location/,
  /\bproject_data_missing: /,
  /\bProject folder not found: /,
  // A Mac with the Command Line Tools but no Xcode.
  SIMCTL_MISSING,
  // The machine itself is out of processes or disk.
  /\bspawn \S+ EAGAIN\b/,
  /\bENOSPC: no space left on device\b/,
  // A chat waiting on the user: a recovery choice, a pending question, a turn still running.
  /This chat requires an explicit continuity recovery action before another turn can be sent/,
  new RegExp(`^${escapeRegExp(PENDING_INPUT_SEND_BLOCKED_MESSAGE)}`),
  /^Wait for the current response to finish before /,
  /^This chat is still responding\. Wait for the turn to end/,
  /\bis still owned by another ADE runtime\. Stop it from that runtime/,
  // Lane rules the user is told about.
  /^Primary lane cannot be (?:deleted|renamed|archived)$/,
  /^Lane delete is already running: /,
  /^Color already in use by lane /,
  // Apple simulator answers: a device another lane owns, one that is off, a path outside the build.
  // (IS_EXTRA is marked where it is thrown now; the code stays for older brains.)
  /\b(?:APPLE_DEVICE_(?:NOT_LANE_OWNED|OFF|EXISTS|IS_EXTRA)|IOS_SIMULATOR_(?:OUT_PATH_OUTSIDE_ROOT|NO_BUILDABLE_TARGET)):/,
  // An agent's Apple call on a lane that has no device yet; the answer says how
  // to make one. Marked where it is thrown now (shared/expectedError.ts); the
  // text stays for older brains, whose errors arrive without the mark.
  /^This lane has no Apple device yet\. /,
  // The web client while its computer reconnects or the user switches project.
  /^Reconnecting to this computer\. Try again when connected\.$/,
  /^Project connection changed\.$/,
  // ADE's own fetch boundaries (shared/fetchTransportFailure.ts) name undici's
  // reason in the text, because the cause chain does not cross RPC. The same
  // offline reasons as NETWORK_FAILURE below; a bare reset stays an issue.
  /^(?:Can't reach GitHub|ADE can't reach its account service) \((?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|TLS handshake cut off)\)/,
  /^ADE's account service did not answer in time\.$/,
];

// Each of these names the address or host it failed to reach, so a loopback
// target is visible. A reset or a closed socket mid-request is not on the list:
// its message names no address.
// A TLS handshake cut off names no address either, but only a remote HTTPS
// host has one, so it cannot be a local service.
const NETWORK_FAILURE = /\b(ConnectTimeoutError|Connect Timeout Error|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|Client network socket disconnected before secure TLS connection was established/;
const LOOPBACK_ADDRESS = /(^|[\s(\[,])(127\.\d+\.\d+\.\d+|::1|localhost)(?=[\s:)\],]|$)/;

/**
 * `fetch failed` because there is no network, or one that blocks ADE's relays.
 * undici names the reason only in the causes. A loopback cause is kept as an
 * issue: that is a local service that stopped answering, not the network.
 */
export function isOfflineFetchFailure(message: string, causes: readonly string[]): boolean {
  if (message !== "fetch failed") return false;
  return causes.some((cause) => NETWORK_FAILURE.test(cause))
    && !causes.some((cause) => LOOPBACK_ADDRESS.test(cause));
}

const MAX_CAUSES = 16;

/**
 * The text of each error under `error` (its `cause` chain and an
 * AggregateError's members), with undici's socket address when it kept one.
 * Bounded, so a huge or cyclic chain cannot slow the report; past the bound the
 * failure is not classed as offline and stays an issue.
 */
function causeTexts(error: Error): string[] | null {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error.cause];
  while (pending.length > 0) {
    const next = pending.shift();
    if (!(next instanceof Error) || seen.has(next)) continue;
    if (seen.size >= MAX_CAUSES) return null;
    seen.add(next);
    const { code, errors, socket } = next as Error & { code?: unknown; errors?: unknown; socket?: { remoteAddress?: unknown } };
    const address = typeof socket?.remoteAddress === "string" ? ` ${socket.remoteAddress}` : "";
    texts.push(`${next.name}: ${next.message}${typeof code === "string" ? ` (${code})` : ""}${address}`);
    pending.push(next.cause);
    if (Array.isArray(errors)) {
      if (errors.length > MAX_CAUSES) return null;
      pending.push(...errors);
    }
  }
  return texts;
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

export function isExpectedOutcomeText(text: string): boolean {
  return Boolean(text) && EXPECTED_OUTCOME_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Codes `codedError` puts on an error rather than in its message, for the
 * same expected states the text patterns name once the code crosses the wire
 * as a `code: message` prefix.
 */
const EXPECTED_OUTCOME_CODES: ReadonlySet<string> = new Set(["project_data_missing", "project_moving"]);

/**
 * An answer the caller gets, worth a Sentry Log but not an issue. The throw
 * site's own mark (`shared/expectedError.ts`) decides first; the text patterns
 * above are for errors thrown before that mark existed, or by code that
 * cannot carry one.
 */
export function isExpectedOutcome(error: unknown): boolean {
  if (expectedErrorKind(error)) return true;
  const text = failureText(error);
  if (isExpectedOutcomeText(text)) return true;
  const code = parseCodedErrorMessage(error).code;
  if (code && EXPECTED_OUTCOME_CODES.has(code)) return true;
  if (text !== "fetch failed" || !(error instanceof Error)) return false;
  const causes = causeTexts(error);
  return causes !== null && isOfflineFetchFailure(text, causes);
}

const PROGRAMMING_ERROR_NAMES = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError", "EvalError"]);
const STORAGE_FAILURE = /\bSQLite\b|\bSQLITE_|\bdatabase is (?:not open|locked)\b|\bdatabase disk image is malformed\b/i;

/** System-call failures that mean the machine is in trouble, not that a path was wrong. */
const RESOURCE_ERRNOS = new Set(["EMFILE", "ENFILE", "ENOMEM", "EIO"]);

/**
 * A failure that is a defect in ADE whoever made the call: a JavaScript
 * runtime error, the project database failing, or the machine running out of
 * files, memory or I/O. An agent's own mistakes (a tab that closed, a file
 * that does not exist, a note too long) are answers to the agent; these are
 * not.
 */
export function isProgrammingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return PROGRAMMING_ERROR_NAMES.has(error.name)
    || STORAGE_FAILURE.test(error.message)
    || (typeof code === "string" && RESOURCE_ERRNOS.has(code));
}

export function isExpectedFailure(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const code = parseCodedErrorMessage(error).code;
  return code === ACTION_NOT_CALLABLE_CODE || code === ACTION_NOT_EXPOSED_CODE;
}
