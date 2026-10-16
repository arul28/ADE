#!/usr/bin/env node
// The four Cloudflare Workers each carry a copy of `src/sentryScrub.ts`: what
// they remove before an event, breadcrumb or span goes to Sentry. Worker
// sources stay self-contained, so the file is copied rather than shared, and
// a copy that drifts is a privacy hole in one Worker. This fails when they
// differ. Change all four together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workers = ["account-directory", "push-relay", "tunnel-relay", "webhook-relay"];
const read = (worker) =>
  fs.readFileSync(path.join(repoRoot, "apps", worker, "src", "sentryScrub.ts"), "utf8").replace(/\r\n/g, "\n");

const [reference, ...others] = workers;
const expected = read(reference);
const drifted = others.filter((worker) => read(worker) !== expected);
if (drifted.length > 0) {
  console.error(
    `apps/{${drifted.join(",")}}/src/sentryScrub.ts differ from apps/${reference}/src/sentryScrub.ts. `
      + "The Worker scrubbers are one file kept in four places: make all four identical.",
  );
  process.exit(1);
}
console.log(`Worker Sentry scrubbers identical across ${workers.length} Workers.`);
