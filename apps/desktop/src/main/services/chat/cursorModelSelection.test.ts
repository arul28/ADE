import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cursorModelsListMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

vi.mock("../ai/providerRuntimeHealth", () => ({
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
}));

import {
  clearCursorCliModelsCache,
  discoverCursorSdkModelDescriptors,
  probeCursorSdkModelDiscovery,
} from "./cursorModelsDiscovery";
import {
  cursorModelFastTierFromCache,
  cursorSdkConfigOptions,
  cursorSdkSelectionInputForSession,
  cursorSelectionHasFastTier,
  cursorSelectionParams,
  describeCursorSdkModelSelectionFailure,
  describeUnappliedCursorSelection,
  hasExplicitCursorSelection,
  listCursorSdkModelConfigParameters,
  resolveCursorSdkFollowUpSelection,
  resolveCursorSdkLocalSelection,
  resolveCursorSdkModelSelection,
  resolveCursorSdkModelSelectionFromCache,
  resolveCursorSdkModelSelectionParams,
  unsupportedCursorSelection,
  verifyExplicitCursorModelSelection,
} from "./cursorModelSelection";

beforeEach(() => {
  cursorModelsListMock.mockReset();
  clearCursorCliModelsCache();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const failCatalogFetches = (): void => {
  cursorModelsListMock.mockRejectedValue(new Error("network down"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
};

describe("resolving a Cursor model selection against the catalog", () => {
  it("leaves an unrequested tier unset and refuses a tier the model cannot express", async () => {
    cursorModelsListMock.mockResolvedValue([{ id: "plain-model", displayName: "Plain Model" }]);

    await expect(resolveCursorSdkModelSelection("crsr_test", {
      modelSdkId: "plain-model",
    })).resolves.toEqual({ status: "ok", params: [] });
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "plain-model",
      serviceTier: "fast",
    })).rejects.toThrow(/fast tier/i);
  });

  it("preserves Cursor SDK parameters and variants as runtime reasoning and service tiers", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2",
        displayName: "Composer 2",
        aliases: ["composer-latest"],
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [{ value: "fast", displayName: "Fast" }],
          },
        ],
        variants: [
          {
            displayName: "Fast High",
            params: [
              { id: "reasoning_effort", value: "high" },
              { id: "speed", value: "fast" },
            ],
          },
        ],
      },
    ]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors[0]).toMatchObject({
      id: "cursor/composer-2",
      reasoningTiers: ["low", "high"],
      serviceTiers: ["fast"],
    });
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2",
      reasoningEffort: "high",
      fastMode: true,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ]);
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-latest",
      reasoningEffort: "high",
      fastMode: true,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "fast" },
    ]);
  });

  it("passes explicit standard service tier params when Cursor fast mode is off", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [
          {
            id: "speed",
            displayName: "Speed",
            values: [
              { value: "standard", displayName: "Standard" },
              { value: "fast", displayName: "Fast" },
            ],
          },
        ],
        variants: [
          {
            displayName: "Standard",
            params: [{ id: "speed", value: "standard" }],
          },
          {
            displayName: "Fast",
            params: [{ id: "speed", value: "fast" }],
          },
        ],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      fastMode: false,
    })).toEqual([{ id: "speed", value: "standard" }]);
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      fastMode: true,
    })).toEqual([{ id: "speed", value: "fast" }]);
  });

  it("discovers and resolves service tiers from compact variant-only rows", async () => {
    cursorModelsListMock.mockResolvedValue([{
      id: "composer-2.6",
      displayName: "Composer 2.6",
      variants: [
        { displayName: "Standard", params: [{ id: "service_tier", value: "standard" }] },
        { displayName: "Fast", params: [{ id: "service_tier", value: "fast" }] },
      ],
    }]);

    const descriptors = await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(descriptors[0]?.serviceTiers).toEqual(["standard", "fast"]);
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2.6",
      serviceTier: "standard",
    })).toEqual({ status: "ok", params: [{ id: "service_tier", value: "standard" }] });
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2.6",
      serviceTier: "fast",
    })).toEqual({ status: "ok", params: [{ id: "service_tier", value: "fast" }] });
  });

  it("keeps a known model with no parameterized controls valid", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "grok-4.6", displayName: "Grok 4.6" },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "grok-4.6",
      fastMode: false,
    })).toEqual([]);
  });

  it("reports a value a control the model DOES declare cannot express as partial", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "grok-4.6",
        displayName: "Grok 4.6",
        // A bare snake-case id and no display name. The classifier still reads
        // it as a reasoning control, so the requested value is unmet, not
        // inapplicable.
        parameters: [{
          id: "reasoning_effort",
          values: [{ value: "high" }],
        }],
      },
      {
        id: "grok-4.6-tiered",
        displayName: "Grok 4.6 Tiered",
        parameters: [{
          id: "service_tier",
          values: [{ value: "standard" }, { value: "fast" }],
        }],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).toEqual({ status: "partial", params: [], unmet: ["reasoning"] });
    // The local chat path still sends whatever resolved: dropping every param
    // because one control could not be expressed loses the others too.
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).toEqual([]);
    // The same for a bare tier id: `service_tier` alone classifies as a tier
    // control, so the chosen tier resolves to a real value.
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "grok-4.6-tiered",
      fastMode: false,
    })).toEqual({ status: "ok", params: [{ id: "service_tier", value: "standard" }] });
  });

  it("treats a control the model declares no parameter for as inapplicable, not unmet", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        // Cursor's real row for this model declares a speed control and no
        // reasoning control at all.
        parameters: [{
          id: "speed",
          displayName: "Speed",
          values: [
            { value: "standard", displayName: "Standard" },
            { value: "fast", displayName: "Fast" },
          ],
        }],
      },
      {
        id: "grok-4.6",
        displayName: "Grok 4.6",
        // The mirror case: a reasoning control and no service tier control.
        parameters: [{
          id: "reasoning_effort",
          displayName: "Reasoning effort",
          values: [{ value: "high", displayName: "High" }],
        }],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    // A stale reasoning effort left on the draft by a previously selected model
    // cannot block this one: there is no variant Cursor could silently pick.
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2.5",
      reasoningEffort: "xhigh",
      fastMode: true,
    })).toEqual({ status: "ok", params: [{ id: "speed", value: "fast" }] });
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2.5",
      reasoningEffort: "xhigh",
      fastMode: null,
    })).toEqual({ status: "ok", params: [] });
    // Fast mode on a model with no service tier control is inapplicable too.
    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "grok-4.6",
      reasoningEffort: "high",
      fastMode: true,
    })).toEqual({ status: "ok", params: [{ id: "reasoning_effort", value: "high" }] });
  });

  it("lets a cloud create launch a model that declares no reasoning control", async () => {
    cursorModelsListMock.mockResolvedValue([{
      id: "composer-2.5",
      displayName: "Composer 2.5",
      parameters: [{
        id: "speed",
        displayName: "Speed",
        values: [
          { value: "standard", displayName: "Standard" },
          { value: "fast", displayName: "Fast" },
        ],
      }],
    }]);

    // The fail-closed cloud path verifies the same way: it returns the params it
    // could express instead of refusing the launch over an inapplicable control.
    await expect(resolveCursorSdkModelSelection("crsr_test", {
      modelSdkId: "composer-2.5",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).resolves.toEqual({ status: "ok", params: [{ id: "speed", value: "standard" }] });
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2.5",
      reasoningEffort: "xhigh",
      fastMode: false,
    })).resolves.toEqual([{ id: "speed", value: "standard" }]);
  });

  it("tells an unlisted model apart from a catalog it could not load", async () => {
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2" })).toEqual({
      status: "catalog-unavailable",
      reason: expect.any(String),
    });

    cursorModelsListMock.mockResolvedValue([{ id: "composer-2", displayName: "Composer 2" }]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2" }))
      .toEqual({ status: "ok", params: [] });
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "gpt-9" }))
      .toEqual({ status: "unknown-model" });
  });

  it("probes and resolves in one call, and names a probe failure as its reason", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2",
        displayName: "Composer 2",
        parameters: [{
          id: "reasoning_effort",
          displayName: "Reasoning effort",
          values: [{ value: "high" }],
        }],
      },
    ]);

    await expect(resolveCursorSdkModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      reasoningEffort: "high",
    })).resolves.toEqual({ status: "ok", params: [{ id: "reasoning_effort", value: "high" }] });

    clearCursorCliModelsCache();
    cursorModelsListMock.mockRejectedValue(new Error("SDK model listing failed"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));

    const failed = await resolveCursorSdkModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      reasoningEffort: "high",
    });
    // The async resolver supplies the probe's own reason. The cache-only
    // resolver cannot: it takes no API key, so it never speaks for one.
    expect(failed).toEqual({ status: "catalog-unavailable", reason: expect.any(String) });
    if (failed.status === "ok") throw new Error("unreachable");
    expect(describeCursorSdkModelSelectionFailure("composer-2", failed))
      .toMatch(/^Could not load Cursor's model catalog \(.+\)\. Try again\.$/);
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2" })).toEqual({
      status: "catalog-unavailable",
      reason: "Cursor's model catalog has not loaded yet.",
    });
  });

  it("verifies a cloud create only when the caller chose a control", async () => {
    cursorModelsListMock.mockResolvedValue([{
      id: "composer-2",
      displayName: "Composer 2",
      parameters: [{
        id: "speed",
        displayName: "Speed",
        values: [{ value: "fast", displayName: "Fast" }],
      }],
    }]);

    // Nothing chosen: no verification, and the caller supplies its own fallback.
    await expect(verifyExplicitCursorModelSelection("crsr_test", { modelSdkId: "composer-2" }))
      .resolves.toBeNull();
    // An absent fast mode is no tier opinion, so a catalog with no standard
    // value still verifies. Both cloud create paths read it the same way.
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      reasoningEffort: null,
      fastMode: true,
    })).resolves.toEqual([{ id: "speed", value: "fast" }]);
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      fastMode: false,
    })).rejects.toThrow("could not verify the selected model settings (standard tier)");
  });

  it("treats blank reasoning effort as no explicit control", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("should not probe"));
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      reasoningEffort: " ",
    })).resolves.toBeNull();
    expect(cursorModelsListMock).not.toHaveBeenCalled();
  });

  it("resolves an authoritative empty probe without another key's cached catalog", async () => {
    cursorModelsListMock.mockResolvedValueOnce([{ id: "composer-2", displayName: "Composer 2" }]);
    await expect(resolveCursorSdkModelSelection("crsr_key_a", {
      modelSdkId: "composer-2",
    })).resolves.toEqual({ status: "ok", params: [] });
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2" }))
      .toEqual({ status: "ok", params: [] });

    cursorModelsListMock.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ models: [] }) })));

    await expect(resolveCursorSdkModelSelection("crsr_key_b", {
      modelSdkId: "composer-2",
      fastMode: true,
    })).resolves.toEqual({ status: "unknown-model" });
    // The cache-only path still sees key A's rows: empty probes do not overwrite
    // a different key. Authoritative resolve must not follow that cache.
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2" }))
      .toEqual({ status: "ok", params: [] });
  });

  it("names the cause of every selection a fail-closed caller refuses", () => {
    expect(describeCursorSdkModelSelectionFailure("composer-2", { status: "unknown-model" }))
      .toBe("Cursor Cloud does not list model composer-2. Refresh Cursor models.");
    expect(describeCursorSdkModelSelectionFailure("composer-2", {
      status: "partial",
      params: [],
      unmet: ["fast"],
    })).toBe(
      "Cursor Cloud could not verify the selected model settings (fast tier). Refresh Cursor models and try again.",
    );
  });

  it("does not let standard tier variants overwrite selected Cursor reasoning params", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [
              { value: "standard", displayName: "Standard" },
              { value: "fast", displayName: "Fast" },
            ],
          },
        ],
        variants: [
          {
            displayName: "High reasoning",
            params: [{ id: "reasoning_effort", value: "high" }],
          },
          {
            displayName: "Standard",
            params: [
              { id: "speed", value: "standard" },
              { id: "reasoning_effort", value: "low" },
            ],
          },
        ],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2.5",
      reasoningEffort: "high",
      fastMode: false,
    })).toEqual([
      { id: "reasoning_effort", value: "high" },
      { id: "speed", value: "standard" },
    ]);
  });

  it("does not treat a Fast variant's default reasoning as the requested effort", async () => {
    cursorModelsListMock.mockResolvedValue([
      {
        id: "grok-4.6",
        displayName: "Grok 4.6",
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            values: [
              { value: "high", displayName: "High" },
            ],
          },
          {
            id: "speed",
            displayName: "Speed",
            values: [
              { value: "fast", displayName: "Fast" },
            ],
          },
        ],
        variants: [
          {
            displayName: "Fast",
            params: [
              { id: "speed", value: "fast" },
              { id: "reasoning_effort", value: "high" },
            ],
          },
        ],
      },
    ]);

    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: true,
    })).toEqual({
      status: "partial",
      params: [
        { id: "speed", value: "fast" },
        { id: "reasoning_effort", value: "high" },
      ],
      unmet: ["reasoning"],
    });
  });
});

describe("Cursor model options and a cold catalog", () => {
  const composerRow = {
    id: "composer-2",
    displayName: "Composer 2",
    parameters: [
      {
        id: "reasoning_effort",
        displayName: "Reasoning effort",
        values: [{ value: "low" }, { value: "high" }],
      },
      {
        id: "speed",
        displayName: "Speed",
        values: [{ value: "standard" }, { value: "fast" }],
      },
      {
        id: "max_context",
        displayName: "Max context",
        values: [{ value: "true" }, { value: "false" }],
      },
      {
        id: "verbosity",
        displayName: "Verbosity",
        values: [{ value: "terse", displayName: "Terse" }, { value: "verbose", displayName: "Verbose" }],
      },
    ],
  };

  it("sends a chat's config values as the model params the model declares", async () => {
    cursorModelsListMock.mockResolvedValue([composerRow]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2",
      reasoningEffort: "high",
      // A boolean and a display name both map onto the declared values; a key
      // the model does not declare (an ACP-era `mode`) is inapplicable.
      configValues: { max_context: true, verbosity: "Terse", mode: "agent" },
    })).toEqual({
      status: "ok",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "max_context", value: "true" },
        { id: "verbosity", value: "terse" },
      ],
    });
  });

  it("never lets a config value speak for the effort or tier the user set", async () => {
    cursorModelsListMock.mockResolvedValue([composerRow]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2",
      reasoningEffort: "low",
      fastMode: true,
      configValues: { reasoning_effort: "high", speed: "standard" },
    })).toEqual({
      status: "ok",
      params: [
        { id: "reasoning_effort", value: "low" },
        { id: "speed", value: "fast" },
      ],
    });
    // With no effort chosen, the config value is the only choice there is.
    expect(resolveCursorSdkModelSelectionParams({
      modelSdkId: "composer-2",
      configValues: { reasoning_effort: "high" },
    })).toEqual([{ id: "reasoning_effort", value: "high" }]);
  });

  it("reports a config value the declared parameter cannot take, and a cloud create refuses it", async () => {
    cursorModelsListMock.mockResolvedValue([composerRow]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(resolveCursorSdkModelSelectionFromCache({
      modelSdkId: "composer-2",
      configValues: { verbosity: "loud" },
    })).toEqual({ status: "partial", params: [], unmet: ["config"] });
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      configValues: { verbosity: "loud" },
    })).rejects.toThrow("could not verify the selected model settings (model options)");
    // Config values alone are an explicit selection a cloud create verifies.
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2",
      configValues: { verbosity: "verbose" },
    })).resolves.toEqual([{ id: "verbosity", value: "verbose" }]);
  });

  it("lists only the options that have no control of their own", async () => {
    expect(listCursorSdkModelConfigParameters("composer-2")).toEqual([]);
    cursorModelsListMock.mockResolvedValue([composerRow]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(listCursorSdkModelConfigParameters("composer-2").map((parameter) => parameter.id))
      .toEqual(["max_context", "verbosity"]);
    expect(listCursorSdkModelConfigParameters("not-listed")).toEqual([]);
  });

  it("loads a cold catalog before resolving, and reads a warm one without fetching", async () => {
    cursorModelsListMock.mockResolvedValue([composerRow]);
    // Nothing loaded the catalog: a headless chat's first send.
    expect(resolveCursorSdkModelSelectionFromCache({ modelSdkId: "composer-2", reasoningEffort: "high" }))
      .toMatchObject({ status: "catalog-unavailable" });

    await expect(resolveCursorSdkLocalSelection("crsr_test", {
      modelSdkId: "composer-2",
      reasoningEffort: "high",
      fastMode: true,
    })).resolves.toEqual({
      status: "ok",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "speed", value: "fast" },
      ],
    });
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);

    await resolveCursorSdkLocalSelection("crsr_test", { modelSdkId: "composer-2", reasoningEffort: "low" });
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);
  });

  it("answers at once with the cause when this key's catalog just failed to load", async () => {
    cursorModelsListMock.mockRejectedValue(new Error("AuthenticationError (status=401, endpoint=GET /v1/models)"));
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveCursorSdkLocalSelection("crsr_test", { modelSdkId: "composer-2", reasoningEffort: "high" });
    expect(first).toMatchObject({ status: "catalog-unavailable" });
    const callsAfterFirst = cursorModelsListMock.mock.calls.length + fetchMock.mock.calls.length;

    const second = await resolveCursorSdkLocalSelection("crsr_test", { modelSdkId: "composer-2", reasoningEffort: "high" });
    expect(second).toEqual(first);
    expect(cursorModelsListMock.mock.calls.length + fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("counts as explicit only a control the params must carry", () => {
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2" })).toBe(false);
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", reasoningEffort: " " })).toBe(false);
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", reasoningEffort: "high" })).toBe(true);
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", fastMode: true })).toBe(true);
    // `false` asks the resolver for the standard tier, so it needs the catalog.
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", fastMode: false })).toBe(true);
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", serviceTier: "standard" })).toBe(true);
    expect(hasExplicitCursorSelection({ modelSdkId: "composer-2", configValues: { verbosity: "terse" } })).toBe(true);
  });

  it("reads a chat's stored \"not fast\" as no tier opinion", () => {
    // A chat stores "not fast" as `false` or as no value. Neither asks for the
    // standard tier, so the local path never needs the catalog for it.
    const input = cursorSdkSelectionInputForSession({ fastMode: false }, "composer-2");
    expect(input).toEqual({
      modelSdkId: "composer-2",
      reasoningEffort: undefined,
      fastMode: null,
      serviceTier: null,
      configValues: null,
    });
    expect(hasExplicitCursorSelection(input)).toBe(false);
    expect(cursorSdkSelectionInputForSession({ fastMode: true, cursorCloudServiceTier: "standard" }, "composer-2"))
      .toMatchObject({ fastMode: true, serviceTier: "standard" });
  });
});

describe("a cloud run reads the catalog it already holds", () => {
  const composer25 = {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      { id: "reasoning_effort", displayName: "Reasoning effort", values: [{ value: "low" }, { value: "high" }] },
      { id: "speed", displayName: "Speed", values: [{ value: "standard" }, { value: "fast" }] },
      {
        id: "verbosity",
        displayName: "Verbosity",
        values: [{ value: "terse", displayName: "Terse" }, { value: "verbose", displayName: "Verbose" }],
      },
    ],
  };

  it("verifies against this key's warm catalog instead of fetching on every cloud run", async () => {
    cursorModelsListMock.mockResolvedValue([composer25]);
    await probeCursorSdkModelDiscovery("crsr_test");
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);

    // A catalog fetch that would fail now must not matter: the warm rows answer.
    failCatalogFetches();
    await expect(verifyExplicitCursorModelSelection("crsr_test", {
      modelSdkId: "composer-2.5",
      reasoningEffort: "high",
    })).resolves.toEqual([{ id: "reasoning_effort", value: "high" }]);
    await expect(resolveCursorSdkFollowUpSelection("crsr_test", {
      modelSdkId: "composer-2.5",
      fastMode: true,
    })).resolves.toEqual({ status: "ok", params: [{ id: "speed", value: "fast" }] });
    expect(cursorModelsListMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a follow-up only for a model the catalog does not list", async () => {
    cursorModelsListMock.mockResolvedValue([composer25]);
    await expect(resolveCursorSdkFollowUpSelection("crsr_test", {
      modelSdkId: "gpt-9",
      reasoningEffort: "high",
    })).rejects.toThrow("Cursor Cloud does not list model gpt-9. Refresh Cursor models.");

    // A control the model cannot express is best-effort: the params that did
    // resolve still go.
    await expect(resolveCursorSdkFollowUpSelection("crsr_test", {
      modelSdkId: "composer-2.5",
      reasoningEffort: "xhigh",
      fastMode: true,
    })).resolves.toEqual({
      status: "partial",
      params: [{ id: "speed", value: "fast" }],
      unmet: ["reasoning"],
    });
    // Nothing chosen: nothing to verify, and the caller falls back.
    await expect(resolveCursorSdkFollowUpSelection("crsr_test", { modelSdkId: "gpt-9" })).resolves.toBeNull();
  });

  it("sends a follow-up on when the catalog cannot load, and names the cause", async () => {
    failCatalogFetches();
    const input = { modelSdkId: "composer-2.5", reasoningEffort: "high" };
    const selection = await resolveCursorSdkFollowUpSelection("crsr_test", input);
    expect(selection).toEqual({ status: "catalog-unavailable", reason: expect.any(String) });
    expect(cursorSelectionParams(selection!)).toBeUndefined();
    expect(describeUnappliedCursorSelection(input, selection!))
      .toMatch(/^Cursor's model list could not be loaded \(.+\), so composer-2\.5 runs without high reasoning effort until it loads\.$/);
  });

  it("names what a best-effort run could not apply, and nothing when it applied everything", () => {
    const input = { modelSdkId: "composer-2.5", reasoningEffort: "xhigh", configValues: { verbosity: "loud" } };
    expect(describeUnappliedCursorSelection(input, { status: "partial", params: [], unmet: ["reasoning", "config"] }))
      .toBe("Cursor cannot apply the selected reasoning effort and model options to composer-2.5, so this run uses Cursor's default for them.");
    expect(describeUnappliedCursorSelection(input, { status: "partial", params: [], unmet: ["fast"] }))
      .toBe("Cursor cannot apply the selected fast tier to composer-2.5, so this run uses Cursor's default for it.");
    expect(describeUnappliedCursorSelection(input, { status: "ok", params: [] })).toBeNull();
    // A cold catalog costs a session that chose nothing nothing.
    expect(describeUnappliedCursorSelection(
      { modelSdkId: "composer-2.5" },
      { status: "catalog-unavailable", reason: "offline" },
    )).toBeNull();
  });

  it("resolves a local send that chose nothing without loading the catalog", async () => {
    failCatalogFetches();
    await expect(resolveCursorSdkLocalSelection("crsr_test", { modelSdkId: "composer-2.5" }))
      .resolves.toMatchObject({ status: "catalog-unavailable" });
    expect(cursorModelsListMock).not.toHaveBeenCalled();
  });
});

describe("the Fast tier comes from the catalog in memory only", () => {
  it("answers null while the catalog is cold, and never fetches for it", () => {
    cursorModelsListMock.mockResolvedValue([]);
    expect(cursorModelFastTierFromCache("composer-2.5")).toBeNull();
    expect(cursorModelsListMock).not.toHaveBeenCalled();
  });

  it("reads a warm catalog: a declared fast value is a tier, an unlisted model is unknown", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "composer-2.5", parameters: [{ id: "speed", values: [{ value: "standard" }, { value: "fast" }] }] },
      { id: "composer-2", parameters: [{ id: "reasoning_effort", values: [{ value: "high" }] }] },
      { id: "standard-only", parameters: [{ id: "speed", values: [{ value: "standard" }] }] },
    ]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(cursorModelFastTierFromCache("composer-2.5")).toBe(true);
    expect(cursorModelFastTierFromCache("composer-2")).toBe(false);
    // The tier exists but has no fast value: a partial resolve is not support.
    expect(cursorModelFastTierFromCache("standard-only")).toBe(false);
    expect(cursorModelFastTierFromCache("not-listed")).toBeNull();
    expect(cursorSelectionHasFastTier({ status: "partial", params: [{ id: "speed", value: "fast" }], unmet: ["fast"] }))
      .toBe(false);
  });
});

describe("an adopted model keeps only the choices it can take", () => {
  const catalog = [
    {
      id: "composer-2.5",
      parameters: [
        { id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
        { id: "speed", values: [{ value: "standard" }, { value: "fast" }] },
        { id: "verbosity", values: [{ value: "terse" }, { value: "verbose" }] },
      ],
    },
    {
      id: "composer-2",
      parameters: [
        { id: "reasoning_effort", values: [{ value: "high" }] },
        { id: "verbosity", values: [{ value: "terse" }] },
      ],
    },
    { id: "plain-model" },
  ];
  const chosen = {
    reasoningEffort: "low",
    fastMode: true,
    cursorCloudServiceTier: "fast" as const,
    cursorConfigValues: { verbosity: "verbose", max_context: true },
  };

  it("says nothing while the catalog cannot answer for the model", async () => {
    expect(unsupportedCursorSelection(chosen, "composer-2")).toBeNull();
    cursorModelsListMock.mockResolvedValue(catalog);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });
    expect(unsupportedCursorSelection(chosen, "not-listed")).toBeNull();
  });

  it("drops the choices that would come back unmet, and keeps the inapplicable ones", async () => {
    cursorModelsListMock.mockResolvedValue(catalog);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(unsupportedCursorSelection(chosen, "composer-2.5")).toEqual({
      reasoningEffort: false,
      fastMode: false,
      serviceTier: false,
      configKeys: [],
    });
    // composer-2 declares effort and verbosity without these values, and no
    // tier at all. An explicit cloud tier on a model with no tier is unmet, as
    // a cloud create would find it. An option the model does not declare
    // (max_context) is inapplicable and left alone.
    expect(unsupportedCursorSelection(chosen, "composer-2")).toEqual({
      reasoningEffort: true,
      fastMode: true,
      serviceTier: true,
      configKeys: ["verbosity"],
    });
    expect(unsupportedCursorSelection(chosen, "plain-model")).toEqual({
      reasoningEffort: false,
      fastMode: true,
      serviceTier: true,
      configKeys: [],
    });
  });
});

describe("the model options the composer renders", () => {
  const row = {
    id: "composer-2",
    parameters: [
      { id: "max_context", displayName: "Max context", values: [{ value: "true" }, { value: "false" }] },
      { id: "verbosity", displayName: "Verbosity", values: [{ value: "terse" }, { value: "verbose" }] },
    ],
  };

  it("reports an option the chat never set as null, Cursor's default", async () => {
    cursorModelsListMock.mockResolvedValue([row]);
    await discoverCursorSdkModelDescriptors("crsr_test", { mode: "probe" });

    expect(cursorSdkConfigOptions("composer-2", null).map((option) => [option.id, option.type, option.currentValue]))
      .toEqual([["max_context", "boolean", null], ["verbosity", "select", null]]);
    expect(cursorSdkConfigOptions("composer-2", { verbosity: "" })[1]?.currentValue).toBeNull();
    expect(cursorSdkConfigOptions("composer-2", { max_context: false, verbosity: "terse" })
      .map((option) => option.currentValue)).toEqual([false, "terse"]);
    expect(cursorSdkConfigOptions("composer-2", { max_context: "true" })[0]?.currentValue).toBe(true);
    expect(cursorSdkConfigOptions("composer-2", null)[1]?.options?.[0]).toEqual({ value: "", label: "Default" });
  });

  it("has no options before the catalog loads", () => {
    expect(cursorSdkConfigOptions("composer-2", { verbosity: "terse" })).toEqual([]);
  });
});
