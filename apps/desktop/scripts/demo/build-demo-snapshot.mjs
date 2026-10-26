#!/usr/bin/env node
/**
 * Writes the browser-preview snapshot for the public demo of ADE: a made-up
 * project ("acme-shop") whose lanes and chats render in the real renderer
 * through `browserMock.ts`. The chat events use the exact shapes ADE writes to
 * `.ade/transcripts/<session>.chat.jsonl` (user_message, status, reasoning,
 * text, subagent_started/progress/result, turn_diff_summary, done), so the
 * transcript is drawn by the real chat components.
 *
 * Nothing here comes from a user's machine. Usage:
 *   node scripts/demo/build-demo-snapshot.mjs [out.json]
 * Default output: src/renderer/browser-mock-ade-snapshot.generated.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] ?? path.join(here, "../../src/renderer/browser-mock-ade-snapshot.generated.json"));

const ROOT = "/Users/demo/Projects/acme-shop";
/**
 * One real pull request from ADE's own public repo (arul28/ADE #1811): its
 * title, description, files and passing checks, so the PR screen shows a real
 * PR body. The author shows as the demo account. Refresh with
 * `gh pr view 1811 --json ...` if it ever needs to change.
 */
const REAL_PR = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "real-pr-1811.json"), "utf8"));
const PROJECT_ID = "demo-acme-shop";
const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

/* ── Lanes ───────────────────────────────────────────────────────────── */

function lane(id, name, branch, { primary = false, minutesAgo = 600, ahead = 0, dirty = false, color = null } = {}) {
  return {
    id,
    name,
    description: null,
    laneType: primary ? "primary" : "worktree",
    baseRef: "main",
    branchRef: branch,
    worktreePath: primary ? ROOT : `${ROOT}/.ade/worktrees/${id}`,
    attachedRootPath: null,
    isEditProtected: false,
    parentLaneId: null,
    color,
    icon: null,
    tags: [],
    folder: null,
    status: { dirty, ahead, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    createdAt: at(minutesAgo),
    archivedAt: null,
  };
}

const lanes = [
  lane("lane-main", "main", "main", { primary: true, minutesAgo: 60 * 24 * 30 }),
  lane("lane-checkout", "checkout-fix", "checkout-fix", { minutesAgo: 42, ahead: 3, dirty: true }),
  lane("lane-ios-receipt", "ios-receipt", "ios-receipt", { minutesAgo: 95, ahead: 2 }),
  lane("lane-auth", "workflow-pane", REAL_PR.headBranch, { minutesAgo: 60 * 5, ahead: 4 }),
];

/* ── Chats ───────────────────────────────────────────────────────────── */

function session({ id, laneId, title, provider, model, modelId, minutesAgo, running = false, effort = "medium" }) {
  const laneRow = lanes.find((l) => l.id === laneId);
  return {
    id,
    laneId,
    laneName: laneRow?.name ?? laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: title,
    toolType: `${provider}-chat`,
    title,
    status: running ? "running" : "completed",
    startedAt: at(minutesAgo),
    endedAt: running ? null : at(Math.max(0, minutesAgo - 4)),
    archivedAt: null,
    exitCode: null,
    transcriptPath: `.ade/transcripts/${id}.chat.jsonl`,
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: running ? "running" : "exited",
    resumeCommand: null,
    resumeMetadata: { provider, model, modelId, reasoningEffort: effort, permissionMode: "full-auto" },
    chatSessionId: id,
  };
}

/** Builds one transcript: each call appends a real-shaped event with a rising timestamp. */
function transcript(sessionId, startMinutesAgo) {
  const events = [];
  let ms = NOW - startMinutesAgo * 60_000;
  let sequence = 1;
  const push = (event, stepMs = 1500) => {
    ms += stepMs;
    events.push({ sessionId, timestamp: new Date(ms).toISOString(), event, sequence: sequence++ });
  };
  return { events, push };
}

const mention = (id, effort = "high", perm = "full-auto") => `@model:${id}?effort=${effort}&perm=${perm}`;

/* 1. The lead hands three tasks to three providers. */
function checkoutChat() {
  const id = "demo-chat-checkout";
  const turnId = "turn-checkout-1";
  const t = transcript(id, 38);
  t.push({
    type: "user_message",
    text:
      `Use ${mention("openai/gpt-6-luna")} to fix the checkout total, ` +
      `${mention("anthropic/claude-haiku-5-5", "high", "bypassPermissions")} to review the app, and ` +
      `${mention("opencode/opencode-go/deepseek-v4.1-flash")} to write the tests.`,
    turnId,
  });
  t.push({ type: "status", turnStatus: "started", turnId }, 200);
  t.push({ type: "reasoning", text: "Three parallel tasks on three providers. The checkout fix touches cart.ts; the review is read-only; the tests can start from the current totals.", turnId, itemId: `${turnId}:r1` }, 2500);
  t.push({ type: "text", text: "Starting three subagents: GPT-6 Luna fixes the total, Claude Haiku 5.5 reviews the app, and DeepSeek V4.1 Flash writes the tests.", messageId: "m1", turnId }, 1500);
  const subs = [
    { agentId: "sub-luna", provider: "codex", model: "gpt-6-luna", description: "Fix the checkout total", summary: "Rounding happened per line item. Moved it to the order total in cart.ts and added a regression case. 3 files changed." },
    { agentId: "sub-haiku", provider: "claude", model: "claude-haiku-5-5", description: "Review the app", summary: "Read 18 files. Two real issues: the receipt screen re-fetches the order on every render, and the tax label is hard-coded to USD. Notes are in REVIEW.md." },
    { agentId: "sub-deepseek", provider: "opencode", model: "opencode/opencode-go/deepseek-v4.1-flash", description: "Write the tests", summary: "Added 12 tests for totals, discounts and tax. All 12 pass against the fixed cart.ts." },
  ];
  for (const s of subs) {
    t.push({ type: "subagent_started", taskId: `chat:${s.agentId}`, agentId: s.agentId, provider: s.provider, agentType: s.provider, parentToolUseId: null, description: s.description, background: false, taskType: "subagent", spawnKind: "subagent", model: s.model, turnId }, 900);
  }
  for (let round = 1; round <= 3; round += 1) {
    for (const s of subs) {
      t.push({ type: "subagent_progress", taskId: `chat:${s.agentId}`, agentId: s.agentId, agentType: s.provider, parentToolUseId: null, description: s.description, summary: "", usage: { totalTokens: 9000 * round, toolUses: 3 * round, durationMs: 14000 * round }, lastToolName: round === 3 ? "Edit" : "Read", model: s.model, turnId }, 4000);
    }
  }
  for (const s of subs) {
    t.push({ type: "subagent_result", taskId: `chat:${s.agentId}`, agentId: s.agentId, provider: s.provider, agentType: s.provider, parentToolUseId: null, status: "completed", summary: s.summary, turnId }, 6000);
  }
  t.push({
    type: "text",
    text:
      "All three reported back.\n\n" +
      "- **Checkout:** the total now rounds once, at the end. The $0.01 drift on multi-item carts is gone.\n" +
      "- **Review:** two follow-ups for the receipt screen. I opened a lane for them.\n" +
      "- **Tests:** 12 new tests, all passing.\n\n" +
      "Ready to open the PR when you are.",
    messageId: "m2",
    turnId,
  }, 2500);
  t.push({
    type: "turn_diff_summary",
    turnId,
    beforeSha: "4f1c2a9",
    afterSha: "9b7e3d1",
    files: [
      { path: "src/cart/cart.ts", additions: 18, deletions: 9, status: "M" },
      { path: "src/cart/cart.test.ts", additions: 164, deletions: 0, status: "A" },
      { path: "REVIEW.md", additions: 22, deletions: 0, status: "A" },
    ],
  }, 400);
  t.push({ type: "status", turnStatus: "completed", turnId }, 200);
  t.push({ type: "done", turnId, status: "completed", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5", usage: { inputTokens: 1200, outputTokens: 3400, contextTokens: 41000, requestCount: 9, contextWindow: 1000000 } }, 300);
  return {
    session: session({ id, laneId: "lane-checkout", title: "Fix checkout and write tests", provider: "claude", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5", minutesAgo: 38 }),
    events: t.events,
  };
}

/* 2. A Codex chat that is still working. */
function receiptChat() {
  const id = "demo-chat-receipt";
  const turnId = "turn-receipt-1";
  const t = transcript(id, 2);
  t.push({ type: "user_message", text: "The receipt screen re-fetches the order on every render. Cache it per order id and keep the iOS build green.", turnId });
  t.push({ type: "status", turnStatus: "started", turnId }, 200);
  t.push({ type: "reasoning", text: "ReceiptView calls useOrder inside a render path that runs on every tick of the timer. Hoist the fetch and key it on the order id.", turnId, itemId: `${turnId}:r1` }, 3000);
  t.push({ type: "text", text: "Found it: `ReceiptView` refetches inside the timer's render. Moving the fetch into a cached hook keyed on the order id, then I'll build for the iPhone 17 simulator.", messageId: "m1", turnId }, 2000);
  return {
    session: session({ id, laneId: "lane-ios-receipt", title: "Cache the receipt fetch", provider: "codex", model: "gpt-6-sol", modelId: "openai/gpt-6-sol", minutesAgo: 2, running: true }),
    events: t.events,
  };
}

/* 3. A finished chat whose work became a real PR (see REAL_PR). */
function authChat() {
  const id = "demo-chat-auth";
  const turnId = "turn-auth-1";
  const t = transcript(id, 300);
  t.push({ type: "user_message", text: "When a Claude chat runs a workflow, the side pane only says \"no agent rows published\". Make every workflow agent show up there, live.", turnId });
  t.push({ type: "status", turnStatus: "started", turnId }, 200);
  t.push({ type: "text", text: `Done. ADE took the workflow for a background shell command, so it dropped the workflow's progress updates. The pane now shows each agent live, in a cleaner layout, and clicking an agent opens its transcript. PR #${REAL_PR.number} is open and all checks pass.`, messageId: "m1", turnId }, 90_000);
  t.push({ type: "turn_diff_summary", turnId, beforeSha: "1a2b3c4", afterSha: "5d6e7f8", files: REAL_PR.files.slice(0, 4).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, status: "M" })) }, 400);
  t.push({ type: "status", turnStatus: "completed", turnId }, 200);
  t.push({ type: "done", turnId, status: "completed", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5", usage: { inputTokens: 900, outputTokens: 1800, contextTokens: 22000, requestCount: 5, contextWindow: 1000000 } }, 300);
  return {
    session: session({ id, laneId: "lane-auth", title: "Workflow pane shows each agent live", provider: "claude", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5", minutesAgo: 300 }),
    events: t.events,
  };
}

/** The real PR, as the PRs tab and the chat's PR pane read it. */
const realPrId = `demo-pr-${REAL_PR.number}`;
const realPr = {
  id: realPrId,
  laneId: "lane-auth",
  projectId: PROJECT_ID,
  repoOwner: "acme-labs",
  repoName: "acme-shop",
  githubNodeId: null,
  githubPrNumber: REAL_PR.number,
  githubUrl: `https://github.com/arul28/ADE/pull/${REAL_PR.number}`,
  title: REAL_PR.title,
  headBranch: REAL_PR.headBranch,
  baseBranch: REAL_PR.baseBranch,
  state: "open",
  checksStatus: "passing",
  reviewStatus: "approved",
  mergeConflicts: false,
  additions: REAL_PR.additions,
  deletions: REAL_PR.deletions,
  lastSyncedAt: at(1),
  createdAt: at(60 * 26),
  updatedAt: at(40),
  mergedAt: null,
};
const realPrSnapshot = {
  prId: realPrId,
  detail: {
    prId: realPrId,
    body: REAL_PR.body,
    labels: [],
    assignees: [],
    requestedReviewers: [],
    author: { login: "acme-labs", avatarUrl: null },
    isDraft: false,
    milestone: null,
    linkedIssues: [],
  },
  files: REAL_PR.files.map((f) => ({ ...f, status: f.deletions === 0 && f.additions > 100 ? "added" : "modified", patch: null, previousFilename: null })),
  checks: REAL_PR.checks.map((name, i) => ({ name, status: "completed", conclusion: "success", detailsUrl: null, startedAt: at(70), completedAt: at(66 - (i % 9)) })),
  reviews: [
    { reviewer: "coderabbitai", reviewerAvatarUrl: null, reviewerIsBot: true, state: "commented", body: null, submittedAt: at(120) },
    { reviewer: "acme-labs", reviewerAvatarUrl: null, state: "approved", body: null, submittedAt: at(50) },
  ],
  status: { prId: realPrId, state: "open", checksStatus: "passing", reviewStatus: "approved", isMergeable: true, mergeConflicts: false, behindBaseBy: 0 },
  comments: [],
  commits: [],
};

const chats = [checkoutChat(), receiptChat(), authChat()];

/* ── Files (the @ menu and the Files tab list them) ──────────────────── */

const TREE = {
  "": [["src", "directory"], ["ios", "directory"], ["AGENTS.md", "file"], ["README.md", "file"], ["package.json", "file"], ["tsconfig.json", "file"]],
  src: [["cart", "directory"], ["checkout", "directory"], ["auth", "directory"], ["main.tsx", "file"]],
  "src/cart": [["cart.ts", "file"], ["cart.test.ts", "file"], ["api.ts", "file"]],
  "src/checkout": [["CheckoutPage.tsx", "file"], ["pay.ts", "file"]],
  "src/auth": [["signIn.ts", "file"], ["returnTo.ts", "file"]],
  ios: [["Receipt", "directory"], ["AcmeShop.xcodeproj", "directory"]],
  "ios/Receipt": [["ReceiptView.swift", "file"], ["useOrder.swift", "file"]],
};
const filesTree = Object.fromEntries(Object.entries(TREE).map(([parent, rows]) => [
  parent,
  rows.map(([name, type]) => ({ name, path: parent ? `${parent}/${name}` : name, type, changeStatus: null })),
]));

/**
 * File contents for the demo project, so the Files surface shows a real
 * editor instead of the browser mock's placeholder. Keyed by path, then copied
 * into every lane's workspace.
 */
const FILE_CONTENTS = {
  "README.md": `# acme-shop

Storefront and checkout for Acme.

## Development

\`\`\`bash
npm install
npm run dev      # storefront on :3000
npm test         # unit tests
\`\`\`

## Layout

- \`src/auth\` — sign-in, session, and post-login redirects
- \`ios/Receipt\` — the receipt screen (SwiftUI)
- \`AGENTS.md\` — notes for coding agents working in this repo
`,
  "AGENTS.md": `# Agent notes

- Run \`npm test\` before proposing a commit.
- Keep money in integer cents. Never use floats for totals.
- The receipt screen is SwiftUI under \`ios/Receipt\`.
- Prefer small, reviewable diffs; do not reformat unrelated files.
`,
  "package.json": `{
  "name": "acme-shop",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src"]
}
`,
  "src/auth/signIn.ts": `export type SignInResult =
  | { ok: true; returnTo: string }
  | { ok: false; reason: string };

const SAFE_RETURN_TO = /^\\/(?!\\/)/;

/** Sign in and return the path to land on afterwards. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!email.includes("@")) return { ok: false, reason: "Enter a valid email address." };
  if (password.length < 8) return { ok: false, reason: "Passwords are at least 8 characters." };

  const response = await fetch("/api/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) return { ok: false, reason: "Email or password is incorrect." };

  const body = (await response.json()) as { returnTo?: string };
  const returnTo = body.returnTo && SAFE_RETURN_TO.test(body.returnTo) ? body.returnTo : "/account";
  return { ok: true, returnTo };
}
`,
  "src/auth/returnTo.ts": `const DEFAULT_TARGET = "/account";

/**
 * Keep only same-origin paths. A crafted \`next\` value must never send a
 * freshly signed-in customer to another site.
 */
export function resolveReturnTo(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return DEFAULT_TARGET;
  try {
    const url = new URL(next, "https://shop.example.com");
    return url.origin === "https://shop.example.com" ? url.pathname + url.search : DEFAULT_TARGET;
  } catch {
    return DEFAULT_TARGET;
  }
}
`,
  "ios/Receipt/ReceiptView.swift": `import SwiftUI

struct ReceiptView: View {
    let order: Order

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Receipt")
                    .font(.largeTitle.bold())
                Text(order.number)
                    .font(.subheadline.monospaced())
                    .foregroundStyle(.secondary)

                ForEach(order.lines) { line in
                    HStack {
                        Text(line.title)
                        Spacer()
                        Text(line.total, format: .currency(code: order.currency))
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Order \\(order.number)")
    }
}
`,
  "ios/Receipt/useOrder.swift": `import Foundation

@MainActor
final class OrderStore: ObservableObject {
    @Published private(set) var order: Order?
    @Published private(set) var isLoading = false

    func load(number: String) async {
        isLoading = true
        defer { isLoading = false }
        order = try? await OrderAPI.shared.order(number: number)
    }
}
`,
};

const filesContents = Object.fromEntries(
  Object.entries(FILE_CONTENTS).map(([path, content]) => [
    path,
    { content, encoding: "utf-8", size: content.length, languageId: undefined },
  ])
);


const snapshot = {
  version: 2,
  demo: true,
  exportedAt: new Date(NOW).toISOString(),
  project: { id: PROJECT_ID, name: "acme-shop", rootPath: ROOT, gitDefaultBranch: "main", createdAt: at(60 * 24 * 30) },
  lanes,
  prs: [realPr],
  prSnapshots: [realPrSnapshot],
  prMergeContexts: [],
  integrationWorkflows: [],
  rebaseNeeds: [],
  githubSnapshot: null,
  operations: [],
  sessions: chats.map((c) => c.session),
  chatTranscripts: Object.fromEntries(chats.map((c) => [c.session.id, { path: `${ROOT}/${c.session.transcriptPath}`, events: c.events }])),
  automations: [],
  filesTreeByWorkspace: Object.fromEntries(lanes.map((l) => [l.id, filesTree])),
  filesContentsByWorkspace: Object.fromEntries(lanes.map((l) => [l.id, filesContents])),
  stripInlineDemo: true,
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(`[demo] wrote ${OUT}: lanes=${lanes.length} chats=${chats.length} events=${chats.reduce((n, c) => n + c.events.length, 0)}`);
