import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setOpenCodeInventoryPersistencePathForTests,
  loadPersistedOpenCodeInventory,
  persistOpenCodeInventory,
  type OpenCodeProviderInfo,
} from "./openCodeInventory";

let cacheFile: string;

const providers: OpenCodeProviderInfo[] = [
  { id: "openai", name: "OpenAI", connected: true, modelCount: 12 },
  { id: "moonshotai", name: "Moonshot", connected: false, modelCount: 4 },
];

beforeEach(() => {
  cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-inv-")), "inventory.json");
  __setOpenCodeInventoryPersistencePathForTests(cacheFile);
});

afterEach(() => {
  __setOpenCodeInventoryPersistencePathForTests(null);
  try {
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("openCode inventory persistence", () => {
  it("persists a probe's provider list and reloads it from disk on a cold read", () => {
    persistOpenCodeInventory("/repo", providers);

    // Drop the in-memory memo so the read comes straight from disk (cold path).
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);

    expect(loadPersistedOpenCodeInventory("/repo")).toEqual(providers);
  });

  it("keeps provider lists isolated per project root", () => {
    persistOpenCodeInventory("/repo", providers);
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);

    expect(loadPersistedOpenCodeInventory("/other")).toEqual([]);
  });

  it("returns an empty list when nothing has been persisted", () => {
    expect(loadPersistedOpenCodeInventory("/repo")).toEqual([]);
  });
});
