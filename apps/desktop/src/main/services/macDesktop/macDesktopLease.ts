/**
 * Who is allowed to post a real `CGEvent` on a lane's display, right now.
 *
 * Pure: no timers, no driver, no clock of its own. The service owns the side
 * effects (telling the driver, emitting `lease-changed`) and this file owns the
 * decision, so every refusal is testable without a window server.
 *
 * The lease is a deadline, never a durable flag. A remote viewer that
 * disconnects mid-takeover, or a Mac that sleeps with the lease held, must not
 * leave the lane permanently un-drivable — so nothing has to *notice* a
 * disconnect for control to come back. Expiry is evaluated on read
 * (`get(now)`), which is why callers never need a sweep timer to stay correct.
 */

import {
  MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
  MAC_DESKTOP_LEASE_TTL_MS,
  MAC_DESKTOP_USER_HAS_CONTROL_CODE,
  type MacDesktopErrorCode,
  type MacDesktopLeaseHolderKind,
  type MacDesktopLeaseState,
} from "../../../shared/types/macDesktop";

export type MacDesktopLeaseGrant = {
  laneId: string;
  holder: MacDesktopLeaseHolderKind;
  holderId: string;
  holderLabel?: string | null;
  /** Defaults to {@link MAC_DESKTOP_LEASE_TTL_MS}. */
  ttlMs?: number | null;
};

export type MacDesktopLeaseDecision =
  | { ok: true; lease: MacDesktopLeaseState }
  | { ok: false; code: MacDesktopErrorCode; lease: MacDesktopLeaseState | null; message: string };

type StoredLease = {
  laneId: string;
  holder: MacDesktopLeaseHolderKind;
  holderId: string;
  holderLabel: string | null;
  grantedAtMs: number;
  expiresAtMs: number;
  ttlMs: number;
};

const iso = (ms: number): string => new Date(ms).toISOString();

const toState = (lease: StoredLease): MacDesktopLeaseState => ({
  laneId: lease.laneId,
  holder: lease.holder,
  holderId: lease.holderId,
  holderLabel: lease.holderLabel,
  grantedAt: iso(lease.grantedAtMs),
  expiresAt: iso(lease.expiresAtMs),
});

const normalizeTtl = (ttlMs: number | null | undefined): number => {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return MAC_DESKTOP_LEASE_TTL_MS;
  return Math.round(ttlMs);
};

/**
 * One registry for every lane on the host.
 *
 * `now` is injected rather than read from `Date.now` so the tests can walk past
 * a TTL without sleeping, and so the service can feed it the same clock its
 * wall-clock-jump detector reads.
 */
export function createMacDesktopLeaseRegistry(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const leases = new Map<string, StoredLease>();
  /**
   * Chats that have already been granted real input once.
   *
   * The pending-input card is asked once per chat, for the chat's whole life —
   * so this is what makes the second `requestInputLease` from the same chat a
   * silent re-grant instead of a second card in the user's face.
   */
  const approvedChats = new Map<string, Set<string>>();

  const live = (laneId: string, atMs: number): StoredLease | null => {
    const lease = leases.get(laneId);
    if (!lease) return null;
    if (lease.expiresAtMs <= atMs) {
      leases.delete(laneId);
      return null;
    }
    return lease;
  };

  return {
    /** The lane's lease, or null when it has none or the last one lapsed. */
    get(laneId: string): MacDesktopLeaseState | null {
      const lease = live(laneId, now());
      return lease ? toState(lease) : null;
    },

    list(): MacDesktopLeaseState[] {
      const atMs = now();
      const out: MacDesktopLeaseState[] = [];
      for (const laneId of [...leases.keys()]) {
        const lease = live(laneId, atMs);
        if (lease) out.push(toState(lease));
      }
      return out;
    },

    /** True once the user has approved real input for this chat, ever. */
    isChatApproved(laneId: string, chatSessionId: string): boolean {
      return approvedChats.get(laneId)?.has(chatSessionId) ?? false;
    },

    /** Records the user's one-time approval for a chat. */
    approveChat(laneId: string, chatSessionId: string): void {
      const existing = approvedChats.get(laneId);
      if (existing) existing.add(chatSessionId);
      else approvedChats.set(laneId, new Set([chatSessionId]));
    },

    /**
     * Hands the lease to an agent chat.
     *
     * Refused while the user holds control — the agent is expected to wait
     * rather than fight the person at the keyboard — and refused while another
     * agent holds a live lease.
     */
    grantToAgent(args: MacDesktopLeaseGrant & { holder?: "agent" }): MacDesktopLeaseDecision {
      const atMs = now();
      const current = live(args.laneId, atMs);
      if (current && current.holderId !== args.holderId) {
        if (current.holder === "user") {
          return {
            ok: false,
            code: MAC_DESKTOP_USER_HAS_CONTROL_CODE,
            lease: toState(current),
            message: `${current.holderLabel ?? "Someone"} is driving this display right now. ADE will wait for control to come back.`,
          };
        }
        return {
          ok: false,
          code: MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
          lease: toState(current),
          message: `Another chat (${current.holderLabel ?? current.holderId}) holds real input on this display.`,
        };
      }
      const ttlMs = normalizeTtl(args.ttlMs);
      const lease: StoredLease = {
        laneId: args.laneId,
        holder: "agent",
        holderId: args.holderId,
        holderLabel: args.holderLabel?.trim() || null,
        grantedAtMs: current?.grantedAtMs ?? atMs,
        expiresAtMs: atMs + ttlMs,
        ttlMs,
      };
      leases.set(args.laneId, lease);
      return { ok: true, lease: toState(lease) };
    },

    /**
     * The human takes over.
     *
     * Always allowed, and it evicts an agent lease: the whole point of takeover
     * is that the person does not have to negotiate with a program. A second
     * takeover by a different controller is refused, because two people sharing
     * one pointer is not a state this can make true.
     */
    takeControl(args: {
      laneId: string;
      controllerId: string;
      controllerLabel?: string | null;
      ttlMs?: number | null;
    }): MacDesktopLeaseDecision {
      const atMs = now();
      const current = live(args.laneId, atMs);
      if (current && current.holder === "user" && current.holderId !== args.controllerId) {
        return {
          ok: false,
          code: MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
          lease: toState(current),
          message: `${current.holderLabel ?? "Another viewer"} already has control of this display.`,
        };
      }
      const ttlMs = normalizeTtl(args.ttlMs);
      const lease: StoredLease = {
        laneId: args.laneId,
        holder: "user",
        holderId: args.controllerId,
        holderLabel: args.controllerLabel?.trim() || "You",
        grantedAtMs: current?.holder === "user" ? current.grantedAtMs : atMs,
        expiresAtMs: atMs + ttlMs,
        ttlMs,
      };
      leases.set(args.laneId, lease);
      return { ok: true, lease: toState(lease) };
    },

    /**
     * Gives the lease back. Only the holder can: a stale client must not be
     * able to yank control out from under whoever holds it now.
     */
    returnControl(args: { laneId: string; controllerId: string }): {
      released: boolean;
      lease: MacDesktopLeaseState | null;
    } {
      const current = live(args.laneId, now());
      if (!current) return { released: false, lease: null };
      if (current.holderId !== args.controllerId) {
        return { released: false, lease: toState(current) };
      }
      leases.delete(args.laneId);
      return { released: true, lease: null };
    },

    /** Heartbeat. Only the holder renews, and only while the lease is alive. */
    renew(args: { laneId: string; holderId: string; ttlMs?: number | null }): MacDesktopLeaseState | null {
      const atMs = now();
      const current = live(args.laneId, atMs);
      if (!current || current.holderId !== args.holderId) return null;
      const ttlMs = normalizeTtl(args.ttlMs ?? current.ttlMs);
      const renewed: StoredLease = { ...current, ttlMs, expiresAtMs: atMs + ttlMs };
      leases.set(args.laneId, renewed);
      return toState(renewed);
    },

    /**
     * May this holder post a real event right now?
     *
     * Three distinct refusals, because the caller's next move differs: wait
     * (the user has it), give up (another chat has it), or ask (nobody has it
     * and this chat never got the card).
     */
    checkRealInput(args: { laneId: string; holderId: string }): MacDesktopLeaseDecision {
      const current = live(args.laneId, now());
      if (!current) {
        return {
          ok: false,
          code: "MAC_DESKTOP_INPUT_LEASE_REQUIRED",
          lease: null,
          message: "Real pointer and keyboard input needs the user's permission on this display.",
        };
      }
      if (current.holderId !== args.holderId) {
        return current.holder === "user"
          ? {
            ok: false,
            code: MAC_DESKTOP_USER_HAS_CONTROL_CODE,
            lease: toState(current),
            message: `${current.holderLabel ?? "Someone"} is driving this display right now. ADE will wait for control to come back.`,
          }
          : {
            ok: false,
            code: MAC_DESKTOP_LEASE_HELD_BY_OTHER_CODE,
            lease: toState(current),
            message: `Another chat (${current.holderLabel ?? current.holderId}) holds real input on this display.`,
          };
      }
      return { ok: true, lease: toState(current) };
    },

    /** Drops one holder's lease wherever it is held. Used when a chat ends. */
    releaseHolder(holderId: string): MacDesktopLeaseState[] {
      const dropped: MacDesktopLeaseState[] = [];
      for (const [laneId, lease] of [...leases]) {
        if (lease.holderId !== holderId) continue;
        leases.delete(laneId);
        dropped.push(toState(lease));
      }
      for (const [laneId, chats] of [...approvedChats]) {
        if (!chats.delete(holderId)) continue;
        if (chats.size === 0) approvedChats.delete(laneId);
      }
      return dropped;
    },

    /** Drops everything for a lane whose display is going away. */
    releaseLane(laneId: string): boolean {
      approvedChats.delete(laneId);
      return leases.delete(laneId);
    },

    /**
     * Drops every lease. The service calls this on a coarse wall-clock jump —
     * the daemon's stand-in for `powerMonitor`'s sleep signal, which is
     * Electron-only and therefore absent where this service actually runs.
     */
    releaseAll(): MacDesktopLeaseState[] {
      const dropped = [...leases.values()].map(toState);
      leases.clear();
      return dropped;
    },

    /** Prunes lapsed entries. Only useful to keep the map small. */
    sweep(): MacDesktopLeaseState[] {
      const atMs = now();
      const expired: MacDesktopLeaseState[] = [];
      for (const [laneId, lease] of [...leases]) {
        if (lease.expiresAtMs > atMs) continue;
        leases.delete(laneId);
        expired.push(toState(lease));
      }
      return expired;
    },
  };
}

export type MacDesktopLeaseRegistry = ReturnType<typeof createMacDesktopLeaseRegistry>;
