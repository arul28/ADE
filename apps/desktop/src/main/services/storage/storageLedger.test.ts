import { describe, expect, it } from "vitest";
import { ADE_LAYOUT_DEFINITIONS } from "../../../shared/adeLayout";
import {
  deriveCategoryPolicyChips,
  getLedgerEntry,
  LEDGER_LAYOUT_COVERAGE,
  STORAGE_LEDGER,
} from "./storageLedger";

describe("storageLedger", () => {
  it("declares a well-formed, unique policy for every entry", () => {
    const ids = new Set<string>();
    for (const entry of STORAGE_LEDGER) {
      expect(entry.id).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(["table", "directory", "file_family"]).toContain(entry.kind);
      expect(["user_data", "derived", "operational"]).toContain(entry.policyClass);
      expect(["write_time", "doctor", "both", "manual"]).toContain(entry.enforcement);
      // compressAfterDays only applies to user_data (spec §2 contract).
      if (entry.policy.compressAfterDays != null) {
        expect(entry.policyClass).toBe("user_data");
      }
    }
  });

  it("covers every §1 evidence table and the doctor's own artifacts", () => {
    for (const id of [
      "db.automation_ingress_events",
      "db.operations_crsql",
      "db.review_run_artifacts",
      "db.pull_request_snapshots",
      "fs.transcripts",
      "fs.tmp",
      "fs.recovery_backups",
      "fs.cache",
      "fs.storage_doctor_journal",
      "fs.artifacts",
      "fs.attachments",
    ]) {
      expect(getLedgerEntry(id), `missing ledger entry ${id}`).toBeDefined();
    }
  });

  it("declares a storage policy (or explicit unmanaged waiver) for every layout directory", () => {
    // CI guard: adding a new tracked directory to ADE_LAYOUT_DEFINITIONS without
    // declaring its storage policy here must fail. Either map it to a ledger id
    // or add it to LEDGER_LAYOUT_COVERAGE as intentionally unmanaged (null).
    const ledgerIds = new Set(STORAGE_LEDGER.map((entry) => entry.id));
    for (const definition of ADE_LAYOUT_DEFINITIONS) {
      if (definition.pathType !== "directory") continue;
      const declared = Object.prototype.hasOwnProperty.call(
        LEDGER_LAYOUT_COVERAGE,
        definition.relativePath,
      );
      expect(declared, `layout dir ${definition.relativePath} has no ledger coverage entry`).toBe(true);
      const ledgerId = LEDGER_LAYOUT_COVERAGE[definition.relativePath];
      if (ledgerId !== null && ledgerId !== undefined) {
        expect(ledgerIds.has(ledgerId), `coverage points at missing ledger id ${ledgerId}`).toBe(true);
      }
    }
  });

  it("derives category policy chips from the ledger policy values", () => {
    const chips = deriveCategoryPolicyChips();
    expect(chips.chats_history).toBe("Compressed after 14 days");
    expect(chips.build_release).toBe("Auto-cleans after 7 days");
    expect(chips.recovery_backups).toBe("Keeps the latest backup");
    expect(chips.caches).toBeTruthy();
    expect(chips.lanes_worktrees).toBeTruthy();
  });
});
