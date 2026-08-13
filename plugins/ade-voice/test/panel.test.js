"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DEEPLINK, buildPanelSchema } = require("../panel");

const READY = {
  ready: true,
  platformSupported: true,
  engineInstalled: true,
  modelInstalled: true,
  downloading: false,
  progress: null,
  receivedBytes: 0,
  totalBytes: null,
  lastDownloadError: null,
  platform: "darwin",
  modelDir: "/Users/x/Library/Application Support/ADE/whisper",
};

const states = {
  ready: READY,
  unsupported: { ...READY, ready: false, platformSupported: false, engineInstalled: false, modelInstalled: false, platform: "win32" },
  downloading: { ...READY, ready: false, modelInstalled: false, downloading: true, progress: "42%", receivedBytes: 60_000_000 },
  missing: { ...READY, ready: false, modelInstalled: false },
  failed: { ...READY, ready: false, modelInstalled: false, lastDownloadError: "The download timed out." },
};

describe("the state panel", () => {
  it("declares a fallback with a deeplink in every state — the one panel-fatal rule", () => {
    for (const [name, status] of Object.entries(states)) {
      const schema = buildPanelSchema(status);
      assert.equal(schema.v, 1, name);
      assert.ok(schema.fallback.title, name);
      assert.ok(schema.fallback.text.length > 20, name);
      assert.equal(schema.fallback.deeplink, DEEPLINK, name);
      assert.ok(Array.isArray(schema.body) && schema.body.length > 0, name);
    }
  });

  it("names the platform it cannot run on", () => {
    const schema = buildPanelSchema(states.unsupported);
    assert.match(JSON.stringify(schema), /win32/);
    assert.match(JSON.stringify(schema), /macOS only/);
  });

  it("shows progress while the model is downloading", () => {
    assert.match(JSON.stringify(buildPanelSchema(states.downloading)), /42%/);
  });

  it("offers the download when there is no model, and dispatches prepare", () => {
    const [node] = buildPanelSchema(states.missing).body;
    assert.equal(node.component, "emptyState");
    assert.equal(node.action.onPress.action, "prepare");
  });

  it("says why the last download failed instead of offering the same button silently", () => {
    const text = JSON.stringify(buildPanelSchema(states.failed));
    assert.match(text, /The download timed out/);
    assert.match(text, /prepare/);
  });

  it("says where the model is once it is ready", () => {
    assert.match(JSON.stringify(buildPanelSchema(READY)), /Application Support/);
  });

  it("stays far under the vocabulary ceilings", () => {
    for (const [name, status] of Object.entries(states)) {
      const schema = buildPanelSchema(status);
      assert.ok(JSON.stringify(schema).length < 4_000, `${name} schema was ${JSON.stringify(schema).length} bytes`);
    }
  });
});
