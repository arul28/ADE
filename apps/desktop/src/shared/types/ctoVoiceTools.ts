/**
 * The function tools a realtime voice session is given, and the ask modes.
 *
 * Its own module because the names are a CONTRACT with the wire: the call
 * service dispatches on them, the prompt teaches them, and the response queue
 * answers them. A file that only needs a tool name should not have to pull in
 * the prompt builder or the destructive tables with it.
 *
 * Five tools, and the shape of the list is the whole architecture: one seam to the
 * CTO thread, one way to stop it, two that answer a question ADE asked out
 * loud, and one that hangs up. Nothing else is on offer, because everything
 * else a call can do is something the CTO thread does with its own tools behind
 * `ask_cto`.
 */

/** The seam. Everything that needs the project goes through this one call. */
export const CTO_VOICE_TOOL_ASK_CTO = "ask_cto";
/** "Stop" / "never mind", while work is running. */
export const CTO_VOICE_TOOL_CANCEL_WORK = "cancel_work";
export const CTO_VOICE_TOOL_APPROVE = "approve_pending_action";
export const CTO_VOICE_TOOL_DENY = "deny_pending_action";
/**
 * "Goodbye" / "hang up" / "close yourself".
 *
 * Without it the model has no way to end the thing it is inside, and on the
 * call of 2026-09-16 it said so out loud — "I can't close myself from here" —
 * while the user waited for a call they had already ended in words.
 */
export const CTO_VOICE_TOOL_END_CALL = "end_call";

/**
 * What a second request means while the first one is still running.
 *
 * The decision is the model's, not a heuristic's, because the only thing that
 * can tell "no wait, I meant the merged ones" from "also, run the tests" is
 * whoever heard both sentences. A rule on this side would have to guess, and on
 * the live call of 2026-09-16 the guess ADE actually shipped — every new
 * request supersedes the running one — threw both requests away.
 *
 * `replace`: the new request corrects or updates the running one. The running
 * one is stopped and this one runs instead.
 * `queue`: the new request is an additional job. It runs when the current one
 * finishes.
 */
export const CTO_VOICE_ASK_MODES = ["replace", "queue"] as const;

export type CtoVoiceAskMode = (typeof CTO_VOICE_ASK_MODES)[number];

/**
 * The mode a request with no usable `mode` is treated as.
 *
 * `queue`, because it is the one that loses nothing: a queued request that
 * should have replaced runs a few seconds late, where a replace that should
 * have queued throws the running turn's work away.
 */
export const CTO_VOICE_ASK_MODE_DEFAULT: CtoVoiceAskMode = "queue";

export function normalizeCtoVoiceAskMode(value: unknown): CtoVoiceAskMode {
  return (CTO_VOICE_ASK_MODES as readonly string[]).includes(String(value))
    ? (value as CtoVoiceAskMode)
    : CTO_VOICE_ASK_MODE_DEFAULT;
}

/**
 * How many requests may wait behind the running one.
 *
 * Two, and the bound is the conversation's rather than the queue's: a user who
 * has stacked three jobs by voice has stopped listening to the answers, and a
 * queue deeper than the call is long answers questions nobody is still waiting
 * for. The third is refused out loud (`{ status: "busy" }`) so the user hears
 * it rather than discovering it in silence.
 */
export const CTO_VOICE_ASK_QUEUE_LIMIT = 2;

/**
 * The tools as the `session.update` carries them.
 *
 * Data rather than a literal inside the socket service, because the
 * descriptions are the only thing deciding when the model talks to the CTO and
 * when it answers for itself — which makes them worth reading, diffing and
 * testing in one place.
 */
export const CTO_VOICE_REALTIME_TOOLS = [
  {
    type: "function",
    name: CTO_VOICE_TOOL_ASK_CTO,
    description:
      "Ask the CTO to do real work, or to answer something you do not already know."
      + " Use this for anything that needs the project's code, files, git, lanes, pull"
      + " requests, tests, terminals, running a command, changing anything, or any fact"
      + " about the project that is not in the context you were given. Pass the user's"
      + " request in their own words, plus any clarification they gave. Never guess a"
      + " fact about the project — ask."
      + " If the user asked to see something — a visual, a chart, a diagram, a picture,"
      + " a list, or anything phrased as 'show me' — say so in the request: one picture"
      + " can be drawn beside the call, and the user is asking for it."
      + " `mode` decides what happens when a request is already running. Use"
      + " \"replace\" when this one corrects, changes or takes back the running one:"
      + " the running one is stopped and this one runs instead. Use \"queue\" when it"
      + " is an additional, separate job: it runs as soon as the current one is"
      + " finished. When nothing is running, `mode` changes nothing. Tell the user"
      + " which one you are doing in the same short sentence you acknowledge with —"
      + " \"I'll switch to that\" for replace, \"I'll do that right after\" for queue.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "The user's request, in their own words, plus any clarification.",
        },
        mode: {
          type: "string",
          enum: [...CTO_VOICE_ASK_MODES],
          description:
            "\"replace\" if this corrects or updates a request that is already running;"
            + " \"queue\" if it is an additional task to do afterwards.",
        },
      },
      required: ["request", "mode"],
    },
  },
  {
    type: "function",
    name: CTO_VOICE_TOOL_CANCEL_WORK,
    description:
      "Stop the work that is currently running, and drop anything waiting behind"
      + " it. Use this when the user says stop, never mind, cancel that, or otherwise"
      + " takes it back while work is in flight.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: CTO_VOICE_TOOL_APPROVE,
    description:
      "Approve the action ADE said it is waiting on. Use this ONLY when ADE has told"
      + " you it is waiting for the user's approval and the user has clearly said yes.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: CTO_VOICE_TOOL_DENY,
    description:
      "Decline the action ADE said it is waiting on. Use this ONLY when ADE has told"
      + " you it is waiting for the user's approval and the user has clearly said no.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: CTO_VOICE_TOOL_END_CALL,
    description:
      "Use when the user says goodbye, asks you to hang up, end the call, or close"
      + " yourself. Say a short goodbye in the same response.",
    parameters: { type: "object", properties: {} },
  },
] as const;
