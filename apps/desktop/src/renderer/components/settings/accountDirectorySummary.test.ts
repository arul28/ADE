import { describe, expect, it } from "vitest";
import type { SyncRoleSnapshot } from "../../../shared/types";
import { accountDirectorySummary } from "./accountDirectorySummary";

describe("accountDirectorySummary", () => {
  it("reflects whether signed-out nearby pairing has a configured code", () => {
    const status = { pairingPinConfigured: false } as SyncRoleSnapshot;

    expect(accountDirectorySummary(status, false)).toEqual({
      label: "Not signed in — set a pairing code so nearby devices can connect",
      healthy: false,
    });

    status.pairingPinConfigured = true;
    expect(accountDirectorySummary(status, false).label).toContain(
      "nearby devices can still connect with the pairing code",
    );
  });
});
