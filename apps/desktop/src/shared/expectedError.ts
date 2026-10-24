/**
 * Errors that are an answer, not a bug.
 *
 * A path outside the folders ADE may read, a lane that still has children, a
 * browser tab that closed, a network that is down: the caller gets the
 * message and acts on it, and nothing in ADE is broken. The code that throws
 * knows that; a Sentry hook reading the message later can only guess. So the
 * throw site says so, with a kind:
 *
 *   - `user`: the user's or the agent's own input or choice (a path, a
 *     closed tab, a note too long, a refusal they can act on);
 *   - `environment`: the machine is not set up for it (no developer tools,
 *     a provider that cannot start there, a service not running yet);
 *   - `network`: the request never got an answer from a remote service.
 *
 * Every Sentry gate (`sentry/expectedFailure.ts`, each process's
 * `beforeSend`) keeps these out of issues, as Sentry Logs and local log lines
 * instead. Anything not marked is reported, as before.
 *
 * The mark is a plain property, not only a class, so an error type that
 * already exists (and its `name`, which reaches the renderer's text through
 * Electron) keeps its shape. Errors crossing JSON-RPC carry the kind as an
 * `expected` field beside the message; see `jsonrpc.ts` and the runtime
 * clients that read it back.
 */

export type ExpectedErrorKind = "user" | "environment" | "network";

const KINDS: ReadonlySet<string> = new Set<ExpectedErrorKind>(["user", "environment", "network"]);

type Marked = { adeExpected?: unknown };

/** A kind read off the wire, or null when the value is not one. */
function readExpectedErrorKind(value: unknown): ExpectedErrorKind | null {
  return typeof value === "string" && KINDS.has(value) ? (value as ExpectedErrorKind) : null;
}

/**
 * An expected failure with no type of its own. The `name` stays "Error", so the
 * text a renderer sees ("Error invoking remote method …: Error: …") and every
 * parser of it is unchanged.
 */
export class AdeExpectedError extends Error {
  readonly adeExpected: ExpectedErrorKind;

  constructor(message: string, kind: ExpectedErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.adeExpected = kind;
  }
}

/** Mark an existing error expected; returns it, so `throw markExpected(…)` reads naturally. */
export function markExpected<E extends Error>(error: E, kind: ExpectedErrorKind): E {
  (error as E & Marked).adeExpected = kind;
  return error;
}

/** The kind an error was marked with, or null for every error that was not. */
export function expectedErrorKind(error: unknown): ExpectedErrorKind | null {
  if (!error || typeof error !== "object") return null;
  return readExpectedErrorKind((error as Marked).adeExpected);
}

/** Copy `from`'s mark onto `to`, for a boundary that rethrows a failure as a new error. */
export function carryExpected<E extends Error>(from: unknown, to: E): E {
  const kind = expectedErrorKind(from);
  return kind ? markExpected(to, kind) : to;
}

/** Mark `error` with the kind a peer sent beside its message (the wire's `expected`), if it sent one. */
export function markExpectedFromWire<E extends Error>(error: E, wireKind: unknown): E {
  const kind = readExpectedErrorKind(wireKind);
  return kind ? markExpected(error, kind) : error;
}
