import { describe, expect, it } from "vitest";

import {
  MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES,
  MAX_PLUGIN_SESSION_ENV_KEYS,
  MAX_PLUGIN_SESSION_ENV_VALUE_BYTES,
  parsePluginSessionSetup,
  PLUGIN_SESSION_CONTEXT_FILE_ENV,
  PLUGIN_SESSION_SOURCE_ENV,
} from "./sessionSetup";

describe("parsePluginSessionSetup", () => {
  it("accepts prefixed keys and a context file", () => {
    const parsed = parsePluginSessionSetup({
      env: { ADE_PLUGIN_JIRA_ISSUE_KEYS: "ENG-1,ENG-2" },
      contextFile: { name: "jira-issues.json", content: "{}" },
    });
    expect(parsed).toEqual({
      env: { ADE_PLUGIN_JIRA_ISSUE_KEYS: "ENG-1,ENG-2" },
      contextFile: { name: "jira-issues.json", content: "{}" },
      pluginId: null,
    });
  });

  it("returns null when nothing was asked for", () => {
    expect(parsePluginSessionSetup(undefined)).toBeNull();
    expect(parsePluginSessionSetup(null)).toBeNull();
    expect(parsePluginSessionSetup({})).toBeNull();
    expect(parsePluginSessionSetup({ env: {} })).toBeNull();
  });

  it("takes the plugin id from the host, never from the request", () => {
    const parsed = parsePluginSessionSetup(
      { env: { ADE_PLUGIN_X: "1" }, pluginId: "ade-linear" },
      { pluginId: "ade-jira" },
    );
    expect(parsed?.pluginId).toBe("ade-jira");
  });

  it("has no plugin id when the host establishes none", () => {
    const parsed = parsePluginSessionSetup({ env: { ADE_PLUGIN_X: "1" }, pluginId: "ade-linear" });
    expect(parsed?.pluginId).toBeNull();
  });

  // --------------------------------------------------------------------------
  // The key policy: prefix enforced, shadowing refused
  // --------------------------------------------------------------------------

  it.each([
    ["PATH", "/evil/bin"],
    ["HOME", "/evil"],
    ["ANTHROPIC_API_KEY", "sk-evil"],
    ["ADE_LANE_ID", "lane-evil"],
    ["ADE_CHAT_SESSION_ID", "chat-evil"],
    ["ADE_LINEAR_CONTEXT_FILE", "/evil/linear.json"],
    ["ade_plugin_lowercase", "1"],
    ["ADE_PLUGIN_", "1"],
    ["ADE_PLUGIN_bad-char", "1"],
  ])("refuses the unprefixed or malformed key %s", (key, value) => {
    expect(() => parsePluginSessionSetup({ env: { [key]: value } }))
      .toThrow(/is not allowed/u);
  });

  it("refuses the ADE_PLUGIN_* names the host owns", () => {
    for (const key of [
      PLUGIN_SESSION_CONTEXT_FILE_ENV,
      PLUGIN_SESSION_SOURCE_ENV,
      "ADE_PLUGIN_ID",
      "ADE_PLUGIN_ROOT",
    ]) {
      expect(() => parsePluginSessionSetup({ env: { [key]: "x" } }))
        .toThrow(/set by ADE and cannot be overridden/u);
    }
  });

  it("refuses a key the host already sets, even one this file does not list", () => {
    expect(() => parsePluginSessionSetup(
      { env: { ADE_PLUGIN_FUTURE_HOST_VAR: "x" } },
      { hostEnvKeys: ["ADE_PLUGIN_FUTURE_HOST_VAR"] },
    )).toThrow(/set by ADE and cannot be overridden/u);
  });

  it("compares host keys case-insensitively, because Windows env blocks are", () => {
    // `ade_plugin_id` and `ADE_PLUGIN_ID` are one variable on Windows, so a
    // case-only difference must not open a shadowing hole there.
    expect(() => parsePluginSessionSetup(
      { env: { ADE_PLUGIN_HOST_OWNED: "x" } },
      { hostEnvKeys: ["ade_plugin_host_owned"] },
    )).toThrow(/set by ADE and cannot be overridden/u);
  });

  // --------------------------------------------------------------------------
  // Caps
  // --------------------------------------------------------------------------

  it("caps the number of variables", () => {
    const env: Record<string, string> = {};
    for (let index = 0; index <= MAX_PLUGIN_SESSION_ENV_KEYS; index += 1) {
      env[`ADE_PLUGIN_K${index}`] = "v";
    }
    expect(() => parsePluginSessionSetup({ env })).toThrow(/at most 16 variables/u);
  });

  it("caps one value at 4 KiB", () => {
    const value = "x".repeat(MAX_PLUGIN_SESSION_ENV_VALUE_BYTES + 1);
    expect(() => parsePluginSessionSetup({ env: { ADE_PLUGIN_BIG: value } }))
      .toThrow(/the limit is 4096/u);
  });

  it("measures the value cap in UTF-8 bytes, not characters", () => {
    // A multi-byte character that fits by character count and not by bytes.
    const value = "é".repeat(MAX_PLUGIN_SESSION_ENV_VALUE_BYTES - 1);
    expect(() => parsePluginSessionSetup({ env: { ADE_PLUGIN_BIG: value } }))
      .toThrow(/the limit is 4096/u);
  });

  it("refuses a NUL byte in a value", () => {
    expect(() => parsePluginSessionSetup({ env: { ADE_PLUGIN_X: "a\0b" } }))
      .toThrow(/NUL byte/u);
  });

  it("refuses a non-string value", () => {
    expect(() => parsePluginSessionSetup({ env: { ADE_PLUGIN_X: 1 } }))
      .toThrow(/must be a string/u);
  });

  it("caps the context file at 256 KiB", () => {
    expect(() => parsePluginSessionSetup({
      contextFile: { name: "big.json", content: "x".repeat(MAX_PLUGIN_SESSION_CONTEXT_FILE_BYTES + 1) },
    })).toThrow(/the limit is 262144/u);
  });

  // --------------------------------------------------------------------------
  // Context file names
  // --------------------------------------------------------------------------

  it.each([
    "../escape.json",
    "nested/file.json",
    "nested\\file.json",
    "/absolute.json",
    ".hidden",
    "..",
    "",
    "a".repeat(65),
  ])("refuses the context file name %j", (name) => {
    expect(() => parsePluginSessionSetup({ contextFile: { name, content: "{}" } }))
      .toThrow(/is not allowed/u);
  });

  it("refuses a non-string context file body", () => {
    expect(() => parsePluginSessionSetup({ contextFile: { name: "a.json", content: { a: 1 } } }))
      .toThrow(/must be a string/u);
  });

  it("refuses a setup that is not an object", () => {
    expect(() => parsePluginSessionSetup("env=1")).toThrow(/must be an object/u);
    expect(() => parsePluginSessionSetup({ env: [] })).toThrow(/must be an object/u);
  });
});
