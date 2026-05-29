import { describe, expect, it } from "vitest";

import {
  linearIngressKindFromParts,
  normalizeLinearIngressEventKind,
} from "./types/linearSync";

describe("linear ingress event kind normalization", () => {
  it("derives desktop entity and action fields from iOS kind-only records", () => {
    expect(normalizeLinearIngressEventKind({
      kind: "issue.created",
      entityType: null,
      action: null,
    })).toEqual({
      kind: "issue.created",
      entityType: "issue",
      action: "create",
    });
  });

  it("keeps explicit desktop entity/action fields authoritative", () => {
    expect(normalizeLinearIngressEventKind({
      kind: "issue.created",
      entityType: "Issue",
      action: "update",
    })).toEqual({
      kind: "issue.created",
      entityType: "Issue",
      action: "update",
    });
  });

  it("builds a kind string when desktop records omit one", () => {
    expect(linearIngressKindFromParts("issue", "updated")).toBe("issue.update");
    expect(normalizeLinearIngressEventKind({
      kind: null,
      entityType: "issue",
      action: "remove",
    })).toEqual({
      kind: "issue.remove",
      entityType: "issue",
      action: "remove",
    });
  });
});
