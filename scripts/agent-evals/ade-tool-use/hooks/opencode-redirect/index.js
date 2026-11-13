// OpenCode 2.0 plugin for arm C: the same rule table as redirect-hook.mjs,
// through `permission.hook("evaluate")`. A denied evaluation with a message
// reaches the model as `permission.rejected` with that message, also inside
// `subagent` child sessions (checked on OpenCode 2.0.29).
//
// OpenCode puts no time limit on a plugin hook: a hook that never returns
// stalls the tool call. Keep this one synchronous and small.
// Env: ADE_EVAL_RULES (rules.json), ADE_EVAL_HOOK_STATE, ADE_EVAL_HOOK_LOG.
import fs from "node:fs";
import { compileRules, firstRuleHit } from "../../match.mjs";

export default {
  id: "ade-eval-redirect",
  setup: async (ctx) => {
    const rulesFile = process.env.ADE_EVAL_RULES;
    if (!rulesFile) return;
    const rules = compileRules(JSON.parse(fs.readFileSync(rulesFile, "utf8")).rules ?? []);
    const statePath = process.env.ADE_EVAL_HOOK_STATE;
    const logPath = process.env.ADE_EVAL_HOOK_LOG;
    const denied = new Set();
    try { for (const id of JSON.parse(fs.readFileSync(statePath, "utf8")).denied ?? []) denied.add(id); } catch {}
    await ctx.permission.hook("evaluate", (input) => {
      if (input.action !== "shell") return;
      const command = (input.resources ?? []).join(" && ");
      const hit = firstRuleHit(rules, command);
      if (!hit) return;
      const seen = denied.has(hit.id);
      const log = (decision) => {
        if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), agent: input.agent ?? null, rule: hit.id, decision, command })}\n`);
      };
      if (hit.decision === "deny" || !seen) {
        denied.add(hit.id);
        if (statePath) fs.writeFileSync(statePath, JSON.stringify({ denied: [...denied] }));
        input.effect = "deny";
        input.message = hit.reason;
        log("deny");
        return;
      }
      log("allow-retry");
    });
  },
};
