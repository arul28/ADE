import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildAncestry } from "./childAncestry";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A world of chats: `parents` is each live chat's own parent, `live` the chats
 * that take reports, `ctos` the CTO threads, `deleted` the chats deleted (with
 * their parent and how many days ago).
 */
function world(spec: {
  parents: Record<string, string>;
  live: string[];
  ctos?: string[];
  deleted: Array<{ id: string; parent: string; title: string; daysAgo: number }>;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ancestry-"));
  dirs.push(dir);
  let clock = 1_000 * DAY;
  const ancestry = createChildAncestry({
    linksFilePath: path.join(dir, "cache", "deleted-parent-links.json"),
    takesReports: (id) => spec.live.includes(id),
    ownParentOf: (id) => spec.parents[id] ?? "",
    titleOf: () => "",
    ctoCandidates: () => spec.ctos ?? [],
    logger: { warn: () => {} },
    now: () => clock,
  });
  // Deleted oldest first, each at its own time, as deletes happen.
  for (const entry of [...spec.deleted].sort((a, b) => b.daysAgo - a.daysAgo)) {
    clock = 1_000 * DAY - entry.daysAgo * DAY;
    ancestry.rememberDeleted(entry.id, entry.parent, entry.title);
  }
  clock = 1_000 * DAY;
  return ancestry;
}

type Row = {
  name: string;
  spec: Parameters<typeof world>[0];
  expected: { sessionId: string; goneTitle: string } | null;
};

describe("childAncestry.nearestLiveAncestor", () => {
  it.each<Row>([
    {
      name: "walks past a deleted chain to the nearest live chat, naming the deleted parent",
      spec: {
        parents: { child: "mid" },
        live: ["top"],
        ctos: ["cto"],
        deleted: [
          { id: "mid", parent: "upper", title: "Middle", daysAgo: 1 },
          { id: "upper", parent: "top", title: "Upper", daysAgo: 2 },
        ],
      },
      expected: { sessionId: "top", goneTitle: "Middle" },
    },
    {
      name: "skips a put-away ancestor and reaches the live one above it",
      spec: {
        parents: { archived: "top" },
        live: ["top"],
        deleted: [{ id: "mid", parent: "archived", title: "Middle", daysAgo: 1 }],
      },
      expected: { sessionId: "top", goneTitle: "Middle" },
    },
    {
      name: "falls back to the CTO when nothing above is live",
      spec: {
        parents: {},
        live: ["cto"],
        ctos: ["cto"],
        deleted: [{ id: "mid", parent: "", title: "Top-level chat", daysAgo: 1 }],
      },
      expected: { sessionId: "cto", goneTitle: "Top-level chat" },
    },
    {
      name: "never picks a CTO that sits below the child (they would wake each other forever)",
      spec: {
        parents: { "cto-below": "child", "child": "mid" },
        live: ["cto-below", "cto-ok"],
        ctos: ["cto-below", "cto-ok"],
        deleted: [{ id: "mid", parent: "", title: "Gone", daysAgo: 1 }],
      },
      expected: { sessionId: "cto-ok", goneTitle: "Gone" },
    },
    {
      name: "never picks an ancestor that was re-parented under the child since",
      spec: {
        parents: { grand: "child" },
        live: ["grand", "cto"],
        ctos: ["cto"],
        deleted: [{ id: "mid", parent: "grand", title: "Middle", daysAgo: 1 }],
      },
      expected: { sessionId: "cto", goneTitle: "Middle" },
    },
    {
      name: "ignores an expired link at once, instead of following it until the next delete",
      spec: {
        parents: {},
        live: ["top"],
        ctos: [],
        deleted: [{ id: "mid", parent: "top", title: "Old", daysAgo: 91 }],
      },
      expected: null,
    },
    {
      name: "ends on a loop of deleted links with nobody to report to",
      spec: {
        parents: {},
        live: [],
        ctos: [],
        deleted: [
          { id: "mid", parent: "loop", title: "A", daysAgo: 1 },
          { id: "loop", parent: "mid", title: "B", daysAgo: 1 },
        ],
      },
      expected: null,
    },
  ])("$name", ({ spec, expected }) => {
    expect(world(spec).nearestLiveAncestor("mid", "child")).toEqual(expected);
  });
});
