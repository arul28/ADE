/**
 * The Windows-only parts of the lane-screen service: the interactive operation
 * record every pane reads (setup, saving the password, starting the private
 * screen), the shared seat's per-host lease, and the window-verb gate.
 *
 * Built by `createMacDesktopService` the way the lease flow is: the registries
 * and the gates are passed in, and the service keeps the API surface.
 */

import {
  MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
  MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
  type MacDesktopEventPayload,
  type MacDesktopLeaseState,
  type WindowsDesktopOperation,
  type WindowsDesktopOperationKind,
  type WindowsDesktopOperationResult,
  type WindowsDesktopStatus,
} from "../../../shared/types/macDesktop";
import type { MacDesktopLeaseRegistry } from "../macDesktop/macDesktopLease";
import { MAC_DESKTOP_ANONYMOUS_HOLDER_ID } from "../macDesktop/macDesktopLeaseFlow";
import type { MacDesktopOwnershipRegistry } from "../macDesktop/macDesktopOwnership";

export type WindowsDesktopOperationsDeps = {
  /** The seat host. The window verbs and the shared lease are Windows-only. */
  platform: NodeJS.Platform;
  assertSupported: () => void;
  serviceError: (code: string, message: string) => Error;
  emit: (payload: MacDesktopEventPayload) => void;
  /** The last real `windows.status`, which every published status is built on. */
  lastStatus: () => WindowsDesktopStatus | null;
  ownership: MacDesktopOwnershipRegistry;
  leases: MacDesktopLeaseRegistry;
  pushLease: (laneId: string, lease: MacDesktopLeaseState | null) => Promise<void>;
};

export function createWindowsDesktopOperations(deps: WindowsDesktopOperationsDeps) {
  /**
   * The interactive Windows operation running now, and how the last one ended.
   *
   * Carried on every Windows status so a pane closed and reopened mid-sign-in
   * shows the same progress (and, after, the same outcome) instead of an empty
   * card and a second request. In memory only: a restarted brain has no
   * operation to report.
   */
  let operation: WindowsDesktopOperation | null = null;
  let lastOperation: WindowsDesktopOperationResult | null = null;

  const withOperation = (status: WindowsDesktopStatus | null): WindowsDesktopStatus | null => (
    status ? { ...status, operation, lastOperation } : status
  );

  /** Tells every pane the operation state moved, from the last real status. */
  const publish = (): void => {
    const merged = withOperation(deps.lastStatus());
    if (merged) deps.emit({ type: "windows-desktop-changed", status: merged });
  };

  return {
    withOperation,

    /**
     * Runs one interactive Windows operation with its progress and outcome on
     * the status. Nested calls (a takeover's start) keep the outer record.
     */
    async run<T>(kind: WindowsDesktopOperationKind, laneId: string | null, work: () => Promise<T>): Promise<T> {
      if (operation) return await work();
      const current: WindowsDesktopOperation = { kind, laneId, startedAt: new Date().toISOString() };
      operation = current;
      lastOperation = null;
      publish();
      try {
        const result = await work();
        lastOperation = { ...current, outcome: "succeeded", endedAt: new Date().toISOString(), error: null };
        return result;
      } catch (error) {
        lastOperation = {
          ...current,
          outcome: "failed",
          endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      } finally {
        operation = null;
        publish();
      }
    },

    /**
     * Windows shared seat: the acting chat takes the lane's lease on the
     * strength of the user's shared-seat consent. Two shared lanes drive one
     * main desktop, one pointer and one foreground, so a live lease on any other
     * shared lane refuses this one until it lapses.
     *
     * The consent was given in a chat of this lane, so a caller with no chat
     * (the anonymous holder) is refused rather than riding on it.
     */
    async takeSharedSeatLease(laneId: string, holderId: string): Promise<void> {
      if (holderId === MAC_DESKTOP_ANONYMOUS_HOLDER_ID) {
        throw deps.serviceError(
          MAC_DESKTOP_INPUT_LEASE_REQUIRED_CODE,
          "This call has no chat, so it cannot act on the user's main Windows desktop. The user's consent covers the chats of this lane only.",
        );
      }
      for (const other of deps.ownership.listDisplays()) {
        if (other.laneId === laneId || other.seatMode !== "shared") continue;
        const otherLease = deps.leases.get(other.laneId);
        if (!otherLease) continue;
        const name = deps.ownership.laneName(other.laneId) ?? other.laneId;
        throw deps.serviceError(
          MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
          `Lane ${name} is driving the main Windows desktop right now (until ${otherLease.expiresAt} unless it keeps acting). Wait and retry; two lanes cannot drive the user's one pointer at once.`,
        );
      }
      const current = deps.leases.get(laneId);
      // A person who took control, or another chat, keeps it; the check after
      // this call refuses with the right code.
      if (current && current.holderId !== holderId) return;
      const decision = deps.leases.grantToAgent({ laneId, holder: "agent", holderId, holderLabel: null });
      if (!decision.ok) return;
      await deps.pushLease(laneId, decision.lease);
      if (!current) deps.emit({ type: "lease-changed", laneId, lease: decision.lease });
    },

    /** focus/minimize/close are Windows-only: the Mac helper has no such op. */
    assertWindowVerbsSupported(verb: string): void {
      deps.assertSupported();
      if (deps.platform !== "win32") {
        throw deps.serviceError(
          "MAC_DESKTOP_UNSUPPORTED_PLATFORM",
          `\`ade screen ${verb}\` is Windows-only; this Mac's screen driver has no window ${verb}. Use \`ade screen release\` or \`ade screen quit\` for a lane app instead.`,
        );
      }
    },
  };
}

export type WindowsDesktopOperations = ReturnType<typeof createWindowsDesktopOperations>;
