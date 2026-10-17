import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../../../../desktop/src/main/services/state/kvDb";
import { removeTestTree } from "../../test/filesystem";
import { createDeviceRegistryService, readOrCreateLocalDeviceId } from "./deviceRegistryService";

const roots: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-device-registry-"));
  roots.push(root);
  return root;
}

describe("device registry identity guards", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await removeTestTree(root);
    vi.clearAllMocks();
  });

  it("creates one UUID machine device id for callers sharing the resolved path", () => {
    const secrets = path.join(tempRoot(), "secrets");
    const deviceIdPath = path.join(secrets, "sync-device-id");
    const first = readOrCreateLocalDeviceId(deviceIdPath);
    const second = readOrCreateLocalDeviceId(deviceIdPath);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(second).toBe(first);
  });

  it("refuses to persist a cluster brain that is absent from devices", async () => {
    const root = tempRoot();
    const db = await openKvDb(path.join(root, ".ade", "ade.db"), logger as any);
    try {
      const registry = createDeviceRegistryService({
        db,
        logger: logger as any,
        projectRoot: root,
        localDeviceIdPath: path.join(root, "machine-secrets", "sync-device-id"),
      });

      expect(() => registry.setClusterState({ brainDeviceId: "missing-device", brainEpoch: 9 }))
        .toThrow(/unregistered device/);
      expect(registry.getClusterState()).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith("sync.cluster_state_brain_device_missing", expect.objectContaining({
        brainDeviceId: "missing-device",
      }));
    } finally {
      await db.close();
    }
  });
});
