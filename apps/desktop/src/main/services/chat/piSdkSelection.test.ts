import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PI_FALLBACK_THINKING_LEVEL,
  createPiReadOnlySettingsStorage,
  createPiSettingsManager,
  piDefaultThinkingLevel,
  resolvePiExactModel,
} from "./piSdkSelection";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function agentDir(settings?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-selection-"));
  roots.push(root);
  if (settings) fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(settings));
  return root;
}

describe("Pi settings never written from ADE", () => {
  it("hands Pi the user's settings and drops every write", () => {
    const dir = agentDir({ defaultThinkingLevel: "low", defaultModel: "mine" });
    const before = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
    const storage = createPiReadOnlySettingsStorage(dir);

    let seen: string | undefined;
    storage.withLock("global", (current) => {
      seen = current;
      // What Pi's `setThinkingLevel` → `setDefaultThinkingLevel` → save() asks for.
      return JSON.stringify({ defaultThinkingLevel: "xhigh", defaultModel: "picked-in-ade" });
    });

    expect(JSON.parse(seen!)).toEqual({ defaultThinkingLevel: "low", defaultModel: "mine" });
    expect(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).toBe(before);
    // Pi's lock is a directory beside the file; a reader must not create one.
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("creates nothing when the user has no settings file, and never reads the checkout", () => {
    const dir = agentDir();
    const storage = createPiReadOnlySettingsStorage(dir);
    const global = vi.fn(() => "{\"defaultThinkingLevel\":\"high\"}");
    const project = vi.fn(() => "{}");
    storage.withLock("global", global);
    storage.withLock("project", project);
    expect(global).toHaveBeenCalledWith(undefined);
    expect(project).toHaveBeenCalledWith(undefined);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("builds the session's settings manager on that storage, project untrusted", () => {
    const dir = agentDir();
    const fromStorage = vi.fn(() => ({ getDefaultThinkingLevel: () => undefined }));
    const create = vi.fn();
    class SettingsManager {
      static fromStorage = fromStorage;
      static create = create;
    }
    const manager = createPiSettingsManager(SettingsManager, "/repo", dir);
    expect(manager).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(fromStorage).toHaveBeenCalledTimes(1);
    const [storage, options] = fromStorage.mock.calls[0] as unknown as [{ withLock: unknown }, unknown];
    expect(typeof storage.withLock).toBe("function");
    expect(options).toEqual({ projectTrusted: false });
  });

  it("disarms the default setters on a Pi build that cannot take a storage backend", () => {
    const writes: string[] = [];
    const created = {
      setDefaultThinkingLevel: (level: string) => writes.push(`thinking:${level}`),
      setDefaultModelAndProvider: (provider: string, id: string) => writes.push(`model:${provider}/${id}`),
      getShellPath: () => "/bin/zsh",
    };
    const create = vi.fn(() => created);
    class SettingsManager {
      static create = create;
    }
    const manager = createPiSettingsManager(SettingsManager, "/repo", "/agent");
    expect(create).toHaveBeenCalledWith("/repo", "/agent", { projectTrusted: false });
    (manager!.setDefaultThinkingLevel as (level: string) => void)("high");
    (manager!.setDefaultModelAndProvider as (provider: string, id: string) => void)("openai", "gpt-5");
    expect(writes).toEqual([]);
    // Everything else the worker reads stays Pi's.
    expect((manager!.getShellPath as () => string)()).toBe("/bin/zsh");
  });
});

describe("Pi's default thinking level", () => {
  it("is the user's configured default, else Pi's own", () => {
    expect(piDefaultThinkingLevel({ getDefaultThinkingLevel: () => "low" })).toBe("low");
    expect(piDefaultThinkingLevel({ getDefaultThinkingLevel: () => undefined })).toBe(PI_FALLBACK_THINKING_LEVEL);
    expect(piDefaultThinkingLevel({ getDefaultThinkingLevel: () => "turbo" })).toBe(PI_FALLBACK_THINKING_LEVEL);
    expect(piDefaultThinkingLevel(null)).toBe(PI_FALLBACK_THINKING_LEVEL);
  });
});

describe("resolvePiExactModel", () => {
  const catalog = [
    { provider: "openai", id: "gpt-5-mini" },
    { provider: "openai", id: "gpt-5.1" },
    { provider: "openrouter", id: "gpt-5" },
  ];
  const runtime = {
    getModel: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
    getModels: (provider?: string) => catalog.filter((model) => !provider || model.provider === provider),
  };

  it("returns exactly the provider and model picked", async () => {
    await expect(resolvePiExactModel(runtime, { provider: "openrouter", id: "gpt-5" }))
      .resolves.toEqual({ provider: "openrouter", id: "gpt-5" });
  });

  // Pi's CLI resolver would take "gpt-5" to a neighbour (a prefix match, or the
  // same id on another provider) and run that instead.
  it("fails with the reason instead of running a neighbour or guessing", async () => {
    await expect(resolvePiExactModel(runtime, { provider: "openai", id: "gpt-5" }))
      .rejects.toThrow(/Pi model "openai\/gpt-5" is unavailable: Pi's "openai" provider has no model "gpt-5"/u);
    await expect(resolvePiExactModel(runtime, "anthropic/claude-opus"))
      .rejects.toThrow(/Pi has no provider "anthropic"/u);
    // A lookup that answers with a different model.
    await expect(resolvePiExactModel({ getModel: () => ({ provider: "openai", id: "gpt-5-mini" }) }, { provider: "openai", id: "gpt-5" }))
      .rejects.toThrow(/unavailable/u);
    // A Pi build with no exact lookup.
    await expect(resolvePiExactModel({}, { provider: "openai", id: "gpt-5" })).rejects.toThrow(/no exact model lookup/u);
  });
});
