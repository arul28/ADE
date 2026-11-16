// Splits a Vitest run into shards of about equal duration.
//
// Vitest 0.34 shards by a hash of each file path, so one shard can get twice
// the work of another. The sequencer here keeps Vitest's own file discovery
// and changes only which shard runs each file: it weighs each file by its
// recorded duration and fills the lightest shard first.
//
// Every shard process computes the whole partition from the same file list
// and the same durations file, then keeps its own part. The result depends on
// nothing else (not the order of the list, not the clock), so each file runs
// in exactly one shard. A stale or missing durations file changes only the
// balance, never which files run.
//
// Refresh the durations with scripts/ci/update-test-durations.mjs (its header
// says how).

import fs from "node:fs";
import path from "node:path";

/**
 * Assigns each key to one of `count` shards, so the shards' total weights
 * are about equal. Greedy: the heaviest key first (ties by key), each into
 * the lightest shard (ties by the lower shard number).
 *
 * @param {string[]} keys the items to split; their order does not matter
 * @param {number} count the number of shards
 * @param {(key: string) => number} weightOf a key's weight, a finite number >= 0
 * @returns {number[]} for each key (same order as `keys`), its shard, 0-based
 */
export function assignShards(keys, count, weightOf) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const order = keys
    .map((key, index) => ({ key, index, weight: weightOf(key) }))
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const loads = new Array(count).fill(0);
  const shardOf = new Array(keys.length);
  for (const item of order) {
    let lightest = 0;
    for (let shard = 1; shard < count; shard += 1) {
      if (loads[shard] < loads[lightest]) lightest = shard;
    }
    loads[lightest] += item.weight;
    shardOf[item.index] = lightest;
  }
  return shardOf;
}

/**
 * Reads a durations file: `{ "files": { "<path from the package root>": ms } }`.
 * A missing or unreadable file, or an entry that is not a finite number >= 0,
 * counts as no data for that file.
 *
 * @returns {Map<string, number>}
 */
export function readDurations(durationsFile) {
  const durations = new Map();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(durationsFile, "utf8"));
  } catch (error) {
    process.stderr.write(`[test-shards] no usable durations in ${durationsFile} (${error.message}); every file weighs the same\n`);
    return durations;
  }
  for (const [file, ms] of Object.entries(parsed?.files ?? {})) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) durations.set(file, ms);
  }
  return durations;
}

/**
 * Builds the weight function for a list of files: a file's recorded duration
 * plus a fixed cost per file. A file with no recorded duration (a new test
 * file) gets the median of the recorded durations of the listed files.
 *
 * @param {string[]} files paths from the package root
 * @param {Map<string, number>} durations
 * @param {number} perFileMs the fixed cost each file adds
 */
export function weightsFor(files, durations, perFileMs) {
  const known = files.filter((file) => durations.has(file)).map((file) => durations.get(file)).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor((known.length - 1) / 2)];
  return (file) => Math.round((durations.has(file) ? durations.get(file) : median) + perFileMs);
}

/** The path of a test file from the package root, with forward slashes. */
function relativeTestPath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Returns a Vitest sequencer class whose `shard()` splits the files by
 * duration. Pass Vitest's own BaseSequencer (from "vitest/node"), so this
 * file needs no Vitest import and works for every package.
 *
 * Vitest 0.34 calls `shard()` once per run with every [project, file] pair of
 * every workspace project, so one call sees the whole run.
 *
 * @param {new (ctx: unknown) => object} BaseSequencer
 * @param {{ durationsFile: string, perFileMs?: number }} options
 */
export function createDurationShardSequencer(BaseSequencer, { durationsFile, perFileMs = 0 }) {
  return class DurationShardSequencer extends BaseSequencer {
    async shard(specs) {
      const { root, shard } = this.ctx.config;
      const files = specs.map(([, file]) => relativeTestPath(root, file));
      const weightOf = weightsFor(files, readDurations(durationsFile), perFileMs);
      // The project name keeps two projects' copies of one file apart.
      const keys = specs.map(([project], i) => `${files[i]}\u0000${project.getName()}`);
      const fileOf = new Map(keys.map((key, i) => [key, files[i]]));
      const shardOf = assignShards(keys, shard.count, (key) => weightOf(fileOf.get(key)));
      return specs.filter((_, i) => shardOf[i] === shard.index - 1);
    }
  };
}
