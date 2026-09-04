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

describe("a model's label", () => {
  it("prefers the title Cursor sent", () => {
    const [row] = readCatalog([{ id: "composer-2", displayName: "Composer 2 (preview)" }]);
    assert.equal(row.label, "Composer 2 (preview)");
  });

  it("turns an id into words when Cursor sent no title", () => {
    // A presentation rule, not a mapping table: a table would go stale the
    // week Cursor adds a model.
    const rows = readCatalog(["composer-2", "sonnet-4.5", "gpt-5.6-sol", "opus"]);
    assert.deepEqual(rows.map((row) => row.label), [
      "Composer 2",
      "Sonnet 4.5",
      // A segment with no vowel and at most four letters reads as an acronym.
      "GPT 5.6 Sol",
      "Opus",
    ]);
  });
});

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

  it("launches a model with no service tier when nobody asked for one", () => {
    /*
     * The regression the launch form caused: it initialised `fastMode` to
     * `false` and always sent it, and `false` here is an explicit request for
     * the STANDARD tier — which a model whose row names no service tier cannot
     * express, so every such launch was refused. `null` is "Cursor's default"
     * and is the only correct value for a control nobody touched.
     */
    const asked = verifyCreateModel({ modelId: "composer-2.5", fastMode: false, catalog });
    assert.equal(asked.ok, false, "asking for a tier the model has not is still refused");
    assert.match(asked.message, /standard speed/);

    const untouched = verifyCreateModel({ modelId: "composer-2.5", fastMode: null, catalog });
    assert.deepEqual(untouched, { ok: true, model: { id: "composer-2.5" } });
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

  it("refuses a model whose row cannot express the reasoning effort asked for", () => {
    // Fails CLOSED. A row that names no reasoning parameter cannot carry
    // "high", so launching it would silently give the reader the row's default
    // under the label they did not pick.
    const result = verifyCreateModel({
      modelId: "composer-2.5",
      reasoningEffort: "high",
      catalog,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /reasoning effort/);
  });

  it("refuses a model whose row cannot express fast mode", () => {
    const result = verifyCreateModel({
      modelId: "composer-2.5",
      fastMode: true,
      catalog,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /fast mode/);
  });

  it("refuses a model whose row cannot express standard speed", () => {
    const result = verifyCreateModel({
      modelId: "composer-2.5",
      fastMode: false,
      catalog,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /standard speed/);
  });

  it("still launches a row with no parameters when nothing was selected", () => {
    // The refusal is about an UNMET request, never about a plain launch: a
    // reader who picked no effort and no speed asked the row for nothing.
    const result = verifyCreateModel({ modelId: "composer-2.5", catalog });
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
