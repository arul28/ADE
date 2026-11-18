// The last `wrangler deploy` step of `npm run deploy`. CI sets SENTRY_RELEASE (ade@<version>)
// and this passes it to the Worker as a var, so Sentry events carry the release the
// source maps were uploaded under. The script runs wrangler through Node, not a shell,
// so the same command works on Windows and macOS.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

// The Workers share one npm workspace, so wrangler is usually hoisted to the
// repo root's node_modules; resolve it the way Node would.
const wranglerBin = path.join(path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
const args = ["deploy", "--upload-source-maps"];
if (process.env.SENTRY_RELEASE) args.push("--var", `SENTRY_RELEASE:${process.env.SENTRY_RELEASE}`);
// Public PostHog project token for PostHog Logs (src/posthogLogs.ts). Read from
// the environment: `npm run deploy` is a chain, so appended flags never reach here.
if (process.env.POSTHOG_LOGS_TOKEN) args.push("--var", `POSTHOG_LOGS_TOKEN:${process.env.POSTHOG_LOGS_TOKEN}`);
args.push(...process.argv.slice(2));

const result = spawnSync(process.execPath, [wranglerBin, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
