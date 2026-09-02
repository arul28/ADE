"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { statusRow } = require("../format");

describe("simulator row shaping", () => {
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

  it("says the simulator needs a Mac when the host is not darwin", () => {
    const row = statusRow({ supported: false, platform: "linux" });
    assert.equal(row.supported, "no");
    assert.match(row.title, /Mac/i);
  });
});
