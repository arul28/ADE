import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createSyncService } from "./syncService";
import { removeTestTree } from "../../test/filesystem";

vi.mock("../../../../desktop/src/main/services/state/crsqliteExtension", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../../desktop/src/main/services/state/crsqliteExtension")
  >();
  return process.platform === "win32"
    ? { ...original, resolveCrsqliteExtensionPath: () => null }
    : original;
});

/**
 * Captures what `createSyncHostService` is actually constructed with.
 *
 * The host builds its own remote-command service when the caller does not
 * supply one, and that fallback decides which optional actions the host
 * advertises in `hello_ok`. A service that reaches the fallback without
 * `workToolsStateService` drops `workTools.*` from the advertised set — a
 * mobile capability disappearing with no error anywhere — so what the real
 * production caller passes is worth asserting, not assuming.
 */
const capturedHostArgs = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock("./syncHostService", async (importOriginal) => {
  const original = await importOriginal<typeof import("./syncHostService")>();
  return {
    ...original,
    createSyncHostService: (hostArgs: Record<string, unknown>) => {
      capturedHostArgs.value = hostArgs;
      return {
        waitUntilListening: async () => 41234,
        getLoopbackValidationStatus: () => ({ lastFailureAt: null, lastSuccessAt: null }),
        setLocalActiveLanePresence: () => {},
        setDiscoveryEnabled: () => {},
        getLanePresenceStamp: () => "",
        dispose: async () => {},
      };
    },
  };
});

// The host singleton is a real machine-wide lock on the developer's own ADE
// port. Stubbed so this test never contends with (or evicts) a live brain.
vi.mock("./syncHostSingleton", async (importOriginal) => {
  const original = await importOriginal<typeof import("./syncHostSingleton")>();
  return {
    ...original,
    acquireSyncHostSingleton: () => ({ updatePort: () => {}, dispose: () => {} }),
  };
});

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createSyncService host wiring", () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    capturedHostArgs.value = null;
    for (const root of cleanupRoots.splice(0)) await removeTestTree(root);
  });

  it("passes workToolsStateService to the host service it constructs", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-host-args-"));
    cleanupRoots.push(projectRoot);
    const db: AdeDb = await openKvDb(path.join(projectRoot, ".ade", "kv.sqlite"), createLogger() as any);
    const workToolsStateService = { getLaneState: vi.fn(async () => null) };
    const service = createSyncService({
      db,
      logger: createLogger() as any,
      projectRoot,
      hostStartupEnabled: false,
      localDeviceIdPath: path.join(projectRoot, ".ade", "secrets", "sync-device-id"),
      phonePairingStateDir: path.join(projectRoot, ".ade", "secrets", "sync"),
      fileService: {} as any,
      laneService: { list: vi.fn(async () => []) } as any,
      prService: {} as any,
      sessionService: {
        list: vi.fn(() => []),
        get: vi.fn(() => null),
        readTranscriptTail: vi.fn(async () => ""),
      } as any,
      ptyService: {
        readTranscriptTail: vi.fn(async () => ""),
        enrichSessions: vi.fn((rows: unknown[]) => rows),
      } as any,
      computerUseArtifactBrokerService: { listArtifacts: vi.fn(() => []) } as any,
      agentChatService: { listSessions: vi.fn(async () => []) } as any,
      sharedSyncListener: { ensureListening: vi.fn(async () => 41234) } as any,
      workToolsStateService: workToolsStateService as any,
    });

    try {
      await service.setHostStartupEnabled(true);
      expect(capturedHostArgs.value).not.toBeNull();
      expect(capturedHostArgs.value?.workToolsStateService).toBe(workToolsStateService);
    } finally {
      await service.dispose?.();
      db.close?.();
    }
  });
});
