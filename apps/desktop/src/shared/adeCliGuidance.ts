export const ADE_CLI_AGENT_GUIDANCE = [
  "## ADE CLI",
  "`ade` should be available in this ADE-managed session for internal ADE work: lanes, missions, PRs, chats/sessions, memory, proof, config, and process state.",
  "If `command -v ade` fails, try `${ADE_CLI_PATH:-}` when set, then `${ADE_CLI_BIN_DIR:-}/ade`, and in an ADE source checkout fall back to `node apps/ade-cli/dist/cli.cjs ...` after confirming the file exists.",
  "Before saying an ADE task is blocked or unsupported, try `ade` first: run `ade doctor` if needed, use typed commands like `ade lanes list --text` / `ade prs checks <pr> --text`, or discover with `ade actions list --text` and `ade actions run ...`.",
].join("\n");

export const ADE_CLI_INLINE_GUIDANCE =
  "`ade` should be available for ADE tasks. If `command -v ade` fails, try `${ADE_CLI_PATH:-}`, then `${ADE_CLI_BIN_DIR:-}/ade`, and in an ADE source checkout `node apps/ade-cli/dist/cli.cjs ...` after confirming it exists. Before reporting an ADE lane, mission, PR, session, memory, proof, config, or process-state task as blocked, try `ade doctor`, typed `ade ... --text` commands, or `ade actions list --text` / `ade actions run ...`.";
