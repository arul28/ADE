import { beforeEach, describe, expect, it } from "vitest";
import type { AgentChatModelCatalog } from "../../../shared/types";
import { createDynamicCursorCliModelDescriptor } from "../../../shared/modelRegistry";
import { descriptorsFromAgentChatModelCatalog } from "../shared/ModelPicker/modelCatalog";
import {
  rememberRuntimeCatalog,
  resetModelPickerRuntimeCatalogForTests,
} from "../shared/ModelPicker/runtimeCatalogCache";
import { cursorCloudEligibleModelIds, runtimeCatalogModelIds } from "./useCursorCloudModelEligibility";

/**
 * The cloud eligibility rule, tested without rendering `AgentChatPane`.
 *
 * Cursor's verified SDK catalog decides what the cloud accepts and it arrives
 * asynchronously, so the rule has to distinguish "Cursor told us this model is
 * CLI-only" from "we do not know yet".
 */
const SCOPE = "local:/tmp/eligibility-under-test";

function seedCursorCatalog(): { cliOnlyId: string; sdkOnlyId: string; unknownId: string } {
  const cliOnly = createDynamicCursorCliModelDescriptor("cli-only", "Cursor CLI Only", {
    cursorAvailability: { cli: true, sdk: false },
  });
  const sdkOnly = createDynamicCursorCliModelDescriptor("sdk-only", "Cursor Chat Only", {
    cursorAvailability: { cli: false, sdk: true },
  });
  // No `cursorAvailability` at all: the catalog has not told us either way yet.
  const unknown = createDynamicCursorCliModelDescriptor("availability-unknown", "Cursor Unknown");
  const models = [cliOnly, sdkOnly, unknown];
  const catalog = {
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [{
      key: "cursor",
      displayName: "Cursor",
      providers: [{
        key: "cursor",
        displayName: "Cursor",
        badgeColor: "#8B5CF6",
        modelCount: models.length,
        subsections: [{
          key: "cursor",
          label: "Cursor",
          models: models.map((model, index) => ({
            id: model.id,
            runtimeModelId: model.providerModelId,
            provider: "cursor",
            providerKey: "cursor",
            groupKey: "cursor",
            displayName: model.displayName,
            isDefault: index === 1,
            isAvailable: true,
            cursorAvailability: model.cursorAvailability,
          })),
        }],
      }],
    }],
  } as AgentChatModelCatalog;
  rememberRuntimeCatalog(catalog, { mode: "cached", scopeKey: SCOPE });
  descriptorsFromAgentChatModelCatalog(catalog, undefined, SCOPE);
  return { cliOnlyId: cliOnly.id, sdkOnlyId: sdkOnly.id, unknownId: unknown.id };
}

describe("cursorCloudEligibleModelIds", () => {
  beforeEach(() => {
    resetModelPickerRuntimeCatalogForTests();
  });

  it("keeps a Cursor model whose SDK availability is still unknown", () => {
    const { unknownId } = seedCursorCatalog();
    expect(cursorCloudEligibleModelIds([unknownId], SCOPE)).toEqual([unknownId]);
  });

  it("excludes a Cursor model Cursor reports as CLI-only", () => {
    const { cliOnlyId, sdkOnlyId } = seedCursorCatalog();
    expect(cursorCloudEligibleModelIds([cliOnlyId, sdkOnlyId], SCOPE)).toEqual([sdkOnlyId]);
  });

  it("excludes non-Cursor models", () => {
    seedCursorCatalog();
    expect(cursorCloudEligibleModelIds(["anthropic/claude-sonnet-5", "openai/gpt-5.4"], SCOPE)).toEqual([]);
  });

  it("keeps a cursor/ id the catalog has never reported", () => {
    // The registry resolves any `cursor/<id>` to a Cursor descriptor carrying no
    // availability flags. That is the cold-start case, and it stays eligible: the
    // main process rejects it later if Cursor turns out not to run it.
    seedCursorCatalog();
    expect(cursorCloudEligibleModelIds(["cursor/never-reported"], SCOPE)).toEqual(["cursor/never-reported"]);
  });

  it("de-duplicates candidates and keeps the order they were offered in", () => {
    const { sdkOnlyId, unknownId } = seedCursorCatalog();
    expect(cursorCloudEligibleModelIds(
      [unknownId, sdkOnlyId, unknownId],
      SCOPE,
    )).toEqual([unknownId, sdkOnlyId]);
  });

  it("returns nothing for a scope with no runtime catalog", () => {
    seedCursorCatalog();
    expect(runtimeCatalogModelIds("local:/tmp/some-other-machine")).toEqual([]);
  });

  it("reports the runtime catalog's own ids for its scope", () => {
    const { cliOnlyId, sdkOnlyId, unknownId } = seedCursorCatalog();
    const ids = runtimeCatalogModelIds(SCOPE);
    expect(ids).toContain(cliOnlyId);
    expect(ids).toContain(sdkOnlyId);
    expect(ids).toContain(unknownId);
  });
});
