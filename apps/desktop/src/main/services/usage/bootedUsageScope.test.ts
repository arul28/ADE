import { describe, expect, it } from "vitest";
import { bootedUsageScopeRoot } from "./bootedUsageScope";

describe("bootedUsageScopeRoot", () => {
  it("skips the dormant context and returns the first project that has a db", () => {
    expect(bootedUsageScopeRoot([
      { db: null, project: { rootPath: "" } },
      { db: {}, project: { rootPath: " /repo-one " } },
      { db: {}, project: { rootPath: "/repo-two" } },
    ])).toBe("/repo-one");
  });

  it("returns null when no project scope is booted", () => {
    expect(bootedUsageScopeRoot([
      { db: null, project: { rootPath: "" } },
    ])).toBeNull();
    expect(bootedUsageScopeRoot([])).toBeNull();
  });
});
