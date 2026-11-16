import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurationShardSequencer } from "./test-shards.mjs";

// Stands in for Vitest's BaseSequencer: it only stores the context.
class FakeBaseSequencer {
  constructor(ctx) {
    this.ctx = ctx;
  }
}

const ROOT = path.resolve("/repo/apps/pkg");
const project = (name) => ({ getName: () => name });
const MAIN = project("unit-main");
const RENDERER = project("unit-renderer");

/** 40 files in one project, plus 5 of them again in a second project. */
function allSpecs() {
  const specs = [];
  for (let i = 0; i < 40; i += 1) specs.push([MAIN, path.join(ROOT, "src", `file${i}.test.ts`)]);
  for (let i = 0; i < 5; i += 1) specs.push([RENDERER, path.join(ROOT, "src", `file${i}.test.ts`)]);
  return specs;
}

/** A different order of the same specs for each shard process. */
function reordered(specs, seed) {
  return specs
    .map((spec, i) => ({ spec, rank: (i * 7919 + seed * 104729) % 1009 }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.spec);
}

async function runAllShards(count, durationsFile) {
  const Sequencer = createDurationShardSequencer(FakeBaseSequencer, { durationsFile, perFileMs: 300 });
  const parts = [];
  for (let index = 1; index <= count; index += 1) {
    const sequencer = new Sequencer({ config: { root: ROOT, shard: { index, count } } });
    parts.push(await sequencer.shard(reordered(allSpecs(), index)));
  }
  return parts;
}

const specKey = ([proj, file]) => `${proj.getName()} ${file}`;

function durationsFileWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-shards-"));
  const file = path.join(dir, "vitest.durations.json");
  if (content !== null) fs.writeFileSync(file, content);
  return file;
}

// Recorded durations for half the files only, one unusable value, and one
// file that no longer exists: a stale durations file.
const STALE = JSON.stringify({
  files: {
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/file${i}.test.ts`, (i + 1) * 900])),
    "src/file3.test.ts": "slow",
    "src/deleted.test.ts": 60_000,
  },
});

for (const [name, content] of [
  ["a stale durations file", STALE],
  ["a corrupt durations file", "{ not json"],
  ["no durations file", null],
]) {
  test(`every test file runs in exactly one shard with ${name}`, async () => {
    const durationsFile = durationsFileWith(content);
    const expected = allSpecs().map(specKey).sort();
    for (const count of [1, 2, 3, 8, 50]) {
      const parts = await runAllShards(count, durationsFile);
      const ran = parts.flat().map(specKey).sort();
      assert.deepEqual(ran, expected, `${count} shards must run each spec once`);
      assert.equal(parts.length, count);
    }
  });
}

test("recorded durations make the shards about equal", async () => {
  const durationsFile = durationsFileWith(
    JSON.stringify({ files: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/file${i}.test.ts`, (i + 1) * 1000])) }),
  );
  const msOf = ([, file]) => (Number(/file(\d+)/.exec(file)[1]) + 1) * 1000;
  const loads = (await runAllShards(4, durationsFile)).map((part) => part.reduce((sum, spec) => sum + msOf(spec), 0));
  const total = loads.reduce((a, b) => a + b, 0);
  // A split by count alone puts 10 files in each shard and can differ by far
  // more; the heaviest file here is 40 s of a 835 s total.
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 0.05 * total, `uneven shards: ${loads.join(", ")}`);
});
