// Pure derivations for the two failure classes that produced NO telemetry when
// a machine was revoked and its brain stopped working: brain action failures,
// and the account directory refusing to register this computer.
//
// They live here, apart from the IPC layer that emits them, because each one is
// a small privacy decision — what may be read off an error or a status snapshot,
// and what must be left behind — and those decisions are worth testing on their
// own. Nothing in this file captures; the caller owns the event vocabulary.

import { readAccountRefusalCode } from "../../../shared/accountMachineRefusal";
import { parseCodedErrorMessage } from "../../../shared/codedError";
import type { SyncRoleSnapshot } from "../../../shared/types";

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
 * The decode itself belongs to `readAccountRefusalCode`, which the brain's
 * auto-recovery loop reads too: what counts as a refusal must not differ
 * between the thing that repairs one and the thing that reports it. This
 * status snapshot is simply the only place the desktop can see a refusal — it
 * never talks to the directory itself.
 *
 * Everything that is not a refusal — a timeout, a 5xx, a transport failure, and
 * a 401, which is an authentication problem rather than the directory turning a
 * valid caller away — is left to `ade_publish_failing`, which the brain emits.
 */
export function machineRegisterRefusalCode(
  snapshot: SyncRoleSnapshot | null | undefined,
): string | null {
  const health = snapshot?.routeHealth?.accountDirectory;
  // A snapshot is a state, not an event: only `http_error` means the status
  // fields describe the attempt that is currently failing. Reporting a refusal
  // off any other state would date-stamp an old rejection as a new incident.
  if (!health || health.state !== "http_error") return null;
  return readAccountRefusalCode(health);
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
