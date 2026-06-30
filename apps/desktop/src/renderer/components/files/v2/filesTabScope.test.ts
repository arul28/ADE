// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { getFilesTabScope, setFilesTabScope } from "./filesTabScope";

describe("filesTabScope", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to all lanes", () => {
    expect(getFilesTabScope("/tmp/project")).toBe("all");
  });

  it("persists scope per project", () => {
    setFilesTabScope("/tmp/project-a", "lane");
    expect(getFilesTabScope("/tmp/project-a")).toBe("lane");
    expect(getFilesTabScope("/tmp/project-b")).toBe("all");
  });
});
