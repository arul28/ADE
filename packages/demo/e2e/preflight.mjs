/**
 * Boots the SDK against an isolated home and reports what the machine can do —
 * without spending a single provider turn.
 *
 * Run this before `live.mjs`: it answers "is the runtime reachable, is Claude
 * authenticated, which model is cheapest" so the live script never burns a turn
 * discovering the answer is no.
 */

import { createAdeChat } from "@ade-dev/sdk";
import { check, summarize } from "./harness.mjs";
import { makeIsolatedHome } from "../lib/isolatedHome.mjs";
import { startMcpServer } from "../lib/mcpServer.mjs";
import { runtimeBinary } from "../lib/paths.mjs";
import { pickCheapestModel } from "../lib/pickModel.mjs";
import { stop } from "../lib/processes.mjs";

const verbose = process.argv.includes("--verbose");
const home = makeIsolatedHome("preflight");
let client = null;
let mcp = null;

try {
  mcp = await startMcpServer({ logPath: `${home}/mcp-calls.jsonl` });
  check("mcp.ready", Boolean(mcp.url), mcp.url);

  process.stdout.write(`isolated home: ${home}\nruntime binary: ${runtimeBinary}\n\n`);
  client = await createAdeChat({
    home,
    binaryPath: runtimeBinary,
    logger: verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
  });

  const report = await client.doctor();
  check("doctor.socket", report.socket.connected, report.socket.path);
  check("doctor.events", report.events.mode !== "unavailable", `transport=${report.events.mode}`);
  check("doctor.binary", Boolean(report.binary.path), `${report.binary.source} ${report.binary.version ?? "?"}`);

  const providers = await client.providers.status();
  const claude = providers.claude ?? null;
  check(
    "providers.claude",
    Boolean(claude?.available),
    claude
      ? `authenticated=${claude.authenticated} available=${claude.available} models=${claude.modelCount}`
      : `absent (saw: ${Object.keys(providers).join(", ") || "none"})`,
  );

  const models = await client.models.list();
  check("models.list", models.length > 0, `${models.length} models`);
  const picked = pickCheapestModel(models, "claude");
  check("models.pick", Boolean(picked), picked ? `${picked.id} (${picked.displayName})` : "no claude model");

  if (verbose && picked) {
    for (const model of models.filter((entry) => entry.provider === "claude")) {
      process.stdout.write(`  claude: ${model.id}  available=${model.isAvailable} connected=${model.connected}\n`);
    }
  }

  if (report.recentErrors.length) {
    process.stdout.write(`\nrecent errors:\n`);
    for (const entry of report.recentErrors) process.stdout.write(`  ${entry.scope}: ${entry.message}\n`);
  }
} finally {
  await client?.dispose().catch(() => {});
  await stop(mcp?.child);
}

process.exit(summarize().failed === 0 ? 0 : 1);
