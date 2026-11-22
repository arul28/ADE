/**
 * Starting a cloud computer's own sign-in: the command run on it, its code or
 * its own reason when none showed, and starting it again while that reason is
 * one a moment fixes. The approval and the wait for the account row live in
 * `cloudMachineCreator.ts`.
 */
import { sanitizeAgentFailureText } from "../../../shared/chatErrorPresentation";
import type { CloudProvider } from "./cloudProvider";

/**
 * Starts a device sign-in on the box in the background (it keeps polling for
 * the approval after exec returns) and prints the code it shows: `ade login
 * --headless` for a new machine, `ade machines reconnect` for one removed from
 * the account. Reuses a sign-in that is already running, so a retried exec
 * never makes a second code.
 */
function startSignInCommand(kind: "login" | "reconnect", fresh = false): string {
  const command = kind === "login" ? "ade login --headless --max-wait 900" : "ade machines reconnect";
  const files = `$ADE_HOME/logs/cloud-${kind === "login" ? "sign-in" : "reconnect"}`;
  return [
    `log="${files}.log"; pidf="${files}.pid"`,
    'mkdir -p "$ADE_HOME/logs"',
    // A fresh code: the running sign-in's code was already used.
    ...(fresh ? [`if [ -f "$pidf" ] && grep -q ${kind} "/proc/$(cat "$pidf")/cmdline" 2>/dev/null; then kill "$(cat "$pidf")" 2>/dev/null; sleep 1; fi`] : []),
    // A pid only counts while it is still that command: a copied disk (a fork)
    // carries its source's pid file, and the number can belong to anything here.
    `if ! { [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && grep -q ${kind} "/proc/$(cat "$pidf")/cmdline" 2>/dev/null; }; then`,
    '  : > "$log"',
    `  nohup setsid ${command} > "$log" 2>&1 < /dev/null &`,
    '  echo $! > "$pidf"',
    "fi",
    "i=0",
    "while [ $i -lt 90 ]; do",
    '  code=$(sed -n "s/.*enter code: *\\([A-Za-z0-9-]*\\).*/\\1/p" "$log" | head -n 1)',
    '  if [ -n "$code" ]; then echo "ADE_USER_CODE=$code"; exit 0; fi',
    '  if ! kill -0 "$(cat "$pidf")" 2>/dev/null; then break; fi',
    "  sleep 1; i=$((i+1))",
    "done",
    // Enough lines for the reason: `ade` prints it, then its details as JSON.
    'tail -n 30 "$log" >&2',
    "exit 3",
  ].join("\n");
}

/** A detail line of `ade`'s JSON error output that carries words: `"cause": "…"`. */
const JSON_REASON_FIELD = /^"(?:cause|message|error)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?$/;

/**
 * What a sign-in's output can carry beyond what `sanitizeAgentFailureText`
 * (colour codes, control characters, secret-shaped values) takes out: a
 * device link keeps only its host (its query holds the sign-in code), a
 * `code=`, `grant=` or `key=` value, the machine's ids (UUIDs, and the short
 * mixed letter-and-digit ids its name and lanes carry) and any long opaque
 * string become "…".
 */
function scrubSignInLine(line: string): string {
  return line
    .replace(/\bhttps?:\/\/([^\s/?#"']+)[^\s"']*/gi, (_match, host: string) => host)
    .replace(/\b(key|code|grant)(\s*[=:]\s*)\S+/gi, "$1$2…")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "…")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "…")
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/g, "…");
}

/**
 * The computer's own reason a sign-in didn't start: the last line that says
 * something in what `ade login` (or `ade machines reconnect`) printed, cleaned
 * of colour codes, QR blocks, JSON punctuation, tokens and raw ids. The
 * `cause` of `ade`'s JSON details wins over the generic line before it,
 * because it comes later. Null when nothing readable is left.
 */
function cloudSignInFailureReason(output: string): string | null {
  const lines = sanitizeAgentFailureText(output).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let line = (lines[index] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!line) continue;
    const field = JSON_REASON_FIELD.exec(line);
    if (field) {
      try {
        line = String(JSON.parse(`"${field[1]}"`)).trim();
      } catch {
        continue;
      }
    } else if (/^[{}[\],]+$/.test(line) || /^"[^"]+"\s*:/.test(line)) {
      continue;
    }
    // A QR code's rows, a stack frame, and the wait line the command prints before it polls.
    if (/[▀-▟]/.test(line) || /^at\s+\S/.test(line) || /^Waiting for sign-in/i.test(line)) continue;
    // The sign-in instructions themselves: a code was shown, they are no reason.
    if (/^(?:To finish signing in|Or,? (?:open|to sign in))\b/i.test(line)) continue;
    const cleaned = scrubSignInLine(line.replace(/^ade:\s*/i, "")).replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]{3}/.test(cleaned)) continue;
    return cleaned.length > 220 ? `${cleaned.slice(0, 219)}…` : cleaned;
  }
  return null;
}

/**
 * A reason a moment later may fix: the computer couldn't reach ADE's account
 * service yet (its network or DNS comes up after its ADE answers), or its ADE
 * was still starting.
 */
function isTransientCloudSignInFailure(reason: string | null): boolean {
  if (!reason) return false;
  return /device service (?:could not be reached|timed out)|fetch failed|\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|Failed to initialize the ADE brain/i.test(reason);
}

/** The card's sentence when a computer's sign-in didn't start, with the computer's own reason. */
export function cloudSignInNotStartedMessage(subject: string, started: { reason: string | null }): string {
  const head = `${subject} didn't start its sign-in.`;
  if (!started.reason) return `${head} It showed no sign-in code and gave no reason.`;
  return `${head} It said: ${/[.!?…]$/.test(started.reason) ? started.reason : `${started.reason}.`}`;
}

export type CloudBoxSignInStart = {
  userCode: string | null;
  exitCode: number;
  reason: string | null;
  /** Its `ade login` already kept trying: starting it again would stack a second wait on the first. */
  retriedOnItsOwn: boolean;
};

/**
 * Starts a device sign-in on the box (see `startSignInCommand`) and returns its
 * code, or null when none showed, with the box's own reason then.
 */
async function startCloudBoxSignIn(
  client: CloudProvider,
  instanceId: string,
  kind: "login" | "reconnect",
  signal?: AbortSignal,
  options: { fresh?: boolean } = {},
): Promise<CloudBoxSignInStart> {
  const started = await client.exec(instanceId, startSignInCommand(kind, options.fresh === true), { timeoutMs: 120_000, signal });
  const userCode = /ADE_USER_CODE=([A-Za-z0-9-]+)/.exec(started.stdout)?.[1] ?? null;
  const output = `${started.stdout}\n${started.stderr}`;
  return {
    userCode,
    exitCode: started.exitCode,
    reason: userCode ? null : cloudSignInFailureReason(output),
    // A newer image's `ade login` retries an unreachable account service itself and says so.
    retriedOnItsOwn: !userCode && /\bADE kept trying\b/.test(output),
  };
}

/** How long a sign-in that couldn't reach ADE's account service yet is started again. */
const SIGN_IN_START_RETRY_MS = 60_000;
const SIGN_IN_START_RETRY_DELAY_MS = 5_000;

/**
 * `startCloudBoxSignIn`, started again for up to a minute while the box's
 * reason is one a moment fixes (`isTransientCloudSignInFailure`). A box whose
 * ADE answers can still be seconds from a working network, and a wake can be
 * a fresh boot. A newer box's `ade login` retries on its own and says so, and
 * is not started again; this covers the boxes made from an older image.
 */
export async function startCloudBoxSignInWhenReady(
  client: CloudProvider,
  instanceId: string,
  kind: "login" | "reconnect",
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
    sleep: (ms: number) => Promise<void>;
    logger?: { info?(event: string, meta?: Record<string, unknown>): void };
  },
): Promise<CloudBoxSignInStart> {
  const deadline = Date.now() + SIGN_IN_START_RETRY_MS;
  let fresh = options.fresh === true;
  for (let attempt = 1; ; attempt += 1) {
    const started = await startCloudBoxSignIn(client, instanceId, kind, options.signal, { fresh });
    if (started.userCode || options.signal?.aborted || started.retriedOnItsOwn || !isTransientCloudSignInFailure(started.reason)) {
      return started;
    }
    if (Date.now() + SIGN_IN_START_RETRY_DELAY_MS > deadline) return started;
    options.logger?.info?.("cloud.sign_in_start_retry", { instanceId, attempt, exitCode: started.exitCode });
    // The failed command has exited, so the next one starts a new sign-in anyway.
    fresh = false;
    await options.sleep(SIGN_IN_START_RETRY_DELAY_MS);
  }
}
