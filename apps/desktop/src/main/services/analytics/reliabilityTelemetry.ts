// Pure derivations for the two failure classes that produced NO telemetry when
// a machine was revoked and its brain stopped working: brain action failures,
// and the account directory refusing to register this computer.
//
// They live here, apart from the IPC layer that emits them, because each one is
// a small privacy decision — what may be read off an error or a status snapshot,
// and what must be left behind — and those decisions are worth testing on their
// own. Nothing in this file captures; the caller owns the event vocabulary.

import { parseCodedErrorMessage } from "../../../shared/codedError";
import type { SyncRoleSnapshot } from "../../../shared/types";

/**
 * The ADE action domain a failed `localRuntime.callAction` was addressed to.
 *
 * Read straight off the IPC argument the renderer already sent, so nothing new
 * has to be threaded through the runtime bridge. Returns null for a malformed
 * argument; the analytics policy re-checks the value against the closed domain
 * list anyway, so an unrecognised domain is dropped rather than reported.
 */
export function brainActionDomainFromIpcArgs(args: readonly unknown[]): string | null {
  const arg = args[0];
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) return null;
  const request = (arg as { request?: unknown }).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const domain = (request as { domain?: unknown }).domain;
  return typeof domain === "string" && domain.trim() ? domain.trim() : null;
}

/**
 * The structured code of a brain action failure, and NEVER its message.
 *
 * `parseCodedErrorMessage` prefers a real `Error.code` and otherwise reads the
 * `code:` prefix the RPC boundary encodes, so this is always a token the code
 * base authored — but the policy still revalidates the shape before it can leave
 * the machine, and a "code" that is really a sentence is dropped there.
 *
 * `unknown` is reported rather than dropped: how much of the failure surface is
 * still uncoded is itself part of the answer to "why did the last incident
 * produce nothing", and omitting it would hide that. A wrapper timeout gets its
 * own name because the brain never answered at all, so any code in scope would
 * belong to the timeout, not to the failure.
 */
export function brainActionErrorCode(error: unknown, didTimeout: boolean): string {
  if (didTimeout) return "ipc_timeout";
  const code = parseCodedErrorMessage(error).code;
  return code && code.trim() ? code.trim() : "unknown";
}

/**
 * Why the account directory refused to register THIS computer, as one of three
 * closed values — never the brain's user-facing sentence.
 *
 * Both refusals reach the desktop as `state: "http_error"` with the
 * machine-readable code in `lastHttpReason` (see the brain's
 * `accountMachinePublisherService`), and this status snapshot is the only place
 * the desktop can see them: it never talks to the directory itself. Any other
 * 401/403 is reported as `other`, because "the directory turned this machine
 * away for a reason this build has no name for" is still the fact the last
 * incident needed and could not get — while `lastHttpReason` on that path is
 * server-supplied prose and must not travel.
 *
 * Anything else — a timeout, a 5xx, a transport failure — is not a refusal, and
 * is left to `ade_publish_failing`, which the brain already emits.
 */
export function machineRegisterRefusalCode(
  snapshot: SyncRoleSnapshot | null | undefined,
): string | null {
  const health = snapshot?.routeHealth?.accountDirectory;
  if (!health || health.state !== "http_error") return null;
  if (health.lastHttpStatus !== 401 && health.lastHttpStatus !== 403) return null;
  const reason = typeof health.lastHttpReason === "string" ? health.lastHttpReason.trim() : "";
  return reason === "machine_revoked" || reason === "pairing_authentication_required"
    ? reason
    : "other";
}

/**
 * Turns the refusal STATE into refusal EVENTS.
 *
 * Connections and the app shell both poll the local sync status on a timer, and
 * a revoked machine stays revoked — so the state is read hundreds of times a day
 * and is a product fact exactly twice: when it starts, and when it changes into
 * a different refusal. Only the edge calls `onRefused`. Recovery clears the
 * latch, so a machine that is refused, repaired, and refused again reports both
 * episodes. The caller is still expected to dedupe, which is what bounds the
 * case this latch cannot see: a process that restarts inside a refusal.
 */
export function createMachineRegisterRefusalObserver(
  onRefused: (code: string) => void,
): (snapshot: SyncRoleSnapshot | null | undefined) => void {
  let lastCode: string | null = null;
  return (snapshot) => {
    let code: string | null = null;
    try {
      code = machineRegisterRefusalCode(snapshot);
    } catch {
      // A snapshot from an older or partially-populated brain must never fail
      // the status read the whole Connections surface depends on.
      return;
    }
    if (code === lastCode) return;
    lastCode = code;
    if (!code) return;
    try {
      onRefused(code);
    } catch {
      // Analytics is never worth failing a status read over.
    }
  };
}
