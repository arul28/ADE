/**
 * A call that outlives its budget is asked about, not given up on.
 *
 * Every budget on a runtime call is a guess made before the call starts. When
 * the guess was short (a cleanup on a large project, a slow disk), the window
 * reported "timed out" while the brain kept working to a successful finish,
 * and each such report ended with one more row in a table of longer budgets.
 *
 * Instead, a call sent with `waitWhileRunning` asks the brain when its budget
 * runs out: `ade/requests/status` with the request ids, answered by the
 * JSON-RPC server itself from the requests it has not answered yet on that
 * same connection (`apps/ade-cli/src/jsonrpc.ts`). The server writes a reply
 * before it forgets the request, and one connection delivers in order, so an
 * id missing from the answer means the reply is not coming. The caller keeps
 * waiting while the id is listed, gives up when it is not, and stops for good
 * at `RUNNING_REQUEST_MAX_EXTENSION_MS` past the budget so a call that hangs
 * on the other side still ends. A check with no answer at all (a machine gone
 * to sleep, a dropped link) fails the call as the plain timeout did.
 *
 * Local socket, SSH and paired-relay connections all reach that server with
 * their request ids unchanged, so the same check works for any machine.
 */

export const REQUEST_STATUS_METHOD = "ade/requests/status";

/** After the first check, how often a call past its budget is asked about again. */
export const RUNNING_REQUEST_RECHECK_MS = 15_000;

/**
 * The most a call waits past its own budget while the brain says it still runs
 * it. A call can deadlock on the other side; this is the bound on that, not a
 * guess at how long real work takes.
 */
export const RUNNING_REQUEST_MAX_EXTENSION_MS = 30 * 60_000;

export type RequestStatusParams = { ids: Array<string | number> };
export type RequestStatusReply = { running: Array<string | number> };

/** The ids an `ade/requests/status` answer lists, or null when it is not one. */
export function readRunningRequestIds(value: unknown): Set<string | number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const running = (value as { running?: unknown }).running;
  if (!Array.isArray(running)) return null;
  return new Set(running.filter((id): id is string | number => typeof id === "string" || typeof id === "number"));
}
