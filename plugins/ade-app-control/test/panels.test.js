"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildMainPanel } = require("../panels");

describe("electron control panels", () => {
  it("draws the electron-control canvas bound to the status collection", () => {
    const panel = buildMainPanel({ status: { supported: true } });
    const canvas = panel.body.find((node) => node.component === "canvas");
    assert.equal(canvas.engine, "electron-control");
    assert.equal(canvas.bind.collection, "status");
  });
});
