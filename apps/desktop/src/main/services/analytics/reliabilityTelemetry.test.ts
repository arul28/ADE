import { describe, expect, it, vi } from "vitest";
import { createSyncAccountDirectoryHealth } from "../../../shared/types";
import type { SyncAccountDirectoryHealth, SyncRoleSnapshot } from "../../../shared/types";
import { sanitizeProductAnalyticsProperties } from "./productAnalyticsPolicy";
import {
  brainActionErrorCode,
  createMachineRegisterRefusalObserver,
  machineRegisterRefusalCode,
} from "./reliabilityTelemetry";

/** Only `routeHealth.accountDirectory` is read, so nothing else is built. */
function snapshotWith(health: SyncAccountDirectoryHealth): SyncRoleSnapshot {
  return { routeHealth: { accountDirectory: health } } as unknown as SyncRoleSnapshot;
}

const refused = (
  status: number | null,
  reason: string | null,
): SyncRoleSnapshot => snapshotWith(createSyncAccountDirectoryHealth("http_error", null, {
  lastHttpStatus: status,
  lastHttpReason: reason,
}));

describe("brainActionErrorCode", () => {
  it("takes the code the brain attached and leaves the message behind", () => {
    const error = Object.assign(
      new Error("could not read /Users/alice/secret-project/.ade/ade.db"),
      { code: "storage_read_failed" },
    );
    expect(brainActionErrorCode(error, false)).toBe("storage_read_failed");
  });

  it("reads the code back out of the wrapped RPC message", () => {
    // What actually arrives at the desktop: the runtime RPC wrapper, then
    // Electron's own, around a message the brain prefixed with its code.
    const wrapped = new Error(
      "Error invoking remote method 'ade.localRuntime.callAction': "
      + "Error: Remote ADE service method actions/call failed (code -32000): "
      + "storage_read_failed: ADE could not open the project data store.",
    );
    expect(brainActionErrorCode(wrapped, false)).toBe("storage_read_failed");
  });

  it("names a wrapper timeout instead of borrowing an unrelated code", () => {
    expect(brainActionErrorCode(new Error("timed out after 30000ms"), true)).toBe("ipc_timeout");
  });

  it("says the failure was uncoded rather than dropping it", () => {
    expect(brainActionErrorCode(new Error("Session 'chat-stale' was not found."), false))
      .toBe("unknown");
    expect(brainActionErrorCode(null, false)).toBe("unknown");
  });

  it("keeps a platform errno as a code instead of costing the event", () => {
    // An unmapped errno — EDEADLK is the one a cloud-evicted file answers with
    // on macOS — is exactly the failure nobody predicted, which is what
    // `error_code` is collected for. The policy lower-cases before it shape-
    // checks, so the uppercase form is normalized rather than refused; and a
    // property it did refuse would be stripped from an event that still lands,
    // never drop the event.
    const evicted = Object.assign(
      new Error("Unknown system error -11: Unknown system error -11, read"),
      { code: "EDEADLK" },
    );
    expect(brainActionErrorCode(evicted, false)).toBe("EDEADLK");
    expect(sanitizeProductAnalyticsProperties("ade_brain_action_failed", {
      action_domain: "lane",
      error_code: brainActionErrorCode(evicted, false),
    })).toEqual({ action_domain: "lane", error_code: "edeadlk" });
  });

  it("never returns anything the policy would accept as a message", () => {
    // The load-bearing privacy property: whatever this returns, the policy only
    // lets a lower-case identifier through, so a message that slipped past the
    // parser still cannot reach PostHog.
    const leaky = new Error("Local runtime project is not available for this window.");
    const properties = sanitizeProductAnalyticsProperties("ade_brain_action_failed", {
      error_code: brainActionErrorCode(leaky, false),
    });
    expect(properties).toEqual({ error_code: "unknown" });
    expect(sanitizeProductAnalyticsProperties("ade_brain_action_failed", {
      error_code: "could not open /Users/alice/secret.db",
    })).toEqual({});
  });
});

describe("machineRegisterRefusalCode", () => {
  it("recognises both refusals the directory names", () => {
    expect(machineRegisterRefusalCode(refused(403, "machine_revoked"))).toBe("machine_revoked");
    expect(machineRegisterRefusalCode(refused(403, "pairing_authentication_required")))
      .toBe("pairing_authentication_required");
  });

  it("is not fooled by a 401, which is an auth failure and not a refusal", () => {
    // The directory answers a register refusal with 403. A 401 means the token
    // this machine presented was not accepted — a different failure with a
    // different repair, which `ade_publish_failing` already carries.
    expect(machineRegisterRefusalCode(refused(401, "pairing_authentication_required")))
      .toBeNull();
    expect(machineRegisterRefusalCode(refused(401, "token expired"))).toBeNull();
  });

  it("reports an unnamed refusal as `other` instead of the server's prose", () => {
    const code = machineRegisterRefusalCode(
      refused(403, "your account is over its machine limit, contact support@example.test"),
    );
    expect(code).toBe("other");
  });

  it("is silent for everything that is not a refusal", () => {
    expect(machineRegisterRefusalCode(refused(500, "machine_revoked"))).toBeNull();
    expect(machineRegisterRefusalCode(refused(null, null))).toBeNull();
    expect(machineRegisterRefusalCode(
      snapshotWith(createSyncAccountDirectoryHealth("published", null)),
    )).toBeNull();
    expect(machineRegisterRefusalCode(
      snapshotWith(createSyncAccountDirectoryHealth("token_timeout", null, { lastHttpStatus: 403 })),
    )).toBeNull();
    expect(machineRegisterRefusalCode(null)).toBeNull();
    expect(machineRegisterRefusalCode({} as SyncRoleSnapshot)).toBeNull();
  });
});

describe("createMachineRegisterRefusalObserver", () => {
  it("reports the edge into a refusal, not every poll tick", () => {
    const onRefused = vi.fn();
    const observe = createMachineRegisterRefusalObserver(onRefused);
    const revoked = refused(403, "machine_revoked");

    for (let tick = 0; tick < 200; tick += 1) observe(revoked);

    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith("machine_revoked");
  });

  it("reports a refusal that changes into a different one", () => {
    const onRefused = vi.fn();
    const observe = createMachineRegisterRefusalObserver(onRefused);

    observe(refused(403, "pairing_authentication_required"));
    observe(refused(403, "machine_revoked"));

    expect(onRefused.mock.calls.map(([code]) => code))
      .toEqual(["pairing_authentication_required", "machine_revoked"]);
  });

  it("re-arms after a recovery so a second episode still reports", () => {
    const onRefused = vi.fn();
    const observe = createMachineRegisterRefusalObserver(onRefused);
    const revoked = refused(403, "machine_revoked");

    observe(revoked);
    observe(snapshotWith(createSyncAccountDirectoryHealth("published", null)));
    observe(revoked);

    expect(onRefused).toHaveBeenCalledTimes(2);
  });

  it("never lets telemetry break the status read", () => {
    const observe = createMachineRegisterRefusalObserver(() => {
      throw new Error("analytics state file is unwritable");
    });
    expect(() => observe(refused(403, "machine_revoked"))).not.toThrow();
  });
});
