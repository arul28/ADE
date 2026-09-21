import { CTO_VOICE_SAMPLE_RATE } from "../../../shared/types/ctoVoice";

/**
 * What a voice call's failures MEAN, as pure functions.
 *
 * Split out of the call service because none of it needs a socket, a call or a
 * clock: every function here turns something the wire said into something a
 * person can act on, and the mapping is the part worth reading and testing on
 * its own. The service keeps the state machine; this file keeps the sentences.
 */

/** What a failed connection attempt told us, in the two forms it can arrive. */
export type CtoVoiceSocketFailure = {
  /** HTTP status of a rejected upgrade, when there was a response at all. */
  status?: number | null;
  /** Node's error code (`ENOTFOUND`, `ECONNREFUSED`, …), when there was one. */
  code?: string | null;
  /** The raw message, read only to recover a status or code nobody passed. */
  message?: string | null;
};

type CtoVoiceSocketFailureReason = {
  /** One sentence for the HUD, naming the thing the user can act on. */
  message: string;
  status: number | null;
  code: string | null;
};

/**
 * Codes that mean "this machine could not reach OpenAI at all".
 *
 * A DNS failure, a refused connection and a dead route are one problem from the
 * user's side — the network — and a different problem from a rejected key, so
 * they must not share a sentence.
 */
const CTO_VOICE_OFFLINE_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Turn a failed connection into something worth reading.
 *
 * "The voice connection failed." is true of every case below and useful in none
 * of them: the three that a user can actually do something about are a key
 * OpenAI refused, a key it is throttling, and a machine that is offline. Pure,
 * so the mapping is testable without a socket.
 *
 * The status is taken from the upgrade response when we have one and recovered
 * from `ws`'s own message when we do not — `Unexpected server response: 401` is
 * what arrives when nothing listened for the response itself.
 */
export function describeCtoVoiceSocketFailure(
  failure: CtoVoiceSocketFailure = {},
): CtoVoiceSocketFailureReason {
  const text = typeof failure.message === "string" ? failure.message : "";
  const parsedStatus = /unexpected server response:\s*(\d{3})/i.exec(text)?.[1];
  const status = typeof failure.status === "number" && Number.isFinite(failure.status)
    ? failure.status
    : parsedStatus
      ? Number(parsedStatus)
      : null;
  const explicitCode = typeof failure.code === "string" && failure.code.trim().length
    ? failure.code.trim().toUpperCase()
    : null;
  // A fake socket in a test, and some wrapped errors, carry the code only in
  // the text ("getaddrinfo ENOTFOUND api.openai.com").
  const code = explicitCode
    ?? [...CTO_VOICE_OFFLINE_ERROR_CODES].find((candidate) => text.toUpperCase().includes(candidate))
    ?? null;

  if (status === 401 || status === 403) {
    return { message: CTO_VOICE_REJECTED_KEY_MESSAGE, status, code };
  }
  if (status === 429) {
    return { message: "OpenAI is rate limiting this key. Try again in a minute.", status, code };
  }
  // Only when the upgrade never got a response: a 500 is OpenAI answering, not
  // a network that is down, and must not be blamed on the user's connection.
  if (status === null && code !== null && CTO_VOICE_OFFLINE_ERROR_CODES.has(code)) {
    return { message: "ADE could not reach OpenAI. Check your internet connection.", status, code };
  }
  return { message: "The voice connection failed.", status, code };
}

/**
 * The four sentences a key problem can reduce to.
 *
 * Shared between the handshake mapping and the session-error mapping, because
 * the same refusal reaches ADE either way — as an HTTP status when the upgrade
 * is rejected, and as an `error` event when the socket opened first — and the
 * user must not be told two different things about one key.
 */
const CTO_VOICE_REJECTED_KEY_MESSAGE =
  "OpenAI rejected this key. Check it under CTO settings, Voice.";
const CTO_VOICE_EXPIRED_KEY_MESSAGE =
  "Your OpenAI key has expired. Create a new key at platform.openai.com"
  + " and paste it under CTO settings, Voice.";
const CTO_VOICE_NO_CREDIT_MESSAGE =
  "Your OpenAI account has no credit for voice calls. Add billing at platform.openai.com.";

/** What an `error` event turned out to be about. */
type CtoVoiceServerErrorKind = "expired_key" | "rejected_key" | "no_credit" | "other";

type CtoVoiceServerErrorReason = {
  /** One line for the HUD. OpenAI's own words unless we have better ones. */
  message: string;
  kind: CtoVoiceServerErrorKind;
  /** True when the session cannot recover, so the call ends rather than limps. */
  fatal: boolean;
};

/**
 * Errors this service caused and can ignore.
 *
 * Both are races around one in-flight response: a barge-in that cancels a
 * response the server has already finished, and a `response.create` that
 * crosses a `response.done` on the wire. Neither is anything the user can act
 * on, and putting "Cancellation failed: no active response" on screen mid-call
 * would be worse than saying nothing.
 *
 * It does mean this list can hide a real defect: a `response.cancel` with no
 * `response_id` is answered with exactly that message, because it looks for a
 * response in the default conversation and every response here is out-of-band,
 * so every barge-in would fail silently and the CTO would talk on. Cancels are
 * named (`stopSpeaking`), so the message can only be the race.
 */
const CTO_VOICE_BENIGN_SERVER_ERRORS: readonly RegExp[] = [
  /no active response/i,
  /already has an active response/i,
];

/**
 * Turn an `error` event into the sentence the user needs.
 *
 * This is the half of the diagnosis the old code threw away. A rejected upgrade
 * never carries OpenAI's explanation — the handshake fails before there is a
 * session to explain anything — but an upgrade that SUCCEEDS and then fails
 * does: the reason arrives as an `error` event, and its message is the truth.
 * "Your API key has expired." is a different problem from "Incorrect API key",
 * which is a different problem again from an account with no credit, and each
 * has a different fix.
 *
 * Anything we do not recognise is passed through in OpenAI's own words rather
 * than replaced with a house sentence: a message we cannot classify is still a
 * message someone wrote to be read, and guessing at it is what hid this bug for
 * a whole release.
 *
 * Pure, so the mapping is testable without a socket.
 */
export function describeCtoVoiceServerError(
  error: { message?: unknown; code?: unknown; type?: unknown } = {},
): CtoVoiceServerErrorReason {
  const raw = typeof error.message === "string" ? error.message : "";
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  const haystack = `${raw} ${code} ${type}`.toLowerCase();
  const oneLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length) ?? "";

  if (/expired/.test(haystack)) {
    return { message: CTO_VOICE_EXPIRED_KEY_MESSAGE, kind: "expired_key", fatal: true };
  }
  // Before the key check: "You exceeded your current quota, please check your
  // plan and billing details" is about the account, not about the key, and
  // sending the user to re-paste a working key would waste their afternoon.
  if (/quota|billing|insufficient_quota|payment|no credit/.test(haystack)) {
    return { message: CTO_VOICE_NO_CREDIT_MESSAGE, kind: "no_credit", fatal: true };
  }
  // Deliberately narrow. A bare /invalid/ also matches "Invalid value: 'x' for
  // session.audio.output.voice", and telling someone their key is bad when a
  // parameter is bad sends them to the one place the problem is not.
  const rejectedKey = /incorrect api key|invalid api key|invalid_api_key|invalid authentication/
    .test(haystack)
    || /\binvalid\b[^.\n]*\bkey\b/.test(haystack)
    || /\bkey\b[^.\n]*\binvalid\b/.test(haystack);
  if (rejectedKey) {
    return { message: CTO_VOICE_REJECTED_KEY_MESSAGE, kind: "rejected_key", fatal: true };
  }
  return {
    message: oneLine.length ? oneLine : "The voice session reported an error.",
    kind: "other",
    fatal: false,
  };
}

/** True for the two errors this service's own timing can cause. */
export function isBenignCtoVoiceServerError(message: string): boolean {
  return CTO_VOICE_BENIGN_SERVER_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * The benign error that means the server is STILL generating.
 *
 * Told apart from its neighbour because the two say opposite things about the
 * lock. "No active response" is a cancel that arrived a beat late — whatever it
 * aimed at is over, and the lock is stale. "Already has an active response" is
 * the server refusing the `response.create` this service just sent WHILE its
 * own response is still running: releasing the lock there let the queue drain
 * itself into the same refusal, line after line, until every sentence ADE had
 * queued was gone and none of them was said.
 */
export function isCtoVoiceActiveResponseConflict(message: string): boolean {
  return /already has an active response/i.test(message);
}

/**
 * How long one microphone frame lasts, read off the frame itself.
 *
 * Derived from the payload rather than from a clock on purpose. The wall-clock
 * gap between `speech_started` and `speech_stopped` is the SERVER's opinion,
 * delivered a network round trip late and padded by its own VAD, so it says
 * nothing reliable about how long the user's mouth was open. The bytes do: PCM16
 * mono at the session rate is two bytes a sample, and the frames are the same
 * audio the transcriber was given.
 *
 * Exported because the arithmetic is the load-bearing part of the length half of
 * the transcript gate, and it is worth a test of its own.
 */
export function ctoVoiceFrameDurationMs(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return (bytes / 2) * (1_000 / CTO_VOICE_SAMPLE_RATE);
}

/**
 * Hand the rejected upgrade's status up, and only THEN release the socket.
 *
 * The order is the whole function. Destroying the request makes `ws` emit
 * `error` synchronously — "WebSocket was closed before the connection was
 * established" — and that error knows nothing about the 401 it was caused by.
 * Releasing first therefore let the generic sentence win the race against the
 * one the user needs, which is how a rejected key came back as "The voice
 * connection failed." The status is reported, described and latched before
 * anything is torn down; the destroy afterwards only frees the socket `ws`
 * hands to a listener and will not otherwise clean up.
 */
export function forwardUnexpectedResponse(
  handler: (payload?: unknown) => void,
  request: { destroy?: () => void } | null | undefined,
  response: { statusCode?: number | null } | null | undefined,
): void {
  try {
    handler({ statusCode: response?.statusCode ?? null });
  } finally {
    try {
      request?.destroy?.();
    } catch {
      // The handshake is already over; this only releases the socket.
    }
  }
}
