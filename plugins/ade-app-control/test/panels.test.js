"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { buildMainPanel } = require("../panels");

describe("electron control panels", () => {
  it("binds the status row every client can list, and says where to drive it", () => {
    const panel = buildMainPanel({ status: { supported: true } });
    const list = panel.body.find((node) => node.component === "list");
    assert.equal(list.bind.collection, "status");
    const note = panel.body.find((node) => node.component === "text");
    assert.ok(note, "the fallback panel has no line for the phone");
    assert.match(note.text, /desktop/i);
    assert.ok(!panel.body.some((node) => node.component === "canvas"));
  });

  it("keeps the error state a retry rather than a dead end", () => {
    const panel = buildMainPanel({ state: "error", error: "The host did not answer." });
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty.action.onPress.action, "refreshStatus");
  });
});
