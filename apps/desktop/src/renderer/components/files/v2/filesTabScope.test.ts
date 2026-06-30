// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadScopeModule() {
  vi.resetModules();
  return import("./filesTabScope");
}

describe("filesTabScope", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to all lanes", async () => {
    const { getFilesTabScope } = await loadScopeModule();
    expect(getFilesTabScope("/tmp/project")).toBe("all");
  });

  it("persists scope per project", async () => {
    const { getFilesTabScope, setFilesTabScope } = await loadScopeModule();
    setFilesTabScope("/tmp/project-a", "lane");
    expect(getFilesTabScope("/tmp/project-a")).toBe("lane");
    expect(getFilesTabScope("/tmp/project-b")).toBe("all");

    const reloaded = await loadScopeModule();
    expect(reloaded.getFilesTabScope("/tmp/project-a")).toBe("lane");
    expect(reloaded.getFilesTabScope("/tmp/project-b")).toBe("all");
  });
});
