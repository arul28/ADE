import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../../shared/types/sync";
import { openKvDb } from "../state/kvDb";
import { createDeviceRegistryService } from "./deviceRegistryService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
  return root;
}

describe("deviceRegistryService", () => {
  it("keeps a stable local device identity across restarts and bootstraps the cluster brain", async () => {
    const projectRoot = makeProjectRoot("ade-device-registry-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");

    const db1 = await openKvDb(dbPath, createLogger() as any);
    const registry1 = createDeviceRegistryService({
      db: db1,
      logger: createLogger() as any,
      projectRoot,
    });

    const local1 = registry1.ensureLocalDevice();
    const cluster1 = registry1.bootstrapLocalBrainIfNeeded();

    expect(local1.deviceId).toBeTruthy();
    expect(local1.siteId).toBeTruthy();
    expect(cluster1.brainDeviceId).toBe(local1.deviceId);
    expect(cluster1.brainEpoch).toBe(1);

    db1.close();

    const db2 = await openKvDb(dbPath, createLogger() as any);
    const registry2 = createDeviceRegistryService({
      db: db2,
      logger: createLogger() as any,
      projectRoot,
    });

    const local2 = registry2.ensureLocalDevice();
    const cluster2 = registry2.bootstrapLocalBrainIfNeeded();

    expect(local2.deviceId).toBe(local1.deviceId);
    expect(local2.siteId).toBe(local1.siteId);
    expect(cluster2.brainDeviceId).toBe(local1.deviceId);
    expect(cluster2.brainEpoch).toBe(1);
    expect(registry2.listDevices()).toHaveLength(1);

    db2.close();
  });

  it("persists notification preferences in device metadata across registry restarts", async () => {
    const projectRoot = makeProjectRoot("ade-device-registry-prefs-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");

    const db1 = await openKvDb(dbPath, createLogger() as any);
    const registry1 = createDeviceRegistryService({
      db: db1,
      logger: createLogger() as any,
      projectRoot,
    });
    const local = registry1.ensureLocalDevice();
    const prefs = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      chat: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.chat,
        awaitingInput: false,
      },
    };

    registry1.setNotificationPreferences(local.deviceId, prefs);
    db1.close();

    const db2 = await openKvDb(dbPath, createLogger() as any);
    const registry2 = createDeviceRegistryService({
      db: db2,
      logger: createLogger() as any,
      projectRoot,
    });

    expect(registry2.getNotificationPreferences(local.deviceId)?.chat.awaitingInput).toBe(false);
    db2.close();
  });
});
