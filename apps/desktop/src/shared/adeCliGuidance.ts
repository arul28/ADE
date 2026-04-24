export const ADE_CLI_AGENT_GUIDANCE = [
  "## ADE CLI",
  "`ade` is available in this ADE-managed session for internal ADE work: lanes, missions, PRs, chats/sessions, memory, proof, config, and process state.",
  "Before saying an ADE task is blocked or unsupported, try `ade` first: run `ade doctor` if needed, use typed commands like `ade lanes list --text` / `ade prs checks <pr> --text`, or discover with `ade actions list --text` and `ade actions run ...`.",
].join("\n");

export const ADE_CLI_INLINE_GUIDANCE =
  "`ade` is available for ADE tasks. Before reporting an ADE lane, mission, PR, session, memory, proof, config, or process-state task as blocked, try `ade doctor`, typed `ade ... --text` commands, or `ade actions list --text` / `ade actions run ...`.";
