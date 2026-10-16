import { describe, expect, it } from "vitest";

import {
  buildThreadEntityLookup,
  findProseEntities,
  matchInlineCodeEntity,
  type ThreadEntity,
} from "./threadEntities";

const LANE_ID = "4c90a638-607c-45fd-80bf-11df1666b8a7";
const CHAT_ID = "6F595A93-991e-4b6d-bc42-40dc59425cbc";
// Two chats that share their first 8 characters: a prefix cannot pick one.
const TWIN_A = "aaaabbbb-0000-4000-8000-000000000001";
const TWIN_B = "aaaabbbb-0000-4000-8000-000000000002";

const lookup = buildThreadEntityLookup({
  lanes: [
    { id: LANE_ID, name: "opencode-harness-audit" },
    { id: "11111111-2222-4333-8444-555555555555", name: "main" },
  ],
  sessions: [{ id: CHAT_ID }, { id: TWIN_A }, { id: TWIN_B }],
  linearTeamKeys: ["ade"],
  skillNames: ["quality"],
});

/** A compact, comparable description of what a span became. */
function describeEntity(entity: ThreadEntity | null): string | null {
  if (!entity) return null;
  if (entity.type === "time") return `time:${entity.iso}${entity.endEpochMs ? `..${new Date(entity.endEpochMs).toISOString()}` : ""}`;
  if (entity.type === "file_line") return `file_line:${entity.path}:${entity.line}-${entity.endLine ?? ""}`;
  const { chip } = entity;
  const source = chip.source;
  const id = source.origin === "mention" ? `:${source.id}` : "";
  return `${chip.kind}:${chip.label}${id}`;
}

describe("matchInlineCodeEntity", () => {
  it.each([
    // Lanes resolve by exact name or id, and carry the lane's name.
    ["opencode-harness-audit", null, `lane:opencode-harness-audit:${LANE_ID}`],
    [LANE_ID.toUpperCase(), null, `lane:opencode-harness-audit:${LANE_ID}`],
    // A name that is also a git word never chips by name.
    ["main", null, null],
    // Chats match case-insensitively and keep the id as ADE stores it.
    [CHAT_ID.toLowerCase(), null, `chat:Chat 6F595A93:${CHAT_ID}`],
    ["6f595a93", null, `chat:Chat 6F595A93:${CHAT_ID}`],
    // An ambiguous prefix or an unknown id stays code.
    ["aaaabbbb", null, null],
    ["deadbeef-0000-4000-8000-000000000000", null, null],
    // An unresolved 8-hex id is not a commit; 7 or 9+ hex with a digit is.
    ["0a1b2c3d", null, null],
    ["f7e55f01b", null, "commit:f7e55f0"],
    ["deadbee", null, null],
    // Models by id show their display name only; a bare alias stays code.
    ["claude-opus-5-5", null, "model:Claude Opus 5.5"],
    ["opus", null, null],
    ["bypassPermissions", null, "permission:Bypass"],
    ["#1407", null, "pr:#1407"],
    // Linear ids need a known team key; skills need a known command.
    ["ADE-159", null, "linear_issue:ADE-159"],
    ["UTF-8", null, null],
    ["/quality", null, "skill:/quality"],
    ["/nope", null, null],
    // A bare line ref links only after a file in the same block.
    ["3461-3468", "agentChatService.ts", "file_line:agentChatService.ts:3461-3468"],
    [":201-208", "chatErrorPresentation.ts", "file_line:chatErrorPresentation.ts:201-208"],
    ["56576", null, null],
    ["3468-3461", "a.ts", null],
    // Zoned timestamps and same-day ranges; a range past midnight ends the next day.
    ["2026-10-01T02:24:04Z", null, "time:2026-10-01T02:24:04.000Z"],
    ["2026-10-01T01:52Z–02:24Z", null, "time:2026-10-01T01:52:00.000Z..2026-10-01T02:24:00.000Z"],
    ["2026-10-01T23:50Z-00:10Z", null, "time:2026-10-01T23:50:00.000Z..2026-10-02T00:10:00.000Z"],
    ["21:51:57", null, null],
    ["Exited with code 1", null, null],
  ])("%s (after file %s) → %s", (code, lastFilePath, expected) => {
    expect(describeEntity(matchInlineCodeEntity(code, lookup, { lastFilePath }))).toBe(expected);
  });
});

describe("findProseEntities", () => {
  it("finds only shapes that cannot be ordinary words, without overlaps", () => {
    const text = `Chat ${CHAT_ID} shipped PR #1407 and ADE-159 at 2026-10-01T02:24:04Z; `
      + "see #12 and UTF-8 and https://x.dev/ADE-159 and ade://lane/" + LANE_ID;
    const found = findProseEntities(text, lookup).map((match) => [
      text.slice(match.start, match.end),
      describeEntity(match.entity),
    ]);

    expect(found).toEqual([
      [CHAT_ID, `chat:Chat 6F595A93:${CHAT_ID}`],
      // Only the number chips; "PR " stays prose.
      ["#1407", "pr:#1407"],
      ["ADE-159", "linear_issue:ADE-159"],
      ["2026-10-01T02:24:04Z", "time:2026-10-01T02:24:04.000Z"],
      // A bare "#12" (no "PR") and a key inside a URL path stay prose.
      [`ade://lane/${LANE_ID}`, "lane:Lane 4c90a638"],
    ]);
    for (let index = 1; index < found.length; index += 1) {
      expect(text.indexOf(found[index]![0]!)).toBeGreaterThan(text.indexOf(found[index - 1]![0]!));
    }
  });

  it("returns nothing for prose with no ADE shapes", () => {
    expect(findProseEntities("The main lane is fine; opus 5 ran at 21:51:57.", lookup)).toEqual([]);
    expect(findProseEntities("", lookup)).toEqual([]);
    expect(findProseEntities(`unknown ${TWIN_A.replace("1", "9")}`, lookup)).toEqual([]);
  });
});
