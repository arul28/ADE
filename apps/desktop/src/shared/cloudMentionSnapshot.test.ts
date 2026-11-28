import { describe, expect, it } from "vitest";
import { buildCloudMentionSnapshot, CLOUD_MENTION_SNAPSHOT_MAX_BYTES, readCloudMentionSnapshot } from "./cloudMentionSnapshot";
import type { ChatMentionSuggestion } from "./types/chatMentions";

const LANE = "5d1e8a3c-2b4f-4e6a-9c7d-1f0b3a5e8c21";
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("buildCloudMentionSnapshot", () => {
  // The account server refuses a body past its cap whole, so the copy must fit as UTF-8, whatever the names.
  it.each([
    ["ASCII file names", (index: number) => `src/components/feature-${index}/component-${index}.tsx`],
    ["multibyte file names", (index: number) => `文档/设计稿/页面-${index}/组件说明-${index}-最终版本.md`],
    ["emoji file names", (index: number) => `assets/🙂/${index}/🎉-${index}.png`],
  ])("fits the upload cap with %s, keeping the shallowest", (_label, pathOf) => {
    const files = Array.from({ length: 40_000 }, (_, index) => ({ path: pathOf(index), score: 1 }));
    const snapshot = buildCloudMentionSnapshot({ savedAt: 1, rows: [], files: { [LANE]: files } });
    expect(bytesOf(snapshot)).toBeLessThanOrEqual(CLOUD_MENTION_SNAPSHOT_MAX_BYTES);
    const lane = snapshot.files[LANE]!;
    expect(lane.truncated).toBe(true);
    expect(lane.files.length).toBeGreaterThan(1_000);
    expect(lane.files.slice(0, 2)).toEqual([pathOf(0), pathOf(1)]);
    // What the server reads back is the same copy.
    expect(readCloudMentionSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("keeps every row and name when the whole copy fits, however they split", () => {
    const long = "界".repeat(290);
    const rows: ChatMentionSuggestion[] = Array.from({ length: 250 }, (_, index) => ({ kind: "chat" as const, id: `chat-${index}`, title: long, subtitle: long }));
    const other = "8b2f4c1d-6e3a-4f5b-a7c9-2d0e1f3a4b56";
    const big = Array.from({ length: 6_000 }, (_, index) => ({ path: `src/feature-${index}/component-${index}.tsx`, score: 1 }));
    const snapshot = buildCloudMentionSnapshot({ savedAt: 1, rows, files: { [LANE]: big, [other]: [{ path: "README.md", score: 1 }] } });
    expect(bytesOf(snapshot)).toBeLessThanOrEqual(CLOUD_MENTION_SNAPSHOT_MAX_BYTES);
    expect(snapshot.rows).toHaveLength(250);
    expect(snapshot.files[LANE]).toMatchObject({ truncated: false });
    expect(snapshot.files[LANE]!.files).toHaveLength(6_000);
    expect(snapshot.files[other]!.files).toEqual(["README.md"]);
  });

  it("trims rows past the cap fairly, every kind taking turns, and keeps the files", () => {
    const long = "界".repeat(290);
    const rows: ChatMentionSuggestion[] = [
      ...Array.from({ length: 500 }, (_, index) => ({ kind: "chat" as const, id: `chat-${index}`, title: long, subtitle: long })),
      ...Array.from({ length: 500 }, (_, index) => ({ kind: "terminal" as const, id: `term-${index}`, title: long, subtitle: long })),
      { kind: "lane", id: LANE, title: "upload-fix" },
    ];
    const snapshot = buildCloudMentionSnapshot({ savedAt: 1, rows, files: { [LANE]: [{ path: "src/app.ts", score: 1 }] } });
    expect(bytesOf(snapshot)).toBeLessThanOrEqual(CLOUD_MENTION_SNAPSHOT_MAX_BYTES);
    const kinds = snapshot.rows.map((row) => row.kind);
    expect(kinds).toContain("lane");
    expect(Math.abs(kinds.filter((kind) => kind === "chat").length - kinds.filter((kind) => kind === "terminal").length)).toBeLessThanOrEqual(1);
    expect(snapshot.rows.length).toBeLessThan(rows.length);
    expect(snapshot.files[LANE]!.files).toEqual(["src/app.ts"]);
  });
});
