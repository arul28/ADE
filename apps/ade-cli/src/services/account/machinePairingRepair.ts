import type {
  AccountMachinePairingRefusalCode,
  AccountMachinePairingResult,
} from "./accountMachinePublisherService";

/**
 * The two independent halves of "this machine was removed from your account".
 *
 * The account directory latches it in the machine publisher (heartbeats stop),
 * and the push relay latches it in the push publisher plus the durable
 * `machineRevokedAt` in push-relay.json (Activity, alerts, and badge updates
 * all stop, across restarts). Both are deliberately terminal: only a
 * user-initiated re-pair may lift them, because a timer that lifted them is
 * exactly what made an account removal non-durable.
 *
 * They must lift TOGETHER. A machine that cleared only the directory half is
 * back on the roster while delivering nothing — a silent liar, worse than a
 * machine that is plainly gone. So the push half is cleared only after the
 * directory has actually accepted the pairing publish.
 */

/** The push side of the removal, as this module needs to touch it. */
export type MachinePairingPushTarget = {
  getMachineRevocation(): { revoked: boolean; revokedAt: string | null };
  /** Clears the durable flag AND the live in-memory gate. */
  clearMachineRevocation(): void;
};

/**
 * Durable-only fallback for when no push publisher is running (no project scope
 * has booted one yet). Clearing the file alone is safe here precisely because
 * there is no live gate to disagree with it.
 */
export type MachinePairingPushStore = {
  isMachineRevoked(): boolean;
  clearMachineRevoked(): void;
};

export type MachinePairingDirectoryTarget = {
  getMachineRevocation(): { revoked: boolean; revokedAt: string | null };
  publishPairing(): Promise<AccountMachinePairingResult>;
};

export type MachinePairingRepairResult = {
  /** The directory accepted the re-pair and both halves were lifted. */
  repaired: boolean;
  /** Was anything actually gated before this call? */
  wasRevoked: boolean;
  /** Did the pairing publish reach the directory and get a 2xx? */
  published: boolean;
  /** Did the push half get lifted (delivery resumed without a restart)? */
  pushRestored: boolean;
  state:
    | AccountMachinePairingResult["state"]
    | "publisher_unavailable"
    | "not_revoked";
  reason: string | null;
  /**
   * Why the directory refused, machine-readable — the discriminator a UI should
   * branch on to decide whether a refusal is actionable.
   *
   * `machine_revoked` and `pairing_authentication_required` both arrive as
   * `state: "http_error"`, and only the second one has a fix the user can
   * perform (sign in again, then the re-pair completes). Without this field the
   * only difference between them is the sentence in `reason`, which is
   * user-facing copy: rewording it would quietly break the recovery path.
   *
   * OPTIONAL on purpose. It is absent whenever the refusal carried no code ADE
   * recognises, and absent entirely from brains that predate it, so readers
   * must treat "no code" as "unknown", never as "not this code".
   */
  reasonCode?: AccountMachinePairingRefusalCode;
};

export type MachinePairingRepairInput = {
  directory: MachinePairingDirectoryTarget | null;
  push?: MachinePairingPushTarget | null;
  /** Used only when no live push publisher exists. */
  pushStore?: MachinePairingPushStore | null;
  /**
   * Skip the pairing publish entirely when nothing is gated. Used by the
   * automatic sign-in recovery so a routine login does not send a deliberate
   * pairing registration on every sign-in; an explicit "reconnect this machine"
   * leaves it off and always re-pairs.
   */
  onlyIfRevoked?: boolean;
  logger?: {
    info?: (event: string, meta?: Record<string, unknown>) => void;
    warn?: (event: string, meta?: Record<string, unknown>) => void;
  } | null;
};

/**
 * Re-pair this machine into the signed-in ADE account and un-gate delivery.
 *
 * This is the ONLY product path back from an account-side machine removal —
 * without it a mis-click in Settings is permanent, since heartbeats always
 * publish `pairing: false`, sign-out/in reuses the same stable device id, and
 * a reinstall that keeps `~/.ade` keeps the durable revocation.
 *
 * Safe to call when nothing is revoked: it publishes one deliberate pairing
 * registration and reports `wasRevoked: false`.
 */
export async function repairMachinePairing(
  input: MachinePairingRepairInput,
): Promise<MachinePairingRepairResult> {
  const pushRevokedBefore = input.push
    ? input.push.getMachineRevocation().revoked
    : input.pushStore?.isMachineRevoked() === true;
  const directoryRevokedBefore = input.directory?.getMachineRevocation().revoked === true;
  const wasRevoked = pushRevokedBefore || directoryRevokedBefore;

  if (input.onlyIfRevoked && !wasRevoked) {
    return {
      repaired: false,
      wasRevoked: false,
      published: false,
      pushRestored: false,
      state: "not_revoked",
      reason: null,
    };
  }

  if (!input.directory) {
    input.logger?.warn?.("account.machine_repair_unavailable", { wasRevoked });
    return {
      repaired: false,
      wasRevoked,
      published: false,
      pushRestored: false,
      state: "publisher_unavailable",
      reason: "This ADE brain is not publishing this machine to your account yet.",
    };
  }

  const directoryResult = await input.directory.publishPairing();
  if (!directoryResult.published) {
    // Deliberately leave the push half latched: an unaccepted pairing means the
    // account still does not include this machine, and un-gating delivery here
    // would resurrect exactly the state the owner removed.
    input.logger?.warn?.("account.machine_repair_failed", {
      state: directoryResult.state,
      reasonCode: directoryResult.reasonCode ?? null,
      wasRevoked,
    });
    return {
      repaired: false,
      wasRevoked,
      published: false,
      pushRestored: false,
      state: directoryResult.state,
      reason: directoryResult.reason
        ?? "The account directory did not accept this machine.",
      // Forwarded verbatim, never derived from `reason`. Spread so the field
      // stays absent (not `undefined`) when the publisher had no code — an
      // older publisher must serialize exactly as it always did.
      ...(directoryResult.reasonCode
        ? { reasonCode: directoryResult.reasonCode }
        : {}),
    };
  }

  let pushRestored = false;
  if (input.push) {
    input.push.clearMachineRevocation();
    pushRestored = true;
  } else if (input.pushStore?.isMachineRevoked()) {
    input.pushStore.clearMachineRevoked();
    pushRestored = true;
  }

  input.logger?.info?.("account.machine_repaired", { wasRevoked, pushRestored });
  return {
    repaired: true,
    wasRevoked,
    published: true,
    pushRestored,
    state: directoryResult.state,
    reason: null,
  };
}
