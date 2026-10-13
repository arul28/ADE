// The last `wrangler deploy` step of `npm run deploy`. CI sets SENTRY_RELEASE (ade@<version>)
// and this passes it to the Worker as a var, so Sentry events carry the release the
// source maps were uploaded under. The script runs wrangler through Node, not a shell,
// so the same command works on Windows and macOS.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const args = ["deploy", "--upload-source-maps"];
if (process.env.SENTRY_RELEASE) args.push("--var", `SENTRY_RELEASE:${process.env.SENTRY_RELEASE}`);
args.push(...process.argv.slice(2));

const result = spawnSync(process.execPath, [wranglerBin, ...args], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
