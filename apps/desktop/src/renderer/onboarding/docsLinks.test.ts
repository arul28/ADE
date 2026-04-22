import { describe, it, expect } from "vitest";
import { docs, DOCS_HOME } from "./docsLinks";

const EXPECTED_DOCS = {
  home: "https://www.ade-app.dev/docs",
  welcome: "https://www.ade-app.dev/docs/welcome",
  lanesCreating: "https://www.ade-app.dev/docs/lanes/creating",
  lanesStacks: "https://www.ade-app.dev/docs/lanes/stacks",
  lanesPacks: "https://www.ade-app.dev/docs/lanes/packs",
  lanesEnvironment: "https://www.ade-app.dev/docs/lanes/environment",
  chatOverview: "https://www.ade-app.dev/docs/chat/overview",
  chatContext: "https://www.ade-app.dev/docs/chat/context",
  chatCapabilities: "https://www.ade-app.dev/docs/chat/capabilities",
  terminals: "https://www.ade-app.dev/docs/tools/terminals",
  filesEditor: "https://www.ade-app.dev/docs/tools/files-editor",
  multiAgentSetup: "https://www.ade-app.dev/docs/guides/multi-agent-setup",
} as const;

describe("docsLinks", () => {
  it("every URL is under ade-app.dev", () => {
    for (const [key, url] of Object.entries(docs)) {
      expect(url, key).toMatch(/^https:\/\/www\.ade-app\.dev(\/|$)/);
    }
  });

  it("home points at the docs root", () => {
    expect(docs.home).toBe("https://www.ade-app.dev/docs");
    expect(DOCS_HOME).toBe(docs.home);
  });

  it("canonical docs entries point at their expected routes", () => {
    for (const key of Object.keys(EXPECTED_DOCS) as Array<keyof typeof EXPECTED_DOCS>) {
      expect(docs[key], key).toBe(EXPECTED_DOCS[key]);
    }
  });

  it("all values are non-empty strings", () => {
    const values = Object.values(docs);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v.length).toBeGreaterThan(0);
  });

  it("every key is unique", () => {
    const keys = Object.keys(docs);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
