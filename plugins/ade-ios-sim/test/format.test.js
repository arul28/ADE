"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { PRODUCT_NAME, statusRow } = require("../format");

describe("simulator row shaping", () => {
  it("names the pane once, so every string agrees", () => {
    assert.equal(PRODUCT_NAME, "iOS Sim Control");
  });

  it("marks a live device", () => {
    const row = statusRow({
      supported: true,
      platform: "darwin",
      activeSession: { deviceName: "iPhone 16" },
    });
    assert.equal(row.live, "yes");
    assert.equal(row.badge.tone, "success");
    assert.match(row.title, /iPhone 16/);
  });

  it("says driving a simulator needs a Mac when the host is not darwin", () => {
    const row = statusRow({ supported: false, platform: "linux" });
    assert.equal(row.supported, "no");
    assert.match(row.title, /Mac/i);
    assert.match(row.subtitle, /Mac/i);
  });

  it("points an idle Mac at iOS Sim Control by name", () => {
    const row = statusRow({ supported: true, platform: "darwin", activeSession: null });
    assert.equal(row.live, "no");
    assert.match(row.subtitle, /iOS Sim Control/);
  });
});
