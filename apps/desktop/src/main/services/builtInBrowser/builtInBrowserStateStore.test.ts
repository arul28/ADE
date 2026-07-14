import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltInBrowserStateStore } from "./builtInBrowserStateStore";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function statePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-state-"));
  tempDirs.push(dir);
  return path.join(dir, "browser-state.json");
}

describe("builtInBrowserStateStore", () => {
  it("persists bounded project tab URLs and restores the active index", async () => {
    const filePath = statePath();
    const store = createBuiltInBrowserStateStore({ filePath });
    store.record("project-0123456789abcdef", {
      tabs: [
        { url: "https://github.com/login" },
        { url: "https://console.aws.amazon.com/" },
        { url: "file:///tmp/secret" },
      ],
      activeIndex: 1,
    });
    await store.flush();

    const restored = createBuiltInBrowserStateStore({ filePath }).restore("project-0123456789abcdef");
    expect(restored).toEqual({
      tabs: [
        { url: "https://github.com/login" },
        { url: "https://console.aws.amazon.com/" },
      ],
      activeIndex: 1,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("persists an unscoped window collection without accepting agent ownership or session data", async () => {
    const filePath = statePath();
    const store = createBuiltInBrowserStateStore({ filePath });
    store.record("window", {
      tabs: [{ url: "about:blank" }, { url: "https://example.test" }],
      activeIndex: 0,
    });
    await store.flush();

    expect(store.restore("window")).toEqual({
      tabs: [{ url: "about:blank" }, { url: "https://example.test/" }],
      activeIndex: 0,
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      collections: {
        window: expect.objectContaining({
          tabs: [{ url: "about:blank" }, { url: "https://example.test/" }],
          activeIndex: 0,
        }),
      },
    });
  });

  it("ignores malformed persisted state", () => {
    const filePath = statePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");

    expect(createBuiltInBrowserStateStore({ filePath }).restore("personal")).toBeNull();
  });
});
