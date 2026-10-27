/**
 * Conditional reads for `run_ade_action` over a remote connection.
 *
 * A caller that sends `conditional: true` gets an `etag` on every large result.
 * Sending that etag back as `ifNoneMatch` on the same call makes the host
 * answer `notModified: true` without the result when it would have sent the
 * same bytes again; the caller reuses the copy it kept. The host still runs the
 * action, so only the transfer is saved. Older hosts ignore both fields and
 * always send the result; older callers never ask, so the host never hashes for
 * them.
 */
export const CONDITIONAL_ACTION_PARAM = "conditional";
export const CONDITIONAL_ACTION_IF_NONE_MATCH_PARAM = "ifNoneMatch";
/** Results shorter than this (as JSON) are sent as they are: not worth a hash or a kept copy. */
export const CONDITIONAL_ACTION_RESULT_MIN_CHARS = 8 * 1024;
