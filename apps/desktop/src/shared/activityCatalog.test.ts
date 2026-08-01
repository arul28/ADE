import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_EVENT_BY_KIND,
  ACTIVITY_EVENT_CATALOG,
  type ActivityEventGroup,
} from "./activityCatalog";
import {
  ATTENTION_EVENT_KINDS,
  BALANCED_ATTENTION_EVENT_POLICIES,
  type AttentionDeliveryPolicy,
  type AttentionEventKind,
} from "./types/attention";

type RawActivityEventDescriptor = {
  kind: AttentionEventKind;
  group: ActivityEventGroup;
  defaultPolicy: AttentionDeliveryPolicy;
};

const RAW_ACTIVITY_EVENT_KINDS = JSON.parse(
  readFileSync(new URL("./activityEventKinds.json", import.meta.url), "utf8"),
) as RawActivityEventDescriptor[];

describe("Activity event catalog", () => {
  it("matches the ordered cross-platform JSON contract", () => {
    expect(ACTIVITY_EVENT_CATALOG.map(({ kind, group, defaultPolicy }) => ({
      kind,
      group,
      defaultPolicy,
    }))).toEqual(RAW_ACTIVITY_EVENT_KINDS);
  });

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
