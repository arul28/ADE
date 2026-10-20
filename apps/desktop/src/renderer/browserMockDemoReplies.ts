/**
 * Prepared replies for the public demo (`/demo/`, a snapshot marked
 * `demo: true`). A message sent in the demo gets a turn that streams like a
 * real one, with the same event shapes ADE writes to
 * `.ade/transcripts/<session>.chat.jsonl`, so the real chat components draw
 * it. The reply is picked by what the message asks for: models it @-mentions,
 * subagents, the browser, the iOS simulator, a scene, or a plain answer. A
 * line at the end says it is prepared.
 *
 * A model the lead cannot run itself (Codex or OpenCode under a Claude lead)
 * starts as its own chat, the way ADE does it, so it shows in the Work list
 * under the lead's chat.
 */

import { parseModelMentions } from "../shared/modelMentions";

type Emit = (sessionId: string, event: Record<string, unknown>) => void;
type Step = { waitMs: number; event: Record<string, unknown>; sessionId?: string; run?: () => void };

/** A chat a reply starts for a subagent, shown under the lead's chat in the Work list. */
export type DemoChildChat = {
  sessionId: string;
  parentSessionId: string;
  provider: string;
  model: string;
  modelId: string;
  title: string;
};

export type DemoReplyHooks = {
  emit: Emit;
  /** Adds a subagent's own chat to the session list. */
  startChild?: (child: DemoChildChat) => void;
  /** Marks a subagent's chat as finished. */
  finishChild?: (sessionId: string) => void;
};

const PREPARED_NOTICE = "This is a prepared reply for the website demo. In ADE, a real agent does this work on your code.";

/**
 * The reply clock. In the browser it is the wall clock. The website's film
 * capture (`?demoFilm=1`) moves it by hand with `window.__adeDemoFilm.advance(ms)`,
 * so every captured frame shows the reply at an exact moment.
 */
type Scheduled = { at: number; run: () => void };
const manual = { now: 0, queue: [] as Scheduled[] };
let manualClock = false;

export function startManualDemoClock(): void {
  manualClock = true;
  (window as unknown as { __adeDemoFilm?: unknown }).__adeDemoFilm = {
    advance(ms: number): number {
      manual.now += ms;
      const due = manual.queue.filter((item) => item.at <= manual.now).sort((a, b) => a.at - b.at);
      manual.queue = manual.queue.filter((item) => item.at > manual.now);
      for (const item of due) item.run();
      return manual.queue.length;
    },
    pending(): number {
      return manual.queue.length;
    },
  };
}

function schedule(run: () => void, delayMs: number): () => void {
  if (manualClock) {
    const item = { at: manual.now + delayMs, run };
    manual.queue.push(item);
    return () => {
      manual.queue = manual.queue.filter((entry) => entry !== item);
    };
  }
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

const running = new Map<string, Array<() => void>>();

/** Plays one prepared reply. A new message to the same chat cancels the one still playing. */
export function playDemoReply(sessionId: string, text: string, hooks: DemoReplyHooks): void {
  for (const cancel of running.get(sessionId) ?? []) cancel();
  const turnId = `demo-turn-${Date.now().toString(36)}`;
  const steps = withPreparedNote(scriptFor(sessionId, text, turnId, hooks));
  const cancels: Array<() => void> = [];
  let at = 0;
  for (const step of steps) {
    at += step.waitMs;
    cancels.push(schedule(() => {
      step.run?.();
      if (step.event.type) hooks.emit(step.sessionId ?? sessionId, step.event);
    }, at));
  }
  cancels.push(schedule(() => running.delete(sessionId), at + 10));
  running.set(sessionId, cancels);
}

/** Ends the reply's last message with a line that says it is prepared, before the turn closes. */
function withPreparedNote(steps: Step[]): Step[] {
  const lastText = [...steps].reverse().find((step) => step.event.type === "text" && !step.sessionId);
  if (!lastText) return steps;
  const closeAt = steps.findIndex((step) => !step.sessionId && (step.event.type === "turn_diff_summary" || step.event.type === "done" || (step.event.type === "status" && step.event.turnStatus === "completed")));
  const note: Step = { waitMs: 200, event: { ...lastText.event, text: `\n\n*${PREPARED_NOTICE}*` } };
  const at = closeAt === -1 ? steps.length : closeAt;
  return [...steps.slice(0, at), note, ...steps.slice(at)];
}

function scriptFor(sessionId: string, raw: string, turnId: string, hooks: DemoReplyHooks): Step[] {
  const machines = mentionedMachines(raw);
  if (machines.length > 0) return machineScript(turnId, machines);
  const check = /^check out checkout-fix/i.test(raw.trim()) ? (/windows/i.test(raw) ? "windows" : "mac") : null;
  if (check) return checkScript(turnId, check);
  const mentions = mentionedTasks(raw);
  if (mentions.length >= 2) return mentionScript(sessionId, turnId, mentions, hooks);
  const text = raw.toLowerCase();
  if (/\b(subagent|agents|parallel|team|split|orchestrat)/.test(text)) return subagentScript(turnId);
  if (/\b(browser|page|site|web|localhost|click|ui)\b/.test(text)) return browserScript(turnId);
  if (/\b(ios|iphone|simulator|sim|mobile|app store)\b/.test(text)) return simulatorScript(turnId);
  if (/\b(scene|chart|graph|visual|show me|diagram)\b/.test(text)) return sceneScript(turnId);
  return answerScript(turnId);
}

/* ── Building blocks ─────────────────────────────────────────────────── */

function start(turnId: string, thinking: string): Step[] {
  return [
    { waitMs: 200, event: { type: "status", turnStatus: "started", turnId } },
    { waitMs: 60, event: { type: "activity", activity: "thinking", detail: "Thinking through the answer", turnId } },
    { waitMs: 700, event: { type: "reasoning", text: thinking, turnId, itemId: `${turnId}:r1` } },
  ];
}

/** Streams `text` as text deltas of one message, like a model does. */
function say(turnId: string, messageId: string, text: string, chunk = 7, everyMs = 28): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < text.length; i += chunk) {
    steps.push({ waitMs: i === 0 ? 400 : everyMs, event: { type: "text", text: text.slice(i, i + chunk), messageId: `${turnId}:${messageId}`, turnId } });
  }
  return steps;
}

function shell(turnId: string, id: string, command: string, description: string, result: string, takesMs = 900): Step[] {
  const itemId = `${turnId}:${id}`;
  return [
    { waitMs: 350, event: { type: "tool_call", tool: "Bash", args: { command, description }, itemId, logicalItemId: itemId, turnId } },
    { waitMs: takesMs, event: { type: "tool_result", tool: "Bash", result, structured: { stdout: result, exitCode: 0 }, itemId, logicalItemId: itemId, status: "completed", turnId } },
  ];
}

function finish(turnId: string, files?: Array<{ path: string; additions: number; deletions: number; status: string }>): Step[] {
  const steps: Step[] = [];
  if (files) {
    steps.push({ waitMs: 300, event: { type: "turn_diff_summary", turnId, beforeSha: "9b7e3d1", afterSha: "c41d8e2", files } });
  }
  steps.push({ waitMs: 200, event: { type: "status", turnStatus: "completed", turnId } });
  steps.push({
    waitMs: 50,
    event: { type: "done", turnId, status: "completed", model: "claude-opus-5-5", modelId: "anthropic/claude-opus-5-5", usage: { inputTokens: 600, outputTokens: 1400, contextTokens: 46000, requestCount: 4, contextWindow: 1000000 } },
  });
  return steps;
}

/* ── The replies ─────────────────────────────────────────────────────── */

function browserScript(turnId: string): Step[] {
  return [
    ...start(turnId, "Open the checkout in ADE's browser, pay with the test card, and check the total against the cart."),
    ...say(turnId, "m1", "I'll check it in the browser first."),
    ...shell(turnId, "t1", "ade browser open localhost:5173/checkout --text", "Open the checkout page in ADE's browser", "opened: tab-checkout http://localhost:5173/checkout\ntitle    Checkout · acme-shop"),
    ...shell(turnId, "t2", "ade browser fill --tab tab-checkout --selector \"input[name=card]\" 4242424242424242 && ade browser click --tab tab-checkout --text-match Pay", "Pay with the test card", "hit: button \"Pay\"\neffect: observed (navigated to /receipt)"),
    ...shell(turnId, "t3", "ade browser screenshot --tab tab-checkout --text", "Save a screenshot as proof", "saved: receipt.png (1440×900) · filed to the proof drawer"),
    ...say(turnId, "m2", "The checkout works in the browser. I paid with the test card, the receipt shows **$48.00**, and it matches the cart to the cent. I saved a screenshot of the receipt as proof."),
    ...finish(turnId),
  ];
}

function simulatorScript(turnId: string): Step[] {
  return [
    ...start(turnId, "Build the iOS app for the iPhone 17 simulator, tap through checkout, and look at the receipt screen."),
    ...say(turnId, "m1", "Building for the iPhone 17 simulator."),
    ...shell(turnId, "t1", "xcodebuild -scheme AcmeShop -destination 'name=iPhone 17' build && ade apple start --text", "Build and start the iPhone 17 simulator", "** BUILD SUCCEEDED ** (41s)\nbooted iPhone 17 (iOS 27.0) · streaming", 1600),
    ...shell(turnId, "t2", "ade apple tap-element --label Checkout && ade apple tap-element --label Pay", "Tap through checkout", "hit: Button \"Pay\"\neffect: observed (Receipt screen)"),
    ...shell(turnId, "t3", "ade apple record-stop --keep --text", "Save the run as a video", "kept recording 0:14 · filed to the proof drawer"),
    ...say(turnId, "m2", "It works on iPhone. Checkout goes straight to the receipt, the total is **$48.00**, and the receipt no longer re-fetches while the timer runs. I recorded a 14-second video of the run."),
    ...finish(turnId),
  ];
}

function sceneScript(turnId: string): Step[] {
  const scene = [
    "Here are this week's checkout results:",
    "",
    "| Day | Orders | Failed payments |",
    "| --- | ---: | ---: |",
    "| Mon | 412 | 9 |",
    "| Tue | 438 | 7 |",
    "| Wed | 451 | 2 |",
    "| Thu | 497 | 1 |",
    "",
    "Failed payments dropped from 9 to 1 after Tuesday's fix. In ADE I can also draw this as a live chart right in the chat.",
  ].join("\n");
  return [
    ...start(turnId, "Pull the checkout numbers for the week and show the trend."),
    ...shell(turnId, "t1", "psql $DATABASE_URL -c \"select day, orders, failed from checkout_daily where week = current_week\"", "Read this week's checkout numbers", " day | orders | failed\n-----+--------+-------\n Mon |    412 |      9\n Tue |    438 |      7\n Wed |    451 |      2\n Thu |    497 |      1"),
    ...say(turnId, "m1", scene, 9, 22),
    ...finish(turnId),
  ];
}

function subagentScript(turnId: string): Step[] {
  const subs = [
    { agentId: `${turnId}-luna`, provider: "codex", model: "gpt-6-luna", description: "Update the cart API", summary: "Moved rounding to the order total and kept the API shape. 2 files changed." },
    { agentId: `${turnId}-haiku`, provider: "claude", model: "claude-haiku-5-5", description: "Check the iOS receipt", summary: "The receipt screen now reads the cached order. No extra fetches during the timer." },
    { agentId: `${turnId}-deepseek`, provider: "opencode", model: "opencode/opencode-go/deepseek-v4.1-flash", description: "Run the full test suite", summary: "Ran 312 tests. All pass, including the 12 new checkout tests." },
  ];
  const steps: Step[] = [
    ...start(turnId, "Split this into three parallel parts on three providers, then merge the results."),
    ...say(turnId, "m1", "Splitting this three ways: GPT-6 Luna on the API, Claude Haiku 5.5 on iOS, and DeepSeek V4.1 Flash on the tests."),
  ];
  for (const s of subs) {
    steps.push({ waitMs: 500, event: { type: "subagent_started", taskId: `chat:${s.agentId}`, agentId: s.agentId, provider: s.provider, agentType: s.provider, parentToolUseId: null, description: s.description, background: false, taskType: "subagent", spawnKind: "subagent", model: s.model, turnId } });
  }
  for (let round = 1; round <= 2; round += 1) {
    for (const s of subs) {
      steps.push({ waitMs: 700, event: { type: "subagent_progress", taskId: `chat:${s.agentId}`, agentId: s.agentId, agentType: s.provider, parentToolUseId: null, description: s.description, summary: "", usage: { totalTokens: 8000 * round, toolUses: 2 * round, durationMs: 9000 * round }, lastToolName: round === 2 ? "Edit" : "Read", model: s.model, turnId } });
    }
  }
  for (const s of subs) {
    steps.push({ waitMs: 1100, event: { type: "subagent_result", taskId: `chat:${s.agentId}`, agentId: s.agentId, provider: s.provider, agentType: s.provider, parentToolUseId: null, status: "completed", summary: s.summary, turnId } });
  }
  steps.push(...say(turnId, "m2", "All three are done. The API, the iOS receipt and the tests agree, and all 312 tests pass."));
  steps.push(...finish(turnId, [
    { path: "src/cart/api.ts", additions: 12, deletions: 5, status: "M" },
    { path: "ios/Receipt/ReceiptView.swift", additions: 9, deletions: 14, status: "M" },
  ]));
  return steps;
}

/* ── A task per @-mentioned model ────────────────────────────────────── */

type MentionTask = { modelId: string; provider: string; model: string; task: string };

const PROVIDER_BY_PREFIX: Array<[string, string]> = [
  ["anthropic/", "claude"],
  ["openai/", "codex"],
  ["opencode/", "opencode"],
  ["xai/", "grok"],
  ["google/", "gemini"],
];

const MODEL_NAMES: Record<string, string> = {
  "openai/gpt-6-luna": "GPT-6 Luna",
  "openai/gpt-6-sol": "GPT-6 Sol",
  "openai/gpt-6-astra": "GPT-6 Astra",
  "anthropic/claude-haiku-5-5": "Claude Haiku 5.5",
  "anthropic/claude-sonnet-5-5": "Claude Sonnet 5.5",
  "anthropic/claude-opus-5-5": "Claude Opus 5.5",
  "opencode/opencode-go/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
};

function modelName(modelId: string): string {
  return MODEL_NAMES[modelId] ?? modelId.split("/").pop() ?? modelId;
}

/** Each mention with the words after it, up to the next mention or the end of the clause. */
function mentionedTasks(text: string): MentionTask[] {
  const mentions = parseModelMentions(text);
  return mentions.map((mention, index) => {
    const after = text.slice(mention.end, mentions[index + 1]?.start ?? text.length);
    const clause = after.replace(/^[\s,]*(to\s+)?/i, "").split(/[,.;]|\band\b\s*$/i)[0]?.trim() ?? "";
    const task = clause ? clause.charAt(0).toUpperCase() + clause.slice(1) : `Help with this (${modelName(mention.modelId)})`;
    const provider = PROVIDER_BY_PREFIX.find(([prefix]) => mention.modelId.startsWith(prefix))?.[1] ?? "opencode";
    const model = mention.modelId.split("/").slice(provider === "opencode" ? 0 : 1).join("/");
    return { modelId: mention.modelId, provider, model, task };
  });
}

/** What each subagent reports, in the order the message names them: the full report and the lead's one-line recap. */
const TASK_RESULTS = [
  { report: "Rounding happened per line item. I moved it to the order total in cart.ts and added a regression case. 3 files changed.", recap: "the total now rounds once, at the end. The $0.01 drift on multi-item carts is gone." },
  { report: "Read 18 files. Two real issues: the receipt screen re-fetches the order on every render, and the tax label is hard-coded to USD.", recap: "two follow-ups for the receipt screen. I opened a lane for them." },
  { report: "Added 12 tests for totals, discounts and tax. All 12 pass against the fixed cart.ts.", recap: "12 new tests, all passing." },
  { report: "Done. My notes are in this chat.", recap: "done, notes in its chat." },
];

/**
 * The lead (a Claude chat) splits the message into one subagent per mention.
 * Claude models run as its own subagents; every other model starts as an ADE
 * chat of its own under this one.
 */
function mentionScript(sessionId: string, turnId: string, tasks: MentionTask[], hooks: DemoReplyHooks): Step[] {
  const subs = tasks.map((task, index) => {
    const native = task.provider === "claude";
    const agentId = native ? `${turnId}-task-${index + 1}` : `${sessionId}-${task.provider}-${turnId.slice(-4)}${index + 1}`;
    return { ...task, native, agentId, taskId: native ? `toolu_${turnId.slice(-6)}${index + 1}` : `chat:${agentId}`, ...(TASK_RESULTS[index] ?? TASK_RESULTS[3]!) };
  });
  const names = subs.map((sub) => `${modelName(sub.modelId)} ${sub.task.charAt(0).toLowerCase()}${sub.task.slice(1)}`);
  const steps: Step[] = [
    ...start(turnId, `${subs.length} parallel tasks on ${new Set(subs.map((sub) => sub.provider)).size} providers. Start them together, then merge what they report.`),
    ...say(turnId, "m1", `Starting ${subs.length} subagents: ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}.`),
  ];
  for (const sub of subs) {
    steps.push({
      waitMs: 450,
      run: sub.native ? undefined : () => hooks.startChild?.({ sessionId: sub.agentId, parentSessionId: sessionId, provider: sub.provider, model: sub.model, modelId: sub.modelId, title: sub.task }),
      event: { type: "subagent_started", taskId: sub.taskId, agentId: sub.agentId, provider: sub.provider, agentType: sub.native ? "general-purpose" : sub.provider, parentToolUseId: null, description: sub.task, background: false, taskType: "subagent", ...(sub.native ? {} : { spawnKind: "subagent" }), model: sub.model, turnId },
    });
    if (!sub.native) {
      steps.push({ waitMs: 60, sessionId: sub.agentId, event: { type: "user_message", text: sub.task, turnId: `${sub.agentId}-turn` } });
      steps.push({ waitMs: 40, sessionId: sub.agentId, event: { type: "status", turnStatus: "started", turnId: `${sub.agentId}-turn` } });
    }
  }
  for (let round = 1; round <= 3; round += 1) {
    for (const sub of subs) {
      steps.push({ waitMs: 520, event: { type: "subagent_progress", taskId: sub.taskId, agentId: sub.agentId, agentType: sub.native ? "general-purpose" : sub.provider, parentToolUseId: null, description: sub.task, summary: "", usage: { totalTokens: 7000 * round, toolUses: 2 * round, durationMs: 8000 * round }, lastToolName: round === 3 ? "Edit" : "Read", model: sub.model, turnId } });
    }
  }
  for (const sub of subs) {
    if (!sub.native) {
      steps.push({ waitMs: 300, sessionId: sub.agentId, event: { type: "text", text: sub.report, messageId: `${sub.agentId}:m1`, turnId: `${sub.agentId}-turn` } });
      steps.push({ waitMs: 40, sessionId: sub.agentId, event: { type: "status", turnStatus: "completed", turnId: `${sub.agentId}-turn` } });
      steps.push({ waitMs: 20, sessionId: sub.agentId, run: () => hooks.finishChild?.(sub.agentId), event: { type: "done", turnId: `${sub.agentId}-turn`, status: "completed", model: sub.model, modelId: sub.modelId } });
    }
    steps.push({ waitMs: sub.native ? 900 : 500, event: { type: "subagent_result", taskId: sub.taskId, agentId: sub.agentId, provider: sub.provider, agentType: sub.native ? "general-purpose" : sub.provider, parentToolUseId: null, status: "completed", summary: sub.report, turnId } });
  }
  const count = ["", "One", "Both", "All three", "All four"][subs.length] ?? `All ${subs.length}`;
  steps.push(...say(turnId, "m2", `${count} reported back.\n\n` + subs.map((sub) => `- **${sub.task}:** ${sub.recap}`).join("\n") + "\n\nReady to open the PR when you are."));
  steps.push(...finish(turnId, [
    { path: "src/cart/cart.ts", additions: 18, deletions: 9, status: "M" },
    { path: "src/cart/cart.test.ts", additions: 164, deletions: 0, status: "A" },
    { path: "REVIEW.md", additions: 22, deletions: 0, status: "A" },
  ]));
  return steps;
}

/* ── Work on other machines (`@mac:` mentions) ───────────────────────── */

const MACHINE_NAMES: Record<string, string> = { "mac-studio": "Mac Studio", "windows-pc": "Windows PC" };

function mentionedMachines(text: string): string[] {
  return [...text.matchAll(/@mac:([A-Za-z0-9._-]+)/g)].map((match) => MACHINE_NAMES[match[1]!] ?? match[1]!);
}

const CHECK_RESULTS: Record<string, string> = {
  "Mac Studio": "Safari and the iPhone 17 simulator both pass checkout. 312 tests green.",
  "Windows PC": "The Windows build passes, and checkout works in Edge. 312 tests green.",
};

/**
 * The lead starts one chat on each named machine with the real command
 * (`ade chat create --machine "a,b"` starts one child per machine) and waits
 * for both to report back.
 */
function machineScript(turnId: string, machines: string[]): Step[] {
  const list = machines.join(",");
  const steps: Step[] = [
    ...start(turnId, `Run the same checks where each platform really runs: ${machines.join(" and ")}.`),
    ...say(turnId, "m1", `Starting a check on ${machines.join(" and ")}. Each one builds the branch and runs the checkout tests there.`),
    ...shell(
      turnId,
      "t1",
      `ade chat create --machine "${list}" --type subagent --provider claude --model anthropic/claude-sonnet-5-5 --prompt "Check out checkout-fix, build it, and run the checkout tests."`,
      `Start a check on ${machines.join(" and ")}`,
      machines.map((name, i) => `started: chat-${(0x7f3a + i * 0x1d9).toString(16)} on ${name}`).join("\n"),
      700,
    ),
  ];
  const subs = machines.map((name, i) => ({ name, agentId: `${turnId}-on-${i}`, description: `Check on ${name}` }));
  for (const sub of subs) {
    steps.push({ waitMs: 300, event: { type: "subagent_started", taskId: `chat:${sub.agentId}`, agentId: sub.agentId, provider: "claude", agentType: "claude", parentToolUseId: null, description: sub.description, background: false, taskType: "subagent", spawnKind: "subagent", model: "claude-sonnet-5-5", turnId } });
  }
  for (let round = 1; round <= 4; round += 1) {
    for (const sub of subs) {
      steps.push({ waitMs: 650, event: { type: "subagent_progress", taskId: `chat:${sub.agentId}`, agentId: sub.agentId, agentType: "claude", parentToolUseId: null, description: sub.description, summary: "", usage: { totalTokens: 6000 * round, toolUses: 2 * round, durationMs: 9000 * round }, lastToolName: "Bash", model: "claude-sonnet-5-5", turnId } });
    }
  }
  for (const sub of subs) {
    steps.push({ waitMs: 700, event: { type: "subagent_result", taskId: `chat:${sub.agentId}`, agentId: sub.agentId, provider: "claude", agentType: "claude", parentToolUseId: null, status: "completed", summary: CHECK_RESULTS[sub.name] ?? "Checks pass.", turnId } });
  }
  steps.push(...say(turnId, "m2", `${subs.length === 2 ? "Both" : "All"} machines pass.\n\n` + subs.map((sub) => `- **${sub.name}:** ${(CHECK_RESULTS[sub.name] ?? "Checks pass.").split(". ")[0]}.`).join("\n") + "\n\nThe PR is ready to merge."));
  steps.push(...finish(turnId));
  return steps;
}

/** What a check chat on another machine does: fetch the branch, build, test. */
function checkScript(turnId: string, platform: "mac" | "windows"): Step[] {
  const mac = platform === "mac";
  return [
    ...start(turnId, mac ? "Fetch the branch, build the web app and the iOS app, then run checkout in Safari and the simulator." : "Fetch the branch, build for Windows, then run checkout in Edge."),
    ...say(turnId, "m1", "Checking out the branch."),
    ...shell(turnId, "t1", "git fetch origin && git switch checkout-fix", "Get the branch", "Switched to branch 'checkout-fix'\nYour branch is up to date with 'origin/checkout-fix'.", 600),
    ...shell(turnId, "t2", mac ? "npm ci && npm run build" : "npm ci; npm run build:win", mac ? "Build the web app" : "Build for Windows", mac ? "added 1204 packages in 9s\n✓ built in 6.2s" : "added 1204 packages in 14s\n✓ built AcmeShop-Setup.exe in 41s", 900),
    ...shell(turnId, "t3", "npm test -- checkout", "Run the checkout tests", "Test Files  14 passed (14)\n     Tests  312 passed (312)", 900),
    ...shell(
      turnId,
      "t4",
      mac ? "ade apple start --text && ade apple tap-element --label Pay" : "npx playwright test checkout --project=msedge",
      mac ? "Pay on the iPhone 17 simulator" : "Pay in Edge",
      mac ? "booted iPhone 17 (iOS 27.0)\nhit: Button \"Pay\"\neffect: observed (Receipt screen)" : "  ✓ checkout › pays and shows the receipt (3.1s)\n  1 passed (4.0s)",
      900,
    ),
    ...say(turnId, "m2", mac ? "All checks pass on this Mac: 312 tests, Safari, and the iPhone 17 simulator." : "All checks pass on this Windows PC: 312 tests, the Windows build, and Edge."),
    ...finish(turnId),
  ];
}

function answerScript(turnId: string): Step[] {
  return [
    ...start(turnId, "Answer from what is in this repo."),
    ...shell(turnId, "t1", "rg -n \"roundTotal\" src", "Find where totals are rounded", "src/cart/cart.ts:48:  return roundTotal(lines.reduce(sum, 0));\nsrc/cart/cart.test.ts:12:  expect(roundTotal(0.105)).toBe(0.11);"),
    ...say(turnId, "m1", "Totals round **once**, in `src/cart/cart.ts` at line 48, after the line items are added up. Before the fix, each line was rounded on its own, which made multi-item carts drift by a cent. The new tests in `cart.test.ts` cover that case.\n\nWant me to open the PR?"),
    ...finish(turnId),
  ];
}
