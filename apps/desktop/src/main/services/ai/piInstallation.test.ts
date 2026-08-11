import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiProfileInventory, resolvePiInstallation } from "./piInstallation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Pi profile with the given models.json providers and no stored auth. */
function profile(providers: Record<string, unknown>): ReturnType<typeof resolvePiInstallation> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-install-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers }));
  return resolvePiInstallation({ ...process.env, PI_CODING_AGENT_DIR: agentDir });
}

function providerById(installation: ReturnType<typeof resolvePiInstallation>, id: string) {
  return readPiProfileInventory(installation).providers.find((entry) => entry.id === id);
}

describe("Pi provider classification", () => {
  // LM Studio ships `apiKey: "lmstudio"` in models.json — a placeholder its
  // OpenAI-compatible endpoint requires and ignores. Reading that as a
  // credential classified a server the user runs as an API provider: ADE
  // offered to sign in to localhost and reported it connected on the strength
  // of a config file rather than a reachable server.
  it("treats a loopback provider as local even when it carries a placeholder key", () => {
    const installation = profile({
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        models: [{ id: "gemma-4" }],
      },
    });

    const lmstudio = providerById(installation, "lmstudio");
    expect(lmstudio?.authType).toBe("local");
    expect(lmstudio?.authMethods).toEqual(["local"]);
    expect(lmstudio?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("classifies every loopback spelling as local", () => {
    for (const baseUrl of [
      "http://localhost:1234/v1",
      "http://127.0.0.1:11434",
      "http://0.0.0.0:8080/v1",
      "http://[::1]:1234/v1",
    ]) {
      const installation = profile({ server: { baseUrl, apiKey: "placeholder" } });
      expect(providerById(installation, "server")?.authType).toBe("local");
    }
  });

  // A remote provider reached through a custom base URL is still remote, and
  // the user does have to authenticate to it.
  it("keeps a remote provider on a custom base URL an api-key provider", () => {
    const installation = profile({
      proxied: { baseUrl: "https://gateway.example.com/v1", apiKey: "sk-real-key" },
    });

    const proxied = providerById(installation, "proxied");
    expect(proxied?.authType).toBe("api-key");
    expect(proxied?.baseUrl).toBeUndefined();
  });

  it("leaves a provider with neither a key nor a base URL unclassified", () => {
    const installation = profile({ bare: { models: [{ id: "m" }] } });
    expect(providerById(installation, "bare")?.authType).toBeNull();
  });
});
