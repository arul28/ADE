import { isErrnoLikeCode } from "./codedError";
import { markExpectedFromWire } from "./expectedError";

/**
 * The error a caller throws for a brain's `{ ok: false, error }` action reply.
 *
 * The reply carries more than its message, and rebuilding it as a bare
 * `new Error(message)` dropped all of it: every failure that crossed the hop
 * reached Sentry and PostHog as code `unknown`. Kept here, with the wire's
 * meaning of each field:
 * - `code` a string: ADE's own code (`storage_read_failed`), set as `.code`
 *   so `parseCodedErrorMessage`, the expected-outcome codes and grouping read
 *   it. A platform errno never crosses (the brain leaves those behind), and one
 *   that did is not kept.
 * - `code` a number: the JSON-RPC code the brain answered with, as `.rpcCode`
 *   (`brainActionErrorCode` names it), never as `.code`, which is a string
 *   everywhere else.
 * - `expected`: the brain's expected-failure mark (`markExpectedFromWire`).
 * - `frames`: up to three of the brain's own stack frames, `function:line`
 *   with no paths (`brainStackFrames`), as `.brainFrames`, which the desktop's
 *   Sentry report carries as `extra.brainFrames` because a rebuilt error has
 *   no stack of the brain's. Older brains send none; older desktops ignore it.
 */
export type RuntimeActionReplyError = Error & {
  code?: string;
  rpcCode?: number;
  brainFrames?: string[];
};

const FRAME_VALUE = /^[A-Za-z0-9_$.<>\[\] ]{1,80}:\d{1,6}$/;

export function runtimeActionReplyError(errorRecord: unknown, fallbackMessage: string): RuntimeActionReplyError {
  const record = errorRecord && typeof errorRecord === "object" && !Array.isArray(errorRecord)
    ? errorRecord as Record<string, unknown>
    : {};
  const error: RuntimeActionReplyError = new Error(
    typeof record.message === "string" ? record.message : fallbackMessage,
  );
  const code = record.code;
  if (typeof code === "string" && code.trim() && !isErrnoLikeCode(code)) error.code = code.trim();
  else if (typeof code === "number" && Number.isInteger(code)) error.rpcCode = code;
  const frames = wireBrainFrames(record.frames);
  if (frames.length) error.brainFrames = frames;
  return markExpectedFromWire(error, record.expected);
}

/**
 * The brain frames a peer sent (an action reply's `frames`, or an internal
 * JSON-RPC error's `data.frames`), each re-checked against the
 * `function:line` shape; at most three.
 */
export function wireBrainFrames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((frame): frame is string => typeof frame === "string" && FRAME_VALUE.test(frame)).slice(0, 3)
    : [];
}

/** `.brainFrames` of an error rebuilt from a brain's reply, or null. */
export function readBrainFrames(error: unknown): string[] | null {
  const frames = (error as { brainFrames?: unknown } | null)?.brainFrames;
  return Array.isArray(frames) && frames.length ? frames.filter((frame): frame is string => typeof frame === "string") : null;
}

/**
 * The top three of an error's own frames that are ADE's code, as
 * `function:line`: no file names or paths (which name the person's machine),
 * no `node:` internals or dependencies. What a brain sends beside a failed
 * action's reply.
 */
export function brainStackFrames(error: unknown): string[] {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const location = match[2] ?? "";
    if (location.startsWith("node:") || /[/\\]node_modules[/\\]/.test(location)) continue;
    const fn = (match[1] ?? "<anonymous>").replace(/^Object\./, "").trim().slice(0, 80);
    const frame = `${fn}:${match[3]}`;
    if (FRAME_VALUE.test(frame)) frames.push(frame);
    if (frames.length === 3) break;
  }
  return frames;
}
