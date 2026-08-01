import { describe, expect, it } from "vitest";
import {
  ACTIVITY_EVENT_BY_KIND,
  ACTIVITY_EVENT_CATALOG,
} from "./activityCatalog";
import {
  ATTENTION_EVENT_KINDS,
  BALANCED_ATTENTION_EVENT_POLICIES,
} from "./types/attention";

describe("Activity event catalog", () => {
  it("covers every Attention event kind exactly once", () => {
    const kinds = ACTIVITY_EVENT_CATALOG.map((descriptor) => descriptor.kind);
    expect(kinds).toHaveLength(11);
    expect(new Set(kinds).size).toBe(11);
    expect(kinds.slice().sort()).toEqual([...ATTENTION_EVENT_KINDS].sort());
    expect(Object.keys(ACTIVITY_EVENT_BY_KIND).sort()).toEqual([...ATTENTION_EVENT_KINDS].sort());
  });

  it("derives the balanced defaults from catalog policy", () => {
    expect(BALANCED_ATTENTION_EVENT_POLICIES).toEqual(Object.fromEntries(
      ACTIVITY_EVENT_CATALOG.map(({ kind, defaultPolicy }) => [kind, defaultPolicy]),
    ));
  });
});
