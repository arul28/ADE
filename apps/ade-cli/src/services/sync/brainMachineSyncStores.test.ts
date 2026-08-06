import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";
import {
  createProjectlessSyncControls,
  resetBrainMachineSyncStoresForTests,
  resolveBrainMachineSyncStores,
} from "./brainMachineSyncStores";
import { createSyncCloudRelayStore } from "./syncCloudRelayStore";
import { RELAY_SIGN_IN_REQUIRED_MESSAGE } from "./syncTunnelClientService";

const tempDirs: string[] = [];

function makeSecretsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-stores-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetBrainMachineSyncStoresForTests();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveBrainMachineSyncStores", () => {
  it("hands the same stores to every spelling of one directory", () => {
    const secretsDir = makeSecretsDir();
    const first = resolveBrainMachineSyncStores(secretsDir);
    // Trailing separator and a `.` segment are the same directory. A bare case
    // fold treats them as three, and three sets of stores means the PIN the RPC
    // surface writes is invisible to the ingress path that verifies it.
    const second = resolveBrainMachineSyncStores(`${secretsDir}${path.sep}`);
    const third = resolveBrainMachineSyncStores(path.join(secretsDir, "."));

    expect(second.pinStore).toBe(first.pinStore);
    expect(third.pinStore).toBe(first.pinStore);
    expect(second.pairingStore).toBe(first.pairingStore);
    expect(third.securityStore).toBe(first.securityStore);
  });

  it("keys a Windows extended-length path to its plain spelling", () => {
    // Codex-style `\\?\` paths reach ADE from tools that open long paths. The
    // key has to fold them back or one directory becomes two.
    expect(pathKey("\\\\?\\C:\\Users\\ade\\secrets", "win32"))
      .toBe(pathKey("C:\\Users\\ade\\secrets", "win32"));
  });

  it("gives different directories different stores", () => {
    const first = resolveBrainMachineSyncStores(makeSecretsDir());
    const second = resolveBrainMachineSyncStores(makeSecretsDir());
    expect(second.pinStore).not.toBe(first.pinStore);
  });
});

describe("createProjectlessSyncControls", () => {
  it("reports the sign-in prompt while the account does not own the machine", () => {
    const secretsDir = makeSecretsDir();
    const controls = createProjectlessSyncControls({
      stores: resolveBrainMachineSyncStores(secretsDir),
      cloudRelayStore: createSyncCloudRelayStore({
        filePath: path.join(secretsDir, "sync-cloud-relay.json"),
      }),
      getTunnelStatus: () => null,
      accountRetainsMachineOwnership: () => false,
    });

    const status = controls.getCloudRelayStatus();
    expect(status.lastError).toBe(RELAY_SIGN_IN_REQUIRED_MESSAGE);
    expect(status.connected).toBe(false);
    expect(status.activeTunnels).toBe(0);
    expect(status.machineKey).toMatch(/^[0-9a-f]{32}$/);
  });
});
