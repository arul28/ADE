/**
 * The world every case starts from: what each `ade … --json` command prints
 * (before the typed tool trims it), for a person with two projects, three
 * lanes and two chats. A case overrides any of it in its `results`.
 * Invented data only — never a real person's projects, chats or paths.
 */

export type Input = Record<string, unknown>;
export type Fixture = unknown | ((input: Input) => unknown);

export const PROJECTS = [
  { projectId: "p-ade", displayName: "ADE", rootPath: "/Users/sam/Projects/ADE", lastOpenedAt: 1_761_000_000_000, exists: true },
  { projectId: "p-web", displayName: "website", rootPath: "/Users/sam/Projects/website", lastOpenedAt: 1_760_000_000_000, exists: true },
];

export const MACHINES = [
  { name: "MacBook Pro", key: "k-mbp", isThisMachine: true },
  { name: "Mac mini", key: "k-mini", isThisMachine: false },
];

const recent = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 28, 12, 0) - minutesAgo * 60_000).toISOString();

export const DEFAULT_RESULTS: Record<string, Fixture> = {
  projects_list: PROJECTS,
  machines_list: {
    machines: MACHINES.map((machine) => ({ ...machine, online: true, included: true, serving: true })),
  },
  lanes_list: {
    lanes: [
      { id: "lane-main", name: "main", branchRef: "main", status: "clean", laneType: "primary" },
      { id: "lane-fix-login", name: "fix-login", branchRef: "ade/fix-login", status: "dirty", aheadOfBase: 2 },
      { id: "lane-deps", name: "bump-deps", branchRef: "ade/bump-deps", status: "clean", aheadOfBase: 1 },
    ],
  },
  lanes_show: (input: Input) => ({ id: input.lane, branchRef: `ade/${String(input.lane).replace(/^lane-/, "")}`, baseRef: "main", dirty: true, conflicts: [] }),
  files_tree: { path: "", entries: [{ name: "README.md", type: "file" }, { name: "src", type: "directory" }] },
  files_read: (input: Input) => ({ path: input.path, content: "# Example\n\nA small app.\n", isPartial: false }),
  files_search: { matches: [{ path: "src/auth/login.ts", line: 42, column: 7, preview: "redirectTo(returnUrl)" }] },
  diff_changes: {
    unstaged: [{ path: "src/auth/login.ts", status: "M", additions: 12, deletions: 3 }],
    staged: [],
  },
  diff_patch: (input: Input) => ({ path: input.path, patch: "@@ -40,3 +40,12 @@\n-  redirectTo('/')\n+  redirectTo(returnUrl ?? '/')\n" }),
  git_status: { branch: "ade/fix-login", upstream: "origin/ade/fix-login", ahead: 2, behind: 0 },
  prs_list: {
    prs: [
      { id: "pr-1", laneId: "lane-fix-login", githubPrNumber: 123, title: "Fix login redirect", state: "open", checksStatus: "failing", reviewStatus: "pending", updatedAt: recent(30) },
      { id: "pr-2", laneId: "lane-deps", githubPrNumber: 124, title: "Bump deps", state: "open", checksStatus: "passing", reviewStatus: "approved", updatedAt: recent(90) },
    ],
  },
  prs_show: (input: Input) => ({ number: Number(String(input.pr).replace(/\D/g, "")) || 123, title: "Fix login redirect", body: "Keeps the return URL after sign-in.", labels: [], reviewers: ["alex"] }),
  prs_checks: {
    checks: [
      { name: "unit tests", status: "failure", link: "https://github.com/sam/app/actions/runs/1" },
      { name: "lint", status: "success", link: "https://github.com/sam/app/actions/runs/2" },
    ],
    counts: { passing: 1, failing: 1, pending: 0 },
  },
  chat_list: [
    { sessionId: "chat-login", laneId: "lane-fix-login", title: "Fix login redirect", provider: "claude", model: "claude-opus-5", status: "active", lastActivityAt: recent(2), lastOutputPreview: "Running the auth tests…" },
    { sessionId: "chat-deps", laneId: "lane-deps", title: "Bump deps", provider: "codex", model: "gpt-5.6", status: "idle", lastActivityAt: recent(60), lastOutputPreview: "Bumped 14 packages." },
  ],
  chat_read: (input: Input) => ({ sessionId: input.session, messages: [{ role: "user", text: "Fix the login redirect." }, { role: "assistant", text: "The redirect dropped the return URL; fixed and tests pass." }] }),
  chat_status: (input: Input) => ({ sessionId: input.session, phase: "idle", currentTool: null, ask: null }),
  chat_wait: (input: Input) => ({
    ok: true, sessionId: input.session, waitFor: input.for ?? "idle", elapsedMs: 41_000,
    summary: { sessionId: input.session, status: "idle", lastOutputPreview: "Done: the change is in and the tests pass." },
  }),
  usage_limits: {
    accounts: [
      { provider: "claude", accountId: "acct-claude", label: "Claude Max", windows: [{ window: "5-hour", percentLeft: 62, resetsAt: recent(-120) }, { window: "weekly", percentLeft: 35, resetsAt: recent(-3000) }] },
      { provider: "codex", accountId: "acct-codex", label: "ChatGPT Pro", windows: [{ window: "weekly", percentLeft: 80, resetsAt: recent(-5000) }] },
    ],
  },
  inbox: { items: [] },
  chat_respond: (input: Input) => ({
    answered: true,
    sessionId: input.session,
    itemId: input.request_id ?? "req-1",
    decision: input.decision === "deny" ? "decline" : input.decision === "approve_for_session" ? "accept_for_session" : "accept",
  }),
  chat_send: (input: Input) => ({ sessionId: input.session, kind: "auto", routedAction: "sendMessage", statusBefore: "idle", awaitingInputBefore: false, delivery: "delivered" }),
  chat_start: (input: Input) => ({
    ok: true, launchId: "chat-new", phase: "completed", elapsedMs: 25_000,
    launch: { sessionId: "chat-new", laneId: "lane-new", laneName: "fix-flaky-test", title: String(input.prompt).slice(0, 40), phase: "completed", error: null },
  }),
};
