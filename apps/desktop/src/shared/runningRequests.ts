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

/**
 * How long sending a request of `chars` may take before the other end has all
 * of it: 16 KB/s, about 128 kbit/s, is a slow satellite uplink. A check sent
 * on the same connection queues behind the request, so a large one (a pasted
 * picture in one call) is not asked about before it can have arrived. Below
 * 256 KB (16 s at that rate) it fits in any budget, and a budget stays exact.
 */
export function requestDeliveryAllowanceMs(chars: number): number {
  return chars > 256 * 1024 ? Math.ceil(chars / 16) : 0;
}

/** After the first check, how often a call past its budget is asked about again. */
export const RUNNING_REQUEST_RECHECK_MS = 15_000;

/**
 * The most a call waits past its own budget while the brain says it still runs
 * it. A call can deadlock on the other side; this is the bound on that, not a
 * guess at how long real work takes.
 */
export const RUNNING_REQUEST_MAX_EXTENSION_MS = 30 * 60_000;

/**
 * Why a call stopped waiting when the brain said it was not running it
 * (`mayStillBeRunning` in `runtimeErrors.ts` reads it).
 */
export const RUNNING_REQUEST_NOT_RUNNING_REASON = "it stopped working on it without an answer";

export type RequestStatusParams = { ids: Array<string | number> };
export type RequestStatusReply = { running: Array<string | number> };

/** The most ids one `ade/requests/status` is answered for; a client asks in groups this size. */
export const MAX_REQUEST_STATUS_IDS = 1_000;

/** The ids an `ade/requests/status` request asks about (server side). */
export function readRequestStatusIds(params: unknown): unknown[] {
  const ids = params && typeof params === "object" ? (params as { ids?: unknown }).ids : undefined;
  return Array.isArray(ids) ? ids.slice(0, MAX_REQUEST_STATUS_IDS) : [];
}

/** The ids an `ade/requests/status` answer lists, or null when it is not one. */
export function readRunningRequestIds(value: unknown): Set<string | number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const running = (value as { running?: unknown }).running;
  if (!Array.isArray(running)) return null;
  return new Set(running.filter((id): id is string | number => typeof id === "string" || typeof id === "number"));
}
