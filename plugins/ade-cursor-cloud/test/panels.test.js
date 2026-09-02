"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildFleetPanel } = require("../panels");

describe("fleet empty states", () => {
  it("offers Open Cursor settings when there is no API key", () => {
    const panel = buildFleetPanel({ state: "no-key" });
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty?.action?.onPress?.action, "openCursorSettings");
    assert.equal(empty?.action?.label, "Open Cursor settings");
  });
});
