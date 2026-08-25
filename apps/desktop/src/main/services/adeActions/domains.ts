/**
 * The closed list of ADE action domains, and nothing else.
 *
 * It lives apart from `registry.ts` because that module pulls in the whole
 * runtime service graph (auth services, the CLI bootstrap) while several
 * consumers need only the names — the analytics policy, loaded by the analytics
 * service and its exporters, is the one that used to keep a hand-written copy
 * of all 45 entries. A file with zero imports can be read by any of them.
 */
export const ADE_ACTION_DOMAIN_NAMES = [
  "account",
  "attention",
  "lane",
  "git",
  "diff",
  "conflicts",
  "pr",
  "tests",
  "chat",
  "keybindings",
  "ai",
  "onboarding",
  "automation_planner",
  "cto_state",
  "cto_memory",
  "session",
  "operation",
  "ade_project",
  "project_config",
  "project_secret",
  "linear_credentials",
  "linear_oauth",
  "linear_issue_tracker",
  "github",
  "feedback",
  "usage",
  "analytics",
  "storage",
  "budget",
  "update",
  "file",
  "pty",
  "terminal",
  "layout",
  "tiling_tree",
  "graph_state",
  "computer_use_artifacts",
  "ios_simulator",
  "app_control",
  "built_in_browser",
  "automations",
  "review",
  "issue",
  "orchestration",
  "search",
  "external-sessions",
] as const;

export type AdeActionDomain = (typeof ADE_ACTION_DOMAIN_NAMES)[number];
