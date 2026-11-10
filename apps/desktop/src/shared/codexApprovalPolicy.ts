import type { AgentChatCodexApprovalPolicy } from "./types/chat";

/**
 * What each Codex interface accepts as an approval policy. The three disagree,
 * and each refuses the whole request (or exits) on a value it does not know,
 * so every value ADE sends to Codex goes through the function for its
 * interface. Checked against the pinned Codex 0.167.0:
 *
 * | Interface                        | Accepts                                  | Refuses      |
 * | -------------------------------- | ---------------------------------------- | ------------ |
 * | app-server (`AskForApproval`)    | `untrusted`, `on-request`, `never`       | `on-failure` |
 * | CLI flag `--ask-for-approval`    | `on-request`, `never`                    | the rest     |
 * | config key `approval_policy`     | `on-request`, `on-failure`, `never`      | `untrusted`  |
 *
 * `codex exec` has no `--ask-for-approval` flag at all, so it takes the config
 * key. A refused value becomes `on-request`: the sandbox beside it still
 * bounds what runs without a question, and the model asks to go past it.
 */
export function codexAppServerApprovalPolicy(
  approvalPolicy: AgentChatCodexApprovalPolicy,
): Exclude<AgentChatCodexApprovalPolicy, "on-failure"> {
  return approvalPolicy === "on-failure" ? "on-request" : approvalPolicy;
}

export function codexCliApprovalFlagValue(approvalPolicy: AgentChatCodexApprovalPolicy): "on-request" | "never" {
  return approvalPolicy === "never" ? "never" : "on-request";
}

export function codexConfigApprovalPolicy(
  approvalPolicy: AgentChatCodexApprovalPolicy,
): Exclude<AgentChatCodexApprovalPolicy, "untrusted"> {
  return approvalPolicy === "untrusted" ? "on-request" : approvalPolicy;
}
