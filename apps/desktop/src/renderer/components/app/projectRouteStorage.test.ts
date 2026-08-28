import { describe, expect, it } from "vitest";

import { isProjectSurfacePathname } from "./projectRouteStorage";

describe("isProjectSurfacePathname", () => {
  it("includes plugin tabs so /plugin/<id> is a real project surface", () => {
    expect(isProjectSurfacePathname("/plugin/hn")).toBe(true);
    expect(isProjectSurfacePathname("/work")).toBe(true);
    expect(isProjectSurfacePathname("/plugins-dev")).toBe(false);
    expect(isProjectSurfacePathname("/marketplace")).toBe(false);
  });
});
