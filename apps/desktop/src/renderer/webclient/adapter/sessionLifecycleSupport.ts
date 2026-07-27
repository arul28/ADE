import type { SyncRemoteCommandDescriptor } from "../../../shared/types/sync";

/**
 * Whether the paired machine can do session lifecycle at all, and the copy the
 * web client uses when it can't.
 *
 * ADE Web talks to whatever ADE version the user happens to be running on their
 * Mac. Support is feature-detected exactly the way the phone does it — from the
 * `hello_ok.features.commandRouting.actions` list the host advertises, surfaced
 * by `AdeSyncClient.getCommandDescriptors()`. An older host simply does not
 * register the `session.*` namespace, and a command sent to an unknown action
 * resolves to the caller's fallback, i.e. a silent no-op. Gating on the
 * advertised list turns that into an honest, explainable refusal.
 */

/** Every remote command the Work tab's lifecycle controls can issue. */
export const SESSION_LIFECYCLE_ACTIONS = [
  "session.settleSession",
  "session.unsettleSession",
  "session.settleSessions",
  "session.unsettleSessions",
  "session.snoozeSession",
  "session.snoozeSessions",
  "session.wakeSession",
  "session.wakeSessions",
  "session.setSettleOverride",
  "session.clearWokeMarker",
] as const;

/**
 * The subset that must be present for the controls to be worth showing. A host
 * that can settle and snooze one row can drive every affordance on the row;
 * the bulk and marker commands degrade individually.
 */
const REQUIRED_ACTIONS = [
  "session.settleSession",
  "session.snoozeSession",
  "session.wakeSession",
] as const;

export const SESSION_LIFECYCLE_DISCONNECTED_MESSAGE =
  "Can't reach this Mac right now, so nothing was changed.";

export const SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE =
  "This Mac is running an older ADE that can't settle or snooze sessions.";

export type SessionLifecycleUnavailableCode = "disconnected" | "unsupported";

/**
 * Thrown instead of silently resolving, so the shared Work-tab action helpers
 * report a real failure and any optimistic patch rolls back visibly.
 */
export class SessionLifecycleUnavailableError extends Error {
  constructor(readonly code: SessionLifecycleUnavailableCode, message: string) {
    super(message);
    this.name = "SessionLifecycleUnavailableError";
  }

  static disconnected(): SessionLifecycleUnavailableError {
    return new SessionLifecycleUnavailableError("disconnected", SESSION_LIFECYCLE_DISCONNECTED_MESSAGE);
  }

  static unsupported(): SessionLifecycleUnavailableError {
    return new SessionLifecycleUnavailableError("unsupported", SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE);
  }
}

/** True when the host advertises enough of `session.*` to drive the controls. */
export function sessionLifecycleSupported(
  descriptors: readonly SyncRemoteCommandDescriptor[],
): boolean {
  if (descriptors.length === 0) return false;
  const advertised = new Set(descriptors.map((descriptor) => String(descriptor.action)));
  return REQUIRED_ACTIONS.every((action) => advertised.has(action));
}
