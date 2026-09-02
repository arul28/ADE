"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  catalogControlOptions,
  readCatalog,
  verifyCreateModel,
} = require("../modelSelection");

const catalog = readCatalog([
  {
    id: "composer-2",
    parameters: [
      {
        id: "reasoning",
        displayName: "Reasoning",
        values: [
          { value: "low", displayName: "Low" },
          { value: "high", displayName: "High" },
        ],
      },
      {
        id: "speed",
        displayName: "Service tier",
        values: [
          { value: "fast", displayName: "Fast" },
          { value: "standard", displayName: "Standard" },
        ],
      },
    ],
    variants: [
      {
        displayName: "High fast",
        params: [
          { id: "reasoning", value: "high" },
          { id: "speed", value: "fast" },
        ],
      },
    ],
  },
  { id: "composer-2.5" },
]);

describe("verifyCreateModel", () => {
  it("omits model when the form left Cursor's default", () => {
    assert.deepEqual(verifyCreateModel({}), { ok: true, model: null });
  });

  it("sends { id } without params when the user picked no controls", () => {
    assert.deepEqual(
      verifyCreateModel({ modelId: "composer-2" }),
      { ok: true, model: { id: "composer-2" } },
    );
  });

  it("still sends { id } when the catalog has not loaded and no control was picked", () => {
    assert.deepEqual(
      verifyCreateModel({
        modelId: "composer-2",
        catalogError: "timeout",
      }),
      { ok: true, model: { id: "composer-2" } },
    );
  });

  it("refuses controls without a model", () => {
    const result = verifyCreateModel({ fastMode: true });
    assert.equal(result.ok, false);
    assert.match(result.message, /without a selected model/);
  });

  it("fails closed when controls were picked and the catalog did not load", () => {
    const result = verifyCreateModel({
      modelId: "composer-2",
      fastMode: true,
      catalogError: "timeout",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /timeout/);
  });

  it("fails closed on an unlisted model once a control is set", () => {
    const result = verifyCreateModel({
      modelId: "mystery",
      reasoningEffort: "high",
      catalog,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /does not list model mystery/);
  });

  it("sends { id, params } when the catalog can express the pick", () => {
    const result = verifyCreateModel({
      modelId: "composer-2",
      reasoningEffort: "high",
      fastMode: true,
      catalog,
    });
    assert.equal(result.ok, true);
    assert.equal(result.model.id, "composer-2");
    assert.deepEqual(result.model.params, [
      { id: "reasoning", value: "high" },
      { id: "speed", value: "fast" },
    ]);
  });

  it("does not block a model that has no reasoning parameter", () => {
    const result = verifyCreateModel({
      modelId: "composer-2.5",
      reasoningEffort: "high",
      catalog,
    });
    assert.deepEqual(result, { ok: true, model: { id: "composer-2.5" } });
  });
});

describe("catalogControlOptions", () => {
  it("offers the reasoning and speed controls the catalog actually names", () => {
    const options = catalogControlOptions(catalog);
    assert.deepEqual(
      options.reasoning.map((entry) => entry.value).sort(),
      ["high", "low"],
    );
    assert.equal(options.speed, true);
  });
});
