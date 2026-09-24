import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { compareCounts, countRatchetViolations, parseBaseline, serializeBaseline } from "./lint-ratchet.mjs";

const root = path.resolve("/repo");
const file = (rel) => path.join(root, ...rel.split("/"));

describe("lint ratchet", () => {
  it("counts only ade-ui rules, per repo-relative file", () => {
    const counts = countRatchetViolations(
      [
        {
          filePath: file("apps/desktop/src/renderer/b.tsx"),
          messages: [
            { ruleId: "ade-ui/no-raw-z-index" },
            { ruleId: "ade-ui/no-raw-z-index" },
            { ruleId: "react-hooks/exhaustive-deps" },
            { ruleId: null },
          ],
        },
        { filePath: file("apps/desktop/src/renderer/a.tsx"), messages: [{ ruleId: "ade-ui/no-fixed-overlay" }] },
        { filePath: file("apps/desktop/src/renderer/clean.tsx"), messages: [] },
      ],
      root,
    );
    assert.deepEqual(counts, {
      "apps/desktop/src/renderer/a.tsx": { "ade-ui/no-fixed-overlay": 1 },
      "apps/desktop/src/renderer/b.tsx": { "ade-ui/no-raw-z-index": 2 },
    });
    assert.deepEqual(Object.keys(counts), ["apps/desktop/src/renderer/a.tsx", "apps/desktop/src/renderer/b.tsx"]);
  });

  it("serializes stably and round-trips", () => {
    const text = serializeBaseline({ "z.tsx": { "ade-ui/b": 1, "ade-ui/a": 2 }, "a.tsx": { "ade-ui/a": 1 } });
    assert.equal(
      text,
      '{\n  "version": 1,\n  "files": {\n    "a.tsx": {\n      "ade-ui/a": 1\n    },\n    "z.tsx": {\n      "ade-ui/a": 2,\n      "ade-ui/b": 1\n    }\n  }\n}\n',
    );
    assert.deepEqual(parseBaseline(text), { "a.tsx": { "ade-ui/a": 1 }, "z.tsx": { "ade-ui/a": 2, "ade-ui/b": 1 } });
    assert.throws(() => parseBaseline("[]"));
  });

  it("fails on growth and on new files, reports drops without failing", () => {
    const baseline = { "a.tsx": { "ade-ui/x": 2, "ade-ui/y": 1 }, "gone.tsx": { "ade-ui/x": 3 } };
    const current = { "a.tsx": { "ade-ui/x": 3 }, "new.tsx": { "ade-ui/y": 1 } };
    const { grown, dropped } = compareCounts(baseline, current);
    assert.deepEqual(grown, [
      { file: "a.tsx", rule: "ade-ui/x", before: 2, after: 3 },
      { file: "new.tsx", rule: "ade-ui/y", before: 0, after: 1 },
    ]);
    // a.tsx/y 1→0 and gone.tsx/x 3→0.
    assert.equal(dropped, 4);
  });

  it("is clean when counts are equal or lower", () => {
    const { grown, dropped } = compareCounts({ "a.tsx": { "ade-ui/x": 2 } }, { "a.tsx": { "ade-ui/x": 1 } });
    assert.deepEqual(grown, []);
    assert.equal(dropped, 1);
  });
});
