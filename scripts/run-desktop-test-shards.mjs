#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolveNpmInvocation } from "./dev-shared.mjs";

const shardCount = Number.parseInt(process.env.ADE_DESKTOP_TEST_SHARDS ?? "8", 10);
const totalShards = Number.isFinite(shardCount) && shardCount > 0 ? shardCount : 8;

for (let shard = 1; shard <= totalShards; shard += 1) {
  process.stdout.write(`[ade] desktop test shard ${shard}/${totalShards}\n`);
  const invocation = resolveNpmInvocation([
    "--prefix",
    "apps/desktop",
    "run",
    "test:unit",
    "--",
    `--shard=${shard}/${totalShards}`,
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: "inherit",
    windowsHide: process.platform === "win32",
  });
  if (result.error) {
    process.stderr.write(`[ade] desktop test shard ${shard}/${totalShards} failed to start: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.stderr.write(`[ade] desktop test shard ${shard}/${totalShards} exited with signal ${result.signal}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
