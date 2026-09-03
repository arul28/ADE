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

  it("says on the phone why there is nothing to drive there", () => {
    // The panel is the FALLBACK now — every client that can host a page draws
    // `page/` instead. What is left has to be honest about why: a phone is not
    // the computer the Electron app is running on, and a blank canvas would
    // read as a stream that failed rather than a surface that does not apply.
    const panel = buildMainPanel({ status: { supported: true } });
    const note = panel.body.find((node) => node.component === "text");
    assert.ok(note, "the fallback panel has no line for the phone");
    assert.match(note.text, /desktop/i);
  });

  it("keeps the error state a retry rather than a dead end", () => {
    const panel = buildMainPanel({ state: "error", error: "The host did not answer." });
    const empty = panel.body.find((node) => node.component === "emptyState");
    assert.equal(empty.action.onPress.action, "refreshStatus");
  });
});
