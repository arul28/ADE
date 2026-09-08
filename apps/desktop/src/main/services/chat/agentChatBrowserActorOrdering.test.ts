import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `agentChatService` keeps a synchronous `issueSync` fork of the browser
 * capability issuer so an Electron-hosted agent launch gains no suspension
 * point. The price is an ordering rule the type system cannot state: on a
 * daemon-hosted chat the token only exists after
 * `prepareBrowserActorCapability(managed)` has been awaited, so every
 * `buildAgentRuntimeEnv(managed)` call site needs that preamble.
 *
 * Forgetting it is silent — the env just ships without
 * `ADE_BROWSER_ACTOR_TOKEN` and `ade browser` reports "no capability" from
 * inside the agent. This test is the enforcement the fork owes.
 */
describe("agent chat browser actor capability ordering", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "agentChatService.ts"),
    "utf8",
  );

  const countOf = (pattern: RegExp): number => (source.match(pattern) ?? []).length;

  it("pairs every runtime-env build with a capability preamble", () => {
    const envBuilds = countOf(/buildAgentRuntimeEnv\(managed\)/g);
    // One per launch path, plus the definition line itself is not matched
    // because it reads `(managed: ManagedChatSession)`.
    const preambles = countOf(/prepareBrowserActorCapability\(managed\)/g);
    expect(envBuilds).toBeGreaterThan(0);
    expect(preambles).toBeGreaterThanOrEqual(envBuilds);
  });

  it("awaits the preamble everywhere it is used", () => {
    const preambleSites = [
      ...source.matchAll(/const (\w+) = prepareBrowserActorCapability\(managed\);\n(.*)/g),
    ];
    expect(preambleSites.length).toBeGreaterThan(0);
    for (const [, binding, nextLine] of preambleSites) {
      expect(nextLine).toContain(`if (${binding}) await ${binding};`);
    }
  });
});
