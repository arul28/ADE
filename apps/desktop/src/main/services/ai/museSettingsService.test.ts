import { describe, expect, it } from "vitest";
import { parseMuseSettingsRunArgs } from "./museSettingsService";

describe("parseMuseSettingsRunArgs", () => {
  it.each([
    "snapshot",
    "computerUse",
    "pluginInstall",
    "marketplaceAdd",
    "marketplaceUpdate",
    "marketplaceRemove",
    "skillSetActivation",
    "skillImport",
    "computerUseUpdate",
    "computerUseSetupStart",
    "computerUseSetupCheck",
    "feedback",
  ])("accepts the %s request kind and keeps its fields", (kind) => {
    const parsed = parseMuseSettingsRunArgs({ handleId: "  visit-1  ", request: { kind, extra: true } });

    expect(parsed.handleId).toBe("visit-1");
    expect(parsed.request).toMatchObject({ kind });
  });

  it.each([
    ["a kind outside the allowlist", { handleId: "visit-1", request: { kind: "deleteEverything" } }],
    ["a request with no kind", { handleId: "visit-1", request: {} }],
    ["a non-object payload", null],
  ])("rejects %s before it can reach a host", (_label, raw) => {
    expect(() => parseMuseSettingsRunArgs(raw)).toThrow(/Unknown Muse settings request/);
  });

  it("requires a handle id, since it keys the host the page keeps open", () => {
    expect(() => parseMuseSettingsRunArgs({ request: { kind: "snapshot" } })).toThrow(/handleId is required/);
  });
});
