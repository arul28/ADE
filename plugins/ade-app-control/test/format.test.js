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
  });
});
