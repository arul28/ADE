import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadQwenUserSettings, parseQwenUserSettings } from "./qwenUserSettings";

describe("parseQwenUserSettings", () => {
  it("does not treat a settings file with only MCP servers as signed in", () => {
    expect(parseQwenUserSettings({
      mcpServers: { unityMCP: { url: "http://127.0.0.1:8080/mcp" } },
    })).toEqual({
      authenticated: false,
      models: [],
      defaultModelId: null,
      selectedType: null,
      baseUrlOrigin: null,
    });
  });

  it("reads a custom OpenAI provider the Qwen CLI saved, without returning the key", () => {
    const parsed = parseQwenUserSettings({
      env: { QWEN_CUSTOM_API_KEY_OPENAI_HTTP_LOCALHOST_8317: "dummy" },
      modelProviders: {
        openai: [{
          id: "gpt-5.5",
          name: "gpt-5.5",
          baseUrl: "http://localhost:8317/v1",
          envKey: "QWEN_CUSTOM_API_KEY_OPENAI_HTTP_LOCALHOST_8317",
        }],
      },
      security: { auth: { selectedType: "openai" } },
      model: { name: "gpt-5.5", baseUrl: "http://localhost:8317/v1" },
    });
    expect(parsed.authenticated).toBe(true);
    expect(parsed.defaultModelId).toBe("gpt-5.5");
    expect(parsed.models).toEqual([{ id: "gpt-5.5", displayName: "gpt-5.5" }]);
    expect(parsed.selectedType).toBe("openai");
    expect(parsed.baseUrlOrigin).toBe("http://localhost:8317");
    expect(JSON.stringify(parsed)).not.toMatch(/dummy/i);
  });

  it("reads JSONC text, keeps comment markers inside strings, and returns only the base URL's origin", () => {
    const parsed = parseQwenUserSettings([
      "// Qwen settings",
      "{",
      "  /* the proxy */",
      '  "model": { "name": "coder // plus", "baseUrl": "http://user:sk-secret@127.0.0.1:11434/v1?key=sk-query" },',
      '  "security": { "auth": { "selectedType": " qwen-oauth " } } // trailing',
      "}",
    ].join("\n"));
    expect(parsed.defaultModelId).toBe("coder // plus");
    expect(parsed.selectedType).toBe("qwen-oauth");
    expect(parsed.baseUrlOrigin).toBe("http://127.0.0.1:11434");
    expect(JSON.stringify(parsed)).not.toMatch(/secret|sk-query|\/v1/);
  });

  it("reads text that is not JSON as empty settings", () => {
    expect(parseQwenUserSettings("{ not json")).toEqual({
      authenticated: false,
      models: [],
      defaultModelId: null,
      selectedType: null,
      baseUrlOrigin: null,
    });
  });

  it("does not treat an OpenAI selection without a key as signed in", () => {
    expect(parseQwenUserSettings({
      security: { auth: { selectedType: "openai" } },
      model: { name: "coder-model", baseUrl: "https://openrouter.ai/api/v1" },
    }).authenticated).toBe(false);
  });
});

describe("loadQwenUserSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads settings.json from QWEN_HOME", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ade-qwen-settings-"));
    dirs.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "settings.json"), `// hand-edited\n${JSON.stringify({
      security: { auth: { selectedType: "openai", apiKey: "sk-test" } },
      model: { name: "gpt-5.5" },
    })}\n`);
    const loaded = await loadQwenUserSettings({ env: { QWEN_HOME: root } });
    expect(loaded.authenticated).toBe(true);
    expect(loaded.defaultModelId).toBe("gpt-5.5");
    expect(JSON.stringify(loaded)).not.toMatch(/sk-test/);
  });

  it("returns empty when the file is missing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ade-qwen-settings-missing-"));
    dirs.push(root);
    await expect(loadQwenUserSettings({ env: { QWEN_HOME: root } })).resolves.toEqual({
      authenticated: false,
      models: [],
      defaultModelId: null,
      selectedType: null,
      baseUrlOrigin: null,
    });
  });
});
