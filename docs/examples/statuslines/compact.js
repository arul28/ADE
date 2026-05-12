#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const payload = JSON.parse(input || "{}");
  const model = payload.model?.displayName || payload.model?.display_name || payload.model?.id || "model";
  const lane = payload.lane || payload.workspace?.gitBranch || "lane";
  const context = payload.context?.tokenSummary
    || (payload.context_window?.used_percentage != null ? `${payload.context_window.used_percentage}% context` : "context n/a");
  const permission = payload.permission_mode || "default";
  process.stdout.write(`${model} | ${lane} | ${context} | ${permission}\n`);
});
