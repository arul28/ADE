/**
 * The live end-to-end proof: @ade-dev/sdk -> a real ADE runtime -> a real Claude
 * turn -> a real MCP tool call against the toy `demodata` server, and back out
 * through the event shapes `@ade-dev/chat-ui` renders.
 *
 * This spends real provider tokens. It is deliberately ONE turn, on the
 * cheapest available Claude model, with a two-sentence prompt. It never retries
 * a failed turn — a repeated failure is reported, not spent against.
 *
 * Everything runs against a throwaway ADE home under the OS temp dir. The
 * developer's real `~/.ade`, brain and socket are never opened.
 *
 * Assertions:
 *   (a) a `tool_call` event names a `demodata` tool
 *   (b) the toy server's own call log records the same call
 *   (c) the final assistant text names the invoice that changed this week
 *   (d) every `tool_result` reuses its `tool_call`'s `itemId`  (chat-ui's
 *       collapse contract — a mismatch renders two chips instead of one)
 *   (e) `exportThread` returns JSONL containing the turn
 *   (f) strict MCP mode is factually enforced, and only `demodata` was injected
 *   (g) a NEW client on the same home resumes the thread and replays its history
 */

import path from "node:path";
import { createAdeChat } from "@ade-dev/sdk";
import { check, eventText, summarize, waitForIdle } from "./harness.mjs";
import { makeIsolatedHome } from "../lib/isolatedHome.mjs";
import { readMcpLog, startMcpServer } from "../lib/mcpServer.mjs";
import { runtimeBinary } from "../lib/paths.mjs";
import { pickCheapestModel } from "../lib/pickModel.mjs";
import { stop } from "../lib/processes.mjs";

const verbose = process.argv.includes("--verbose");
const log = (line) => process.stdout.write(`${line}\n`);
const sdkLog = verbose ? (line) => process.stderr.write(`${line}\n`) : undefined;

const PROMPT =
  "Use the demodata tools to tell me which invoices changed this week. " +
  "Then list the names of every MCP server you can reach.";

const home = makeIsolatedHome("live");
const mcpLogPath = path.join(home, "mcp-calls.jsonl");

let mcp = null;
let client = null;
let resumed = null;

try {
  mcp = await startMcpServer({ logPath: mcpLogPath });
  log(`toy MCP server: ${mcp.url}`);
  log(`isolated ADE home: ${home}\n`);

  /* ---- boot ------------------------------------------------------------- */

  client = await createAdeChat({ home, binaryPath: runtimeBinary, logger: sdkLog });

  const doctor = await client.doctor();
  check("doctor.sane", doctor.socket.connected && doctor.events.mode !== "unavailable",
    `socket=${doctor.socket.connected} events=${doctor.events.mode} binary=${doctor.binary.source}`);

  const providers = await client.providers.status();
  const claude = providers.claude;
  if (!claude?.available) {
    check("providers.claude.ready", false, "Claude is not available on this machine; not spending a turn");
    throw new Error("claude unavailable");
  }
  check("providers.claude.ready", true, `authenticated=${claude.authenticated} models=${claude.modelCount}`);

  const models = await client.models.list();
  const model = pickCheapestModel(models, "claude");
  if (!model) {
    check("models.pick", false, "no usable Claude model in the catalog");
    throw new Error("no model");
  }
  check("models.pick", true, `${model.id} — ${model.displayName}`);

  /* ---- open the thread with only our MCP server -------------------------- */

  const thread = await client.threads.open("main", {
    provider: "claude",
    model: model.id,
    mcpServers: { demodata: { type: "http", url: mcp.url } },
    permissions: "always-allow",
    title: "DataDesk demo",
  });

  const capability = thread.mcpCapability;
  check(
    "f.mcp.enforced",
    capability?.level === "enforced" && capability.delivered === true && capability.residual === null,
    capability
      ? `level=${capability.level} delivered=${capability.delivered} residual=${capability.residual ?? "null"} mechanism=${capability.mechanism}`
      : "the runtime reported no mcpCapability",
  );

  /* ---- one live turn ----------------------------------------------------- */

  log(`\n--- live turn (1) on ${model.id} ---`);
  const seen = [];
  const settled = waitForIdle(thread, {
    onEvent: (envelope) => {
      seen.push(envelope);
      if (!verbose) return;
      const event = envelope.event ?? {};
      const preview = eventText(envelope).slice(0, 120).replace(/\n/g, " ");
      process.stderr.write(`  <- ${event.type}${event.tool ? ` ${event.tool}` : ""}${preview ? `: ${preview}` : ""}\n`);
    },
  });
  await thread.send(PROMPT);
  await settled;
  log(`--- turn settled: ${seen.length} events ---\n`);

  const errors = seen.filter((envelope) => envelope.event?.type === "error");
  if (errors.length) {
    log(`provider errors during the turn:\n${errors.map((entry) => JSON.stringify(entry.event)).join("\n")}\n`);
  }

  /* ---- (a) tool_call for a demodata tool --------------------------------- */

  const toolCalls = seen.filter((envelope) => envelope.event?.type === "tool_call");
  const demodataCalls = toolCalls.filter((envelope) =>
    String(envelope.event.tool ?? "").toLowerCase().includes("demodata"),
  );
  check(
    "a.tool_call.demodata",
    demodataCalls.length > 0,
    demodataCalls.length
      ? demodataCalls.map((entry) => entry.event.tool).join(", ")
      : `saw tools: ${toolCalls.map((entry) => entry.event.tool).join(", ") || "none"}`,
  );

  /* ---- (b) the toy server actually served it ----------------------------- */

  const serverCalls = readMcpLog(mcpLogPath).filter((entry) => entry.kind === "tools/call");
  check(
    "b.server.log",
    serverCalls.length > 0,
    serverCalls.map((entry) => `${entry.tool}(${JSON.stringify(entry.args)})`).join(", ") || "no calls logged",
  );
  check(
    "b.server.get_invoices",
    serverCalls.some((entry) => entry.tool === "get_invoices"),
    `tools hit: ${[...new Set(serverCalls.map((entry) => entry.tool))].join(", ") || "none"}`,
  );

  /* ---- (c) the answer names the invoice that changed --------------------- */

  const assistantText = seen
    .filter((envelope) => envelope.event?.type === "text")
    .map(eventText)
    .join("\n");
  check(
    "c.answer.mentions_changed_invoice",
    /INV-0007/i.test(assistantText) || /northwind/i.test(assistantText),
    assistantText ? `${assistantText.length} chars; tail: ${assistantText.slice(-160).replace(/\n/g, " ")}` : "no assistant text",
  );

  /* ---- (d) tool_result reuses the tool_call itemId ----------------------- */

  const callIds = new Set(
    toolCalls.map((envelope) => envelope.event.itemId).filter((id) => typeof id === "string"),
  );
  const toolResults = seen.filter((envelope) => envelope.event?.type === "tool_result");
  const orphaned = toolResults.filter(
    (envelope) => typeof envelope.event.itemId !== "string" || !callIds.has(envelope.event.itemId),
  );
  check(
    "d.tool_result.itemId_reuse",
    toolResults.length > 0 && orphaned.length === 0,
    `${toolResults.length} results, ${callIds.size} call ids, ${orphaned.length} orphaned` +
      (orphaned.length
        ? `: ${orphaned.map((entry) => `${entry.event.tool}#${String(entry.event.itemId)}`).join(", ")}`
        : ""),
  );

  /* ---- (e) exportThread ---------------------------------------------------*/

  const jsonl = await client.exportThread("main");
  const lines = jsonl.split("\n").filter(Boolean);
  let parsed = [];
  let parseError = null;
  try {
    parsed = lines.map((line) => JSON.parse(line));
  } catch (error) {
    parseError = error;
  }
  check("e.export.jsonl", !parseError && lines.length > 0, parseError ? String(parseError) : `${lines.length} lines`);
  check(
    "e.export.contains_turn",
    parsed.some((envelope) => envelope.event?.type === "user_message") &&
      parsed.some((envelope) => envelope.event?.type === "tool_call"),
    `types: ${[...new Set(parsed.map((envelope) => envelope.event?.type))].join(", ")}`,
  );

  /* ---- (f) only demodata was injected ------------------------------------ */

  // The hard half of this is `f.mcp.enforced` above. This is the factual half:
  // the agent's own answer enumerates the servers it can actually reach, and it
  // is read from the same turn rather than costing another one.
  const lowerAnswer = assistantText.toLowerCase();
  const foreignServer = ["ade-cto", "ade-orchestration", "linear", "playwright", "sentry", "github"].find(
    (name) => lowerAnswer.includes(name),
  );
  check(
    "f.mcp.only_demodata",
    lowerAnswer.includes("demodata") && !foreignServer,
    foreignServer
      ? `the agent also named "${foreignServer}"`
      : lowerAnswer.includes("demodata")
        ? "the agent named demodata and nothing else"
        : "the agent did not enumerate its servers (soft check)",
  );

  const historyBefore = await thread.history();
  check("g.history.before", historyBefore.length > 0, `${historyBefore.length} envelopes`);

  /* ---- (g) durable across a full restart --------------------------------- */

  log("\n--- disposing the client and reopening the same home ---");
  await client.dispose();
  client = null;

  resumed = await createAdeChat({ home, binaryPath: runtimeBinary, logger: sdkLog });
  // No provider/model: reopening a durable key must not require the caller to
  // remember how the thread was created.
  const resumedThread = await resumed.threads.open("main");
  check("g.resume.same_session", resumedThread.id === thread.id, `${resumedThread.id} vs ${thread.id}`);

  const historyAfter = await resumedThread.history();
  const resumedText = historyAfter
    .filter((envelope) => envelope.event?.type === "text")
    .map(eventText)
    .join("\n");
  check(
    "g.resume.history",
    historyAfter.length > 0 &&
      historyAfter.some((envelope) => envelope.event?.type === "user_message") &&
      historyAfter.some((envelope) => envelope.event?.type === "tool_call"),
    `${historyAfter.length} envelopes; types: ${[...new Set(historyAfter.map((envelope) => envelope.event?.type))].join(", ")}`,
  );
  check(
    "g.resume.mcp_capability",
    resumedThread.mcpCapability?.level === "enforced",
    `level=${resumedThread.mcpCapability?.level ?? "null"}`,
  );
  check(
    "g.resume.answer_survived",
    /INV-0007/i.test(resumedText) || /northwind/i.test(resumedText),
    `${resumedText.length} chars of assistant text replayed`,
  );

  if (verbose) log(`\nfull answer:\n${assistantText}\n`);
} catch (error) {
  log(`\nfatal: ${error?.stack ?? String(error)}`);
} finally {
  await client?.dispose().catch(() => {});
  await resumed?.dispose().catch(() => {});
  await stop(mcp?.child);
  log(`\nartifacts: ${home}`);
}

process.exit(summarize().failed === 0 ? 0 : 1);
