import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MacosVmRecord } from "../../../shared/types";
import {
  parseGlobalLease,
  readGlobalLeaseFile,
  readStoreFile,
  readVncCredentialStore,
  vncCredentialKey,
  writeGlobalLeaseFile,
  writeStoreFile,
  writeVncCredentialStore,
} from "./macosVmStores";

describe("macosVmStores", () => {
  it("round-trips VM records and drops malformed records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-vm-store-"));
    try {
      const storePath = path.join(dir, "records.json");
      writeStoreFile(storePath, {
        version: 1,
        records: [{ id: "record-1" } as MacosVmRecord],
      });

      expect(readStoreFile(storePath).records.map((record) => record.id)).toEqual(["record-1"]);

      fs.writeFileSync(storePath, JSON.stringify({ version: 1, records: [{ nope: true }, { id: "record-2" }] }));
      expect(readStoreFile(storePath).records.map((record) => record.id)).toEqual(["record-2"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes global lease files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-vm-lease-"));
    try {
      const storePath = path.join(dir, "lease.json");
      const lease = parseGlobalLease({
        projectRoot: "/repo",
        laneId: "lane-1",
        vmId: "vm-1",
        vmName: "ADE Lane",
        updatedAt: "2026-05-31T00:00:00.000Z",
      });
      expect(lease).toMatchObject({ laneName: "lane-1", vmId: "vm-1" });

      writeGlobalLeaseFile(storePath, { version: 1, lease });
      expect(readGlobalLeaseFile(storePath).lease).toEqual(lease);

      fs.writeFileSync(storePath, JSON.stringify({ version: 1, lease: { laneId: "missing-required" } }));
      expect(readGlobalLeaseFile(storePath).lease).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips VNC credentials under stable keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-vm-vnc-"));
    try {
      const storePath = path.join(dir, "vnc.json");
      const key = vncCredentialKey("lane-1", "vm-1");
      writeVncCredentialStore(storePath, {
        version: 1,
        credentials: {
          [key]: {
            laneId: "lane-1",
            vmName: "vm-1",
            password: "secret",
            updatedAt: "2026-05-31T00:00:00.000Z",
          },
        },
      });

      expect(readVncCredentialStore(storePath).credentials[key]?.password).toBe("secret");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
