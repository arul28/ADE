"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { statusRow } = require("../format");

describe("electron control row shaping", () => {
  it("marks an attached session live", () => {
    const row = statusRow({
      supported: true,
      activeSession: { title: "ADE desktop", url: "http://localhost:5173" },
    });
    assert.equal(row.live, "yes");
    assert.equal(row.badge.tone, "success");
    assert.match(row.subtitle, /ADE desktop|localhost/);
  });

  it("says idle when nothing is attached", () => {
    const row = statusRow({ supported: true, activeSession: null });
    assert.equal(row.live, "no");
    assert.equal(row.badge.text, "IDLE");
    assert.match(row.subtitle, /Electron Control/);
  });

  it("does not claim support for a status that never said so", () => {
    // A read that answered nothing, or answered without the field, is not a
    // machine that supports Electron Control. The old `!== false` test drew
    // "Idle" over both.
    for (const status of [null, undefined, {}, { activeSession: null }]) {
      const row = statusRow(status);
      assert.equal(row.supported, "no", `status ${JSON.stringify(status)} is not support`);
      assert.equal(row.badge.text, "UNAVAILABLE");
      assert.equal(row.title, "Not available on this machine");
    }
  });
});
