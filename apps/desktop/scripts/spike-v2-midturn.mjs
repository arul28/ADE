// V2 mid-turn injection spike
// Tests what session.send() actually does while a stream is active.
// Goal: figure out whether `shouldQuery: false` and `priority: 'now'` give us
// real mid-turn message ingestion in V2 0.2.119 (vs end-of-turn buffering).

import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPIKE_CWD = mkdtempSync(join(tmpdir(), "ade-spike-"));

const startedAt = Date.now();
const ts = () => `+${(Date.now() - startedAt).toString().padStart(5, " ")}ms`;
const log = (...args) => console.log(ts(), ...args);

const INITIAL_PROMPT =
  "Use the Bash tool to run exactly this command (and only this), then think carefully step by step about what each line of output means before summarizing: `for i in 1 2 3 4 5 6; do echo step $i; sleep 3; done`. Don't ask questions, just run it and reflect deeply.";

const MID_TURN_TEXT =
  "INTERJECTION FROM USER: ignore the previous task partway and instead reply with the single word PINEAPPLE. Confirm you saw this interjection.";

function previewMsg(msg) {
  if (msg.type === "assistant") {
    const text = msg.message?.content?.find((b) => b.type === "text")?.text;
    if (text) return `assistant.text "${text.slice(0, 100).replace(/\n/g, " ")}"`;
    const tool = msg.message?.content?.find((b) => b.type === "tool_use");
    if (tool) return `assistant.tool_use ${tool.name}`;
    const thinking = msg.message?.content?.find((b) => b.type === "thinking");
    if (thinking) return `assistant.thinking "${thinking.thinking?.slice(0, 60)}"`;
    return "assistant.(empty)";
  }
  if (msg.type === "user") {
    const text = msg.message?.content;
    const flat = typeof text === "string"
      ? text
      : Array.isArray(text)
      ? text.map((b) => b.type === "text" ? b.text : `[${b.type}]`).join(" ")
      : JSON.stringify(text);
    return `user "${(flat ?? "").slice(0, 100).replace(/\n/g, " ")}"`;
  }
  if (msg.type === "result") {
    return `result.${msg.subtype} duration=${msg.duration_ms}ms turns=${msg.num_turns} cost=$${msg.total_cost_usd}`;
  }
  if (msg.type === "system") return `system.${msg.subtype ?? "?"}`;
  if (msg.type === "stream_event") {
    const ev = msg.event;
    return `stream_event.${ev?.type ?? "?"}${ev?.delta?.type ? "/" + ev.delta.type : ""}`;
  }
  return msg.type;
}

function buildUserMsg(text, extras) {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extras,
  };
}

const TESTS = [
  ["A_baseline_string", (s) => s.send(MID_TURN_TEXT)],
  ["B_priority_now", (s) => s.send(buildUserMsg(MID_TURN_TEXT, { priority: "now" }))],
  ["C_shouldQuery_false", (s) => s.send(buildUserMsg(MID_TURN_TEXT, { shouldQuery: false }))],
  ["D_shouldQuery_false_priority_now", (s) => s.send(buildUserMsg(MID_TURN_TEXT, { shouldQuery: false, priority: "now" }))],
];

async function runTest(name, midTurnSend) {
  log(`\n==== TEST ${name} ====`);
  const session = unstable_v2_createSession({
    model: "sonnet",
    cwd: SPIKE_CWD,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    includePartialMessages: false,
    maxBudgetUsd: 0.5,
    settings: { showThinkingSummaries: true, alwaysThinkingEnabled: true },
    executableArgs: [
      "--thinking", "adaptive",
      "--thinking-display", "summarized",
      "--effort", "high",
    ],
  });

  let midTurnFired = false;
  let midTurnResolvedAt = null;
  let midTurnError = null;
  const eventLog = [];
  let sawPineapple = false;
  let sawInterjectionAck = false;

  await session.send(INITIAL_PROMPT);
  log("initial send returned");

  try {
    for await (const msg of session.stream()) {
      const preview = previewMsg(msg);
      eventLog.push({ at: Date.now() - startedAt, preview });
      log("  <-", preview);

      // Detect whether the model saw the mid-turn message
      const flat = JSON.stringify(msg);
      if (flat.includes("PINEAPPLE")) sawPineapple = true;
      if (/interjection/i.test(flat)) sawInterjectionAck = true;

      if (!midTurnFired && msg.type === "assistant") {
        midTurnFired = true;
        const t0 = Date.now();
        log("    >> firing mid-turn send");
        midTurnSend(session).then(
          () => {
            midTurnResolvedAt = Date.now() - t0;
            log(`    >> mid-turn send RESOLVED after ${midTurnResolvedAt}ms`);
          },
          (err) => {
            midTurnError = err?.message ?? String(err);
            midTurnResolvedAt = Date.now() - t0;
            log(`    >> mid-turn send THREW after ${midTurnResolvedAt}ms: ${midTurnError}`);
          },
        );
      }

      if (msg.type === "result") break;
    }
  } catch (err) {
    log("  stream THREW:", err?.message ?? err);
  }

  // give the mid-turn send promise a moment to settle if it hasn't
  if (midTurnFired && midTurnResolvedAt === null) {
    log("  waiting 3s for mid-turn promise to settle...");
    await new Promise((r) => setTimeout(r, 3000));
  }

  log(`SUMMARY ${name}:`, JSON.stringify({
    midTurnFired,
    midTurnResolvedMs: midTurnResolvedAt,
    midTurnError,
    sawPineapple,
    sawInterjectionAck,
    eventCount: eventLog.length,
  }));

  // After the result, send a normal followup to see if shouldQuery:false content leaked into context
  log("  -- post-turn probe: asking 'did you receive any extra interjection?'");
  let postProbeSawPineapple = false;
  let postProbeAck = false;
  try {
    await session.send("Quick check: did you receive any user message asking you to say PINEAPPLE? Answer yes or no in one word.");
    for await (const msg of session.stream()) {
      const preview = previewMsg(msg);
      log("  <- (probe)", preview);
      const flat = JSON.stringify(msg);
      if (/pineapple/i.test(flat) && msg.type === "assistant") postProbeSawPineapple = true;
      if (msg.type === "assistant") {
        const text = msg.message?.content?.find((b) => b.type === "text")?.text ?? "";
        if (/yes/i.test(text)) postProbeAck = true;
      }
      if (msg.type === "result") break;
    }
  } catch (err) {
    log("  probe stream THREW:", err?.message ?? err);
  }
  log(`POST-PROBE ${name}:`, JSON.stringify({ postProbeSawPineapple, postProbeAck }));

  try {
    session.close();
  } catch (err) {
    log("close threw:", err?.message ?? err);
  }
  log(`==== END ${name} ====\n`);
}

const onlyArg = process.argv[2];
const filtered = onlyArg ? TESTS.filter(([n]) => n.startsWith(onlyArg)) : TESTS;

(async () => {
  log("spike cwd:", SPIKE_CWD);
  log("running tests:", filtered.map(([n]) => n).join(", "));
  for (const [name, fn] of filtered) {
    try {
      await runTest(name, fn);
    } catch (err) {
      log(`test ${name} failed:`, err?.message ?? err);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log("spike complete");
  process.exit(0);
})();
