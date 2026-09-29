import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDynamicOpenCodeModelDescriptor,
  getDynamicOpenCodeModelDescriptors,
  replaceDynamicOpenCodeModelDescriptors,
} from "../../../shared/modelRegistry";
import { describe, expect, it } from "vitest";
import {
  __setOpenCodeInventoryPersistencePathForTests,
  classifyOpenCodeVariants,
  clearOpenCodeInventoryCache,
  peekOpenCodeInventoryCache,
} from "./openCodeInventory";

describe("OpenCode provider inventory", () => {
  it("maps OpenCode 2.0 model variants to ADE effort and service tiers", () => {
    const variants = classifyOpenCodeVariants({
      variants: [
        { id: "default" },
        { id: "medium" },
        { id: "xhigh" },
        { id: "high-fast" },
        { id: "fast" },
        { id: "free" },
        { id: "budget" },
      ],
    });

    expect(variants).toEqual({
      reasoningTiers: ["medium", "xhigh", "free", "budget"],
      serviceTiers: ["fast"],
      variantKeys: {},
      fastVariantKeys: { high: "high-fast" },
    });
    expect(classifyOpenCodeVariants({}).reasoningTiers).toEqual([]);
    expect(classifyOpenCodeVariants({ variants: [{ id: "default" }] }).serviceTiers).toEqual([]);
  });

  it("hydrates selectable descriptors from the project's persisted inventory after another project replaces the registry", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-inventory-"));
    const cachePath = path.join(tempDir, "inventory.json");
    const projectRoot = path.join(tempDir, "project");
    const projectConfig = {};
    const previousDescriptors = getDynamicOpenCodeModelDescriptors();
    const projectDescriptor = createDynamicOpenCodeModelDescriptor("", {
      displayName: "Project inventory GPT",
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
      openCodeProviderId: "openai",
      openCodeModelId: "gpt-5.4",
    });
    const otherProjectDescriptor = createDynamicOpenCodeModelDescriptor("", {
      displayName: "Other project's GPT",
      capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
      openCodeProviderId: "openai",
      openCodeModelId: "gpt-5.4",
    });
    const fingerprintInput = {
      apiKeys: {},
      customModelSlugs: [],
      customProviders: [],
      discoveredModels: [],
      localProviders: {},
      storedKeys: [],
    };
    const configFingerprint = createHash("sha256")
      .update(JSON.stringify(fingerprintInput))
      .digest("hex");

    try {
      __setOpenCodeInventoryPersistencePathForTests(cachePath);
      fs.writeFileSync(cachePath, JSON.stringify({
        version: 2,
        entries: {
          [projectRoot]: {
            savedAt: Date.now(),
            configFingerprint,
            passiveConfigFingerprint: configFingerprint,
            stale: false,
            modelIds: [projectDescriptor.id],
            providers: [{ id: "openai", name: "OpenAI", connected: true, modelCount: 1, availableModelCount: 1 }],
            registryDescriptors: [projectDescriptor],
            authMethods: {},
          },
        },
      }), "utf8");
      replaceDynamicOpenCodeModelDescriptors([otherProjectDescriptor]);

      const inventory = peekOpenCodeInventoryCache({ projectRoot, projectConfig });

      expect(inventory?.modelIds).toEqual([projectDescriptor.id]);
      expect(inventory?.descriptors).toEqual([projectDescriptor]);
      expect(inventory?.descriptors[0]?.displayName).toBe("Project inventory GPT");
      expect(inventory?.descriptors[0]?.capabilities.reasoning).toBe(false);
    } finally {
      clearOpenCodeInventoryCache();
      replaceDynamicOpenCodeModelDescriptors(previousDescriptors);
      __setOpenCodeInventoryPersistencePathForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
