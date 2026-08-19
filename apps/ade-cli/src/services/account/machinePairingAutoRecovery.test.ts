import { describe, expect, it, vi } from "vitest";
import { createSyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types";
import type { SyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types";
import {
  createMachinePairingAutoRecovery,
  PAIRING_AUTO_REPAIR_DELAYS_MS,
  PAIRING_AUTO_REPAIR_REVOCATION_QUIET_MS,
  PAIRING_AUTO_REPAIR_SNAPSHOT_GRACE_MS,
  type MachinePairingAutoRecoveryPublisher,
} from "./machinePairingAutoRecovery";
import type { MachinePairingRepairResult } from "./machinePairingRepair";

const REFUSED_HEALTH = (
  code: "machine_revoked" | "pairing_authentication_required",
): SyncAccountDirectoryHealth =>
  createSyncAccountDirectoryHealth("http_error", "This machine was removed from your ADE account.", {
    lastHttpStatus: 403,
    lastHttpReason: code,
    lastAttemptAt: 1_000,
    failingSinceMs: 1_000,
  });

const REPAIR_FAILED: MachinePairingRepairResult = {
  repaired: false,
  wasRevoked: true,
  published: false,
  pushRestored: false,
  state: "http_error",
  reason: "The account directory did not accept this machine.",
  reasonCode: "machine_revoked",
};

const REPAIR_OK: MachinePairingRepairResult = {
  repaired: true,
  wasRevoked: true,
  published: true,
  pushRestored: true,
  state: "published",
  reason: null,
};

function harness(options: {
  health: () => SyncAccountDirectoryHealth;
  revoked: () => boolean;
  /** ISO removal timestamp, as the directory reports it. Absent by default. */
  revokedAt?: () => string | null;
  repair: () => Promise<MachinePairingRepairResult>;
  hasAccountSession?: () => boolean;
  budgetLimit?: number;
  now: () => number;
}) {
  let spent = 0;
  const limit = options.budgetLimit ?? 3;
  const publisher: MachinePairingAutoRecoveryPublisher = {
    getPublisherHealth: options.health,
    getMachineRevocation: () => ({
      revoked: options.revoked(),
      revokedAt: options.revokedAt?.() ?? null,
    }),
  };
  const recovery = createMachinePairingAutoRecovery({
    getPublisher: () => publisher,
    runRepair: options.repair,
    hasAccountSession: options.hasAccountSession ?? (() => true),
    budget: {
      tryConsumePairingAutoRepair: () => {
        if (spent >= limit) return { allowed: false, countInWindow: spent, limit };
        spent += 1;
        return { allowed: true, countInWindow: spent, limit };
      },
    },
    now: options.now,
  });
  return { recovery, spentRepairs: () => spent };
}

describe("machinePairingAutoRecovery", () => {
  it("repairs a machine_revoked refusal without any user action", async () => {
    let clock = 0;
    let revoked = true;
    const repair = vi.fn(async () => {
      revoked = false;
      return REPAIR_OK;
    });
    const { recovery } = harness({
      health: () => revoked ? REFUSED_HEALTH("machine_revoked") : createSyncAccountDirectoryHealth("published", null),
      revoked: () => revoked,
      repair,
      now: () => clock,
    });

    // First tick only opens the episode; the repair is deliberately delayed.
    await recovery.tick();
    expect(repair).not.toHaveBeenCalled();
    expect(recovery.getState().trigger).toBe("refusal");

    await recovery.tick();
    expect(repair).not.toHaveBeenCalled();

    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(recovery.getState().trigger).toBe(null);
  });

  it("acts on pairing_authentication_required too, and backs off between attempts", async () => {
    let clock = 0;
    const repair = vi.fn(async () => REPAIR_FAILED);
    const { recovery } = harness({
      health: () => REFUSED_HEALTH("pairing_authentication_required"),
      revoked: () => true,
      repair,
      now: () => clock,
    });

    await recovery.tick();
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);

    // Still inside the second delay: nothing more may be sent.
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[1] - 1;
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);

    clock += 1;
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it("never spends more than the persisted budget allows", async () => {
    let clock = 0;
    const repair = vi.fn(async () => REPAIR_FAILED);
    const { recovery, spentRepairs } = harness({
      health: () => REFUSED_HEALTH("machine_revoked"),
      revoked: () => true,
      repair,
      budgetLimit: 3,
      now: () => clock,
    });

    await recovery.tick();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      clock += 24 * 60 * 60 * 1_000;
      await recovery.tick();
    }

    expect(repair).toHaveBeenCalledTimes(3);
    expect(spentRepairs()).toBe(3);
    expect(recovery.getState().settled).toBe(true);
  });

  it("waits for a signed-in session instead of burning the budget proving there is none", async () => {
    let clock = 0;
    let signedIn = false;
    const repair = vi.fn(async () => REPAIR_OK);
    const { recovery, spentRepairs } = harness({
      health: () => REFUSED_HEALTH("machine_revoked"),
      revoked: () => true,
      repair,
      hasAccountSession: () => signedIn,
      now: () => clock,
    });

    await recovery.tick();
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).not.toHaveBeenCalled();
    expect(spentRepairs()).toBe(0);

    signedIn = true;
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("runs exactly one repair cycle for a long snapshot_failed episode", async () => {
    let clock = PAIRING_AUTO_REPAIR_SNAPSHOT_GRACE_MS * 10;
    const repair = vi.fn(async () => REPAIR_FAILED);
    const { recovery } = harness({
      health: () => createSyncAccountDirectoryHealth(
        "snapshot_failed",
        "The active sync snapshot could not be read.",
        { failingSinceMs: 0, lastAttemptAt: 0 },
      ),
      revoked: () => false,
      repair,
      now: () => clock,
    });

    await recovery.tick();
    expect(recovery.getState().trigger).toBe("snapshot_failed");
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);

    // A publish leg that cannot read a snapshot is not a pairing problem;
    // repeating the request would only settle into the same failing banner.
    clock += 24 * 60 * 60 * 1_000;
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(recovery.getState().settled).toBe(true);
  });

  it("ignores a snapshot failure that has not outlasted the grace window", async () => {
    let clock = PAIRING_AUTO_REPAIR_SNAPSHOT_GRACE_MS - 1;
    const repair = vi.fn(async () => REPAIR_OK);
    const { recovery } = harness({
      health: () => createSyncAccountDirectoryHealth("snapshot_failed", null, {
        failingSinceMs: 0,
      }),
      revoked: () => false,
      repair,
      now: () => clock,
    });

    await recovery.tick();
    expect(recovery.getState().trigger).toBe(null);
    clock += 1;
    await recovery.tick();
    expect(recovery.getState().trigger).toBe("snapshot_failed");
  });

  it("leaves a removal the user just performed alone", async () => {
    // The user clicked "Remove this computer" seconds ago, while the sign-in
    // that authorised it is still fresh enough for the directory to accept a
    // re-registration. This is the ONE case where an auto-repair would win the
    // argument, and it is the one case where it must not have it.
    const revokedAt = "2026-08-18T12:00:00.000Z";
    let clock = Date.parse(revokedAt) + 1_000;
    const repair = vi.fn(async () => REPAIR_OK);
    const { recovery, spentRepairs } = harness({
      health: () => REFUSED_HEALTH("machine_revoked"),
      revoked: () => true,
      revokedAt: () => revokedAt,
      repair,
      now: () => clock,
    });

    // No episode even opens, so nothing is scheduled and nothing is spent.
    await recovery.tick();
    expect(recovery.getState().trigger).toBe(null);
    clock += PAIRING_AUTO_REPAIR_REVOCATION_QUIET_MS - 2_000;
    await recovery.tick();
    await recovery.tick();
    expect(repair).not.toHaveBeenCalled();
    expect(spentRepairs()).toBe(0);
    expect(recovery.getState().trigger).toBe(null);
  });

  it("starts an episode once the removal has aged past the quiet window", async () => {
    const revokedAt = "2026-08-18T12:00:00.000Z";
    let clock = Date.parse(revokedAt) + PAIRING_AUTO_REPAIR_REVOCATION_QUIET_MS;
    const repair = vi.fn(async () => REPAIR_FAILED);
    const { recovery } = harness({
      health: () => REFUSED_HEALTH("machine_revoked"),
      revoked: () => true,
      revokedAt: () => revokedAt,
      repair,
      now: () => clock,
    });

    await recovery.tick();
    expect(recovery.getState().trigger).toBe("refusal");
    clock += PAIRING_AUTO_REPAIR_DELAYS_MS[0];
    await recovery.tick();
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("pins the quiet window to the directory's pairing-auth freshness bound", () => {
    // `PAIRING_AUTH_FRESHNESS_MS` in apps/account-directory/src/callerToken.ts.
    // The worker builds separately, so this value is duplicated rather than
    // imported; this assertion is what keeps the duplicate honest.
    expect(PAIRING_AUTO_REPAIR_REVOCATION_QUIET_MS).toBe(10 * 60_000);
  });

  it("leaves an unrecognised 403 alone", async () => {
    let clock = 0;
    const repair = vi.fn(async () => REPAIR_OK);
    const { recovery } = harness({
      health: () => createSyncAccountDirectoryHealth("http_error", "Forbidden by a proxy.", {
        lastHttpStatus: 403,
        lastHttpReason: "Forbidden by a proxy.",
        failingSinceMs: 0,
      }),
      revoked: () => true,
      repair,
      now: () => clock,
    });

    await recovery.tick();
    clock += 24 * 60 * 60 * 1_000;
    await recovery.tick();
    expect(repair).not.toHaveBeenCalled();
    expect(recovery.getState().trigger).toBe(null);
  });
});
