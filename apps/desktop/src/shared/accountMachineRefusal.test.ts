import { describe, expect, it } from "vitest";
import { readAccountRefusalCode } from "./accountMachineRefusal";
import { createSyncAccountDirectoryHealth } from "./types/sync";

describe("readAccountRefusalCode", () => {
  it("decodes the named refusal codes off a live 403", () => {
    expect(readAccountRefusalCode(createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 403,
      lastHttpReason: "machine_revoked",
    }))).toBe("machine_revoked");
    expect(readAccountRefusalCode(createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 403,
      lastHttpReason: "pairing_authentication_required",
    }))).toBe("pairing_authentication_required");
  });

  it("reports an unrecognised 403 as `other` without leaking the prose", () => {
    expect(readAccountRefusalCode(createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 403,
      lastHttpReason: "your seat expired on 2026-08-18, contact ada@example.com",
    }))).toBe("other");
  });

  it("is not a refusal for a 401, a 5xx, or no health at all", () => {
    // A 401 is an authentication problem with a different repair; counting it
    // as a register refusal mis-attributes the incident and hides the real one.
    expect(readAccountRefusalCode(createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 401,
      lastHttpReason: "machine_revoked",
    }))).toBeNull();
    expect(readAccountRefusalCode(createSyncAccountDirectoryHealth("http_error", null, {
      lastHttpStatus: 503,
    }))).toBeNull();
    expect(readAccountRefusalCode(null)).toBeNull();
    expect(readAccountRefusalCode(undefined)).toBeNull();
  });

  it("ignores stale 403 refusal reasons outside http_error", () => {
    // Health is a STATE. Once the publisher moves on to a transport or token
    // failure, a 403 still sitting in the status fields describes an attempt
    // that is no longer the reason this machine is unpublished — and the CLI's
    // pairing-recovery loop reads this decoder directly, so a stale read there
    // spends real repair budget arguing with nothing.
    for (const state of ["token_timeout", "transport_error", "timeout", "published"] as const) {
      expect(readAccountRefusalCode(createSyncAccountDirectoryHealth(state, null, {
        lastHttpStatus: 403,
        lastHttpReason: "machine_revoked",
      }))).toBeNull();
    }
  });
});
