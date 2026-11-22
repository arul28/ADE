#!/usr/bin/env node
// Pre-tool hook for the eval, in the Claude / Codex / Droid PreToolUse format
// (JSON on stdin, `hookSpecificOutput` on stdout).
//
//   redirect-hook.mjs [--rules <rules.json>] [--state <file>] [--log <file>] [--guard-shims <dir>]
//
// --rules        arm C: deny a shell command that matches a rule, with the
//                rule's reason. `deny-once` denies the first hit per run and
//                lets the retry through (the escape hatch for a user who
//                really asked for `gh`); the state file remembers the hit.
// --guard-shims  safety, for a provider that cannot run inside guard.sb
//                (Droid): point any screen tool at its stand-in, silently.
//
// Hooks of every provider tested fail open (a crash or a timeout lets the call
// run), so this hook is the thing under test, never the safety net. guard.sb
// is the safety net wherever the provider allows it.
import fs from "node:fs";
import { compileRules, decideRule, SCREEN_TOOLS } from "../match.mjs";

// Any screen tool word, with or without a path, after a space, a separator, a
// quote or `=`. Wider than match.mjs's command positions on purpose: this is
// a safety rewrite (`find -exec screencapture` too), so it errs toward a
// rewrite. A rewritten argument only points at a stand-in.
const SCREEN_TOOL_WORD = new RegExp(String.raw`(^|[\s;&|('"\x60=])(?:\/[\w./-]*\/)?(${SCREEN_TOOLS.join("|")})(?=$|[\s;&|)'"\x60])`, "g");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]]);
  return acc;
}, []));

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let event = {};
  try { event = JSON.parse(input || "{}"); } catch { return; }
  const command = event.tool_input?.command;
  if (typeof command !== "string") return;
  const log = (entry) => {
    if (args.log) fs.appendFileSync(args.log, `${JSON.stringify({ at: Date.now(), agent: event.agent_id ?? null, ...entry })}\n`);
  };

  if (args.rules) {
    const rules = compileRules(JSON.parse(fs.readFileSync(args.rules, "utf8")).rules ?? []);
    const state = readState();
    const decided = decideRule(rules, command, state.denied);
    if (decided) {
      const { hit, decision } = decided;
      log({ rule: hit.id, decision, command });
      if (decision === "deny") {
        if (!state.denied.includes(hit.id)) writeState({ denied: [...state.denied, hit.id] });
        deny(hit.reason);
        return;
      }
    }
  }

  if (args["guard-shims"]) {
    const shims = args["guard-shims"];
    const rewritten = command.replace(SCREEN_TOOL_WORD, (_m, pre, name) => `${pre}${shims}/${name}`);
    if (rewritten !== command) {
      log({ rule: "guard-rewrite", decision: "rewrite", command });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...event.tool_input, command: rewritten } } }));
    }
  }
});

function readState() {
  try { return { denied: [], ...JSON.parse(fs.readFileSync(args.state, "utf8")) }; } catch { return { denied: [] }; }
}
function writeState(state) {
  if (args.state) fs.writeFileSync(args.state, JSON.stringify(state));
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}
