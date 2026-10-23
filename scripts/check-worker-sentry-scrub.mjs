#!/usr/bin/env node
// The four Cloudflare Workers each carry a copy of `src/sentryScrub.ts` (what
// they remove before an event, breadcrumb or span goes to Sentry) and of
// `src/cloudflareTransient.ts` (which Cloudflare failures they retry, answer
// 503 and group in Sentry). Worker sources stay self-contained, so the files
// are copied rather than shared, and a scrubber copy that drifts is a privacy
// hole in one Worker. This fails when they differ. Change all four together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workers = ["account-directory", "push-relay", "tunnel-relay", "webhook-relay"];
const files = ["sentryScrub.ts", "cloudflareTransient.ts"];
const read = (worker, file) =>
  fs.readFileSync(path.join(repoRoot, "apps", worker, "src", file), "utf8").replace(/\r\n/g, "\n");

const [reference, ...others] = workers;
let failed = false;
for (const file of files) {
  const expected = read(reference, file);
  const drifted = others.filter((worker) => read(worker, file) !== expected);
  if (drifted.length === 0) continue;
  failed = true;
  console.error(
    `apps/{${drifted.join(",")}}/src/${file} differ from apps/${reference}/src/${file}. `
      + "It is one file kept in four places: make all four identical.",
  );
}
if (failed) process.exit(1);
console.log(`Worker ${files.join(" and ")} identical across ${workers.length} Workers.`);
