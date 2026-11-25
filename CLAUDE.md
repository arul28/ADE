## Model roles (Claude-specific)

If you are Fable 5.2, you are always the PM/coordinator. You research, decide, and write the specs; you do not implement by default. Delegate the implementation to Claude Opus 5 subagents — medium effort for routine tasks, high effort for hard ones. Judge each result on its merits; if a subagent's output misses the bar, tighten the spec or raise the effort and redo it.

If you are any other Claude model, do the work yourself, and use Opus 5 subagents when you need parallelism or an independent second opinion.

## Built for remote machines

Claude Code does not load `AGENTS.md`, so this is a copy of its **Built for
remote machines** section. Keep the two the same.

ADE is built around remote connections. One window drives several machines: a
laptop works on lanes that live on a desktop, a phone drives the brain at home,
and the Work tab lists chats, CLIs and shells from every connected machine at
once. A lane owns its machine, and its chats and terminals live there and only
there.

ADE also works with no computer of your own. Every account has ADE Cloud, one
machine in every machine list and "Run on" menu. Underneath, each cloud lane
has its own computer with its own pin, so the rules below apply to it too.
Reading a cloud lane (saved chats, session copies, its Git summary) comes from
the account and never wakes its computer; only doing (send, run, Git) wakes it.

So every action that can be done for something on another machine (a chat, a
session, a lane, a terminal, a sign-in) has to be sent to **that** machine:

1. **Pass the scope.** A pin addresses one copy on one machine. Pass the
   lane's, session's or copy's address; never null for the tab. `null` exists
   only for this computer's machine-global calls in Settings. A call with no
   pin silently goes to the machine the project tab is bound to; that works in
   local testing and fails whenever the chat's machine is a different one,
   with errors like "Chat session '…' was not found". In a chat subtree, read
   `useChatRuntimeScope().pin` (and `.isActiveBinding` for "is this the tab's
   copy"); on the Work page, the row's `foreignRow.binding` or
   `useWorkSessions().resolveSessionRuntimePin`; on Lanes, the lane router's
   `LaneMachine.pin`; in Settings, `useSettingsMachineScope().pin`. A pin that
   names the tab's own copy costs what no pin cost (preload `isBoundCopyPin`).
   UI that means "another machine" reads `isActiveBinding` or
   `usePinTargetsTab`, never a null pin. Keep the pin for the whole flow: a
   start, its stop, and its status reads go to the same machine.
2. **Make the contract carry it.** A new IPC/preload method that acts on a
   chat, session, lane or terminal takes `pin?: OpenProjectBinding | null` and
   routes a pin through `callPinnedRuntimeAction` (or
   `callPinnedOrBoundRuntimeActionOr`, which does both), and its runtime
   action is reachable remotely (action domain + `actionPolicy`). Inside a
   component, prefer a required `pin` prop over an optional one that quietly
   defaults to the tab's machine.
3. **Key effects on `pin?.key`, not the pin object.** A pin can be rebuilt with
   the same key; an effect keyed on the object restarts (a login shell, a voice
   call) for nothing.
4. **Check it remotely before calling it done.** Ask "what happens if this chat
   is on another machine?" for every new action, and in `/quality` name which
   new calls are scoped and how. When something can genuinely only run on this
   computer, guard it with a clear message (as Cursor Cloud launch does), never
   by letting the call misroute.

## Account-wide features live on the account server

Claude Code does not load `AGENTS.md`, so this is a copy of its **Account-wide
features live on the account server** section. Keep the two the same.

Some things belong to the person, not to a machine: the plan, ADE Cloud credits
(computers and the iPhone), billing, usage counted against a plan, consents and
opt-ins, and services ADE pays for or a partner sponsors (hosted models, ads,
sponsored recommendations). They live on the account server
(`apps/account-directory`, or the Worker that owns that data) and work the
same for an ADE Cloud lane, the person's own computers, the web client and the
phone.

1. **The server decides.** It holds the outside service's keys, stores the
   state, counts the usage and refuses. Desktop, CLI, web and phone read the
   answer and show it. None of them decides it, counts it, or keeps a copy it
   treats as the truth.
2. **One answer everywhere.** Two machines must never disagree. A consent
   given on the phone holds on the laptop and on a cloud lane at once. Store it
   per account, never in `.ade/`, localStorage or one machine's settings.
3. **Machine work stays on the machine.** Running a chat, a terminal or Git
   still goes to the lane's machine by its pin (**Built for remote machines**).
   The account call takes no pin; a cloud lane's computer calls the same
   server with the account token.
4. **Partner keys are Worker secrets.** Never ship a partner's key in the
   desktop app, the CLI or the iPhone app, even when the partner's SDK puts
   it in the client.
5. **Test as any plan with the account test tool.** To act as another plan,
   change an account's limits, add a sponsored tester or flip a server switch
   (ads, the Free rule), use `scripts/cloud-owner.mjs` through
   `ade secrets exec --env CLOUD_OWNER_TOKEN`. It is instant and never
   touches Stripe. Guide: `docs/features/ade-cloud/account-test-tool.md`.

## Main checkout

Claude Code does not load `AGENTS.md`, so this is a copy of its **Main
checkout** section. Keep the two the same.

A project's primary lane (its own folder, not a worktree) is stored with the
name "Primary". Every screen calls it **Main checkout**. This is a UI name
only:

1. Show a lane's name through `laneDisplayName(lane)`
   (`apps/desktop/src/shared/laneDisplayName.ts`), never `lane.name` alone,
   and write new copy as "main checkout", never "Primary lane".
2. Do not change the stored name, the `laneType: "primary"` value, or code
   that matches the primary lane by name (`useDraftMachineRouting.ts`).
3. An ADE Cloud lane computer exists for its one lane. The lane lists leave
   out its main checkout (`crossMachineLanes.ts`).

## Every provider, both surfaces

Claude Code does not load `AGENTS.md`, so this is a copy of its **Every
provider, both surfaces** section. Keep the two the same.

ADE runs 13 agent providers, not two: Claude, Codex, Cursor, Droid, OpenCode,
Pi, Muse, Qwen, Kimi, Grok, Copilot, Devin and Antigravity. The list grows;
read it from `AgentChatProvider` (`apps/desktop/src/shared/types/chat.ts`) and
`LAUNCH_PROFILE_TOOL_TYPE` (`apps/desktop/src/shared/cliLaunch.ts`).

Each provider reaches ADE in two ways, and they behave differently:
- **Chat:** ADE drives the agent through an SDK or protocol (Claude Agent SDK,
  `codex app-server`, the SDK workers, OpenCode's server, ACP). ADE gets typed
  events: turns, tools, subagents, approvals.
- **CLI:** the provider's own program runs in an ADE terminal. ADE sees the
  screen plus whatever signal that CLI gives: Claude Code hooks, Codex's
  OSC 7501 state, or nothing (output guesses).

1. Before you design a fix, list every provider and surface it touches. Do not
   stop after Claude and Codex.
2. For each one, decide: works the same, needs its own code, or not supported.
   Put "not supported" in the capability gate and the UI. Silence is not a
   decision.
3. Read each provider's real mechanism in its adapter
   (`services/chat/*SdkEventMapper.ts`, `services/chat/acpHost/`,
   `services/pty/cliTurnSignals.ts`) or in its docs. Never assume it works
   like Claude.
4. In your report and in `/quality`, name the providers you changed, the ones
   you checked and left as they are, and the ones you could not check.

## Subagents

Claude Code does not load `AGENTS.md`, so this is a copy of its **Subagents**
section. Keep the two the same.

Agents cost the user real usage, and one agent that starts more agents turns
into a tree nobody asked for. These rules apply to every agent in this repo,
including agents started by a skill.

1. **Do the work yourself first.** Start a subagent only when the task is
   large, truly parallel, or needs an independent second opinion. Batch
   related work into one agent instead of one agent per item.
2. **Subagents do not start subagents.** An agent you start is a leaf: it does
   its own work and returns. It starts another agent only when that is
   absolutely necessary, and then only one, and it says so in its report.
3. **Say it in the brief.** Every prompt you give a subagent includes: "Do not
   start subagents or parallel reviewers; do all the work yourself."
4. **Tell the user before you start one.** Name the agent, its model and why,
   in the same message. When the user has asked you to limit agents, a skill
   that says "spawn one agent per track" means: run the tracks yourself, in
   order.
5. **Pick the cheapest model that can do the job.** Leave the most capable
   model for work that needs it.

## Performance budget

Claude Code does not load `AGENTS.md`, so this is a copy of its **Performance
budget** section. Keep the two the same.

`docs/perf/macos-baseline.md` holds ADE's measured performance numbers
(macOS dev build) and a ceiling for each. They came out of a pass that took
the app from unusable to smooth. Do not let them climb back.

1. **Know when it applies.** Your change can move performance when it renders
   lists or long content; adds an effect, timer, poll, subscription or
   animation; adds or changes an IPC call or runtime action; spawns processes
   (git, shells); reads files or databases on a hot path; builds caches or
   large in-memory structures; or adds a surface that loads its own data. CPU,
   GPU and memory all count. When in doubt, it applies.
   Before you add a poll, timer, spawn or periodic job, read **Patterns that
   bloat ADE** in the doc.
2. **Measure before and after, during the work,** with the scripts the doc
   lists, on the same machine and under the same conditions. Follow the doc's
   gotchas: no perf run for idle, GPU, typing or memory numbers; close extra
   windows; keep the warm pass.
3. **Compare with the table.** If a row gets more than 25% worse or crosses
   its ceiling, or your new surface costs far more than comparable rows,
   optimize before you call the work done: profile the hot path, fix it,
   measure again. Do it carefully: keep every feature and the UI as they are,
   and never trade them for a number. `/optimize` and the `ade-perf-*` skills
   hold the methods and the patterns that worked.
4. **Update the table** in the same branch: add a row for a new surface, and
   record new baselines (with the commit) for rows you moved. Never raise a
   ceiling to make a change pass; that needs the user's approval and a
   recorded reason.
5. **Report it.** The PR body lists the rows you measured, with before and
   after numbers. If you could not measure (not on macOS, no display), say so
   and give what you did measure; the service benches run anywhere.

Numbers drift as ADE grows, and that is expected. A spike is not.

## Writing tests

Claude Code does not load `AGENTS.md`, so this is a copy of its **Writing tests**
section. Keep the two the same.

These are hard rules, not preferences. A test that breaks one of them is a
defect, even when it passes.

**The default is no new test.** Add a test only for a critical path: data
loss or corruption; security or privacy; a race or a process/lifecycle seam;
a cross-machine, IPC or sync contract; money (billing, usage, limits); or the
gate itself (code that decides which tests or checks run). Validate
everything else by hand or with an agent, and add no test. A reviewer or a
review bot that asks for a test does not change this (rule 13).

**Never write these:** reads of source or repo files; pins of CSS classes,
pixels, SVG paths, exact copy or helper call order; "X stays removed"; mock
echoes; render-then-`getByText` with no interaction; a constant, enum or
config that has its own keys; a one-bug "regression:" test beside the test
that owns the contract; more `vi.mock(` than `expect(`; a test that depends
on the machine (rule 9).

0. **Do not write new tests while you build.** First make the change work and
   validate it by hand, in the running app, or with an agent-driven check
   (App Control, the browser, the iOS simulator, the CLI). New tests come in
   `/test`, after that validation. If the user asks for tests, write them.
   If an existing test breaks because you changed behavior on purpose, leave
   it for `/test`. **The one exception:** the behavior can only be validated
   by a test (a race, a pure parser, a state machine with no UI or CLI
   surface). Then write the test during the work, and say why in your report.
1. **A test must fail only when behavior breaks.** It must never fail when a
   refactor keeps the behavior. Test through the public seam: the exported
   function, the IPC handler, the service API, what the user sees and does.
2. **List the failure modes while you build.** Write down, as notes in your
   report and not as test code, the ways the contract can fail for a caller.
   `/test` tests those, not the lines you changed.
3. **Never write a tautological test.** No mock echo, no pass-through check,
   no expected value computed with the code under test, no `toBeDefined` on a
   value built two lines above.
4. **Never write a change-detector test.** No `readFileSync` of `.ts`,
   `.tsx`, `.swift`, `.css` or `.yml` to check code text or structure. No pins
   of copy, styling or internal call order.
5. **No regression test without a gap.** A bug fix gets a new test only when no
   existing test fails on the pre-fix code. First extend that test or its table.
6. **Combine before you add.** Trivial cases of one contract are one `it.each`
   table. Extend the module's test file; do not add a sibling file.
7. **Prove that each new test can fail.** Break the behavior, see the test
   fail, restore the code. A test that still passes proves nothing; delete it.
8. **Mock only at process boundaries:** file system, network, child processes,
   Electron APIs, IPC. Never mock the module under test.
9. **A test must not depend on the machine.** Its result must not change with
   the machine's uptime or speed, the wall clock, free ports, the order of
   files, or a cold import or process start inside a 1 s default wait. Fix:
   - Stub the machine reading (uptime, clock, port), or use fake timers.
   - Await the module import or the readiness event before the timed wait.
   - Wait on events, receipts or promises, never on a wall-clock sleep.
   - A ceiling timeout around a real process start is a guard, not a sleep.
10. **Do not replace service tests with end-to-end tests.** Service tests of
    races and seams (process-kill guards, multi-brain claims, token refresh
    order) are the most valuable tests here; an end-to-end run cannot reach them.
11. **No test-only production seam.** Do not add an export, flag, wrapper, or
    hook that no production caller needs.
12. **One contract, one owner.** A second test of the same contract needs a
    failure the owner cannot reach (a transport or lifecycle break).
13. **A request for a test is not a reason for a test.** When a review bot or
    a reviewer asks for "tests for this", ask the critical-path question. If
    the answer is no, decline in one line: "No test: <reason>; validated by
    <how>." The suite has more than 1,300 test files; it must shrink.

`/quality` records a coverage gap. It does not add the test. `/test` adds one
only when it can name the critical path, the failure that turns the test red,
and why no existing test already catches that.

Keep this list the same as the copy in `AGENTS.md` and the **Test value rules**
in `.agents/skills/test/SKILL.md`. Change all three together.

## Running checks

Claude Code does not load `AGENTS.md`, so this is a copy of its **Running
checks** section. Keep the two the same.

Typecheck, lint, and tests cost real agent time. One desktop typecheck is
15–60 seconds, and agents have run typecheck about 5,800 times and tests
about 12,000 times across ADE threads, mostly re-runs after tiny edits. These
rules apply to every agent and every skill.

1. **One check pass, at the end of `/quality`.** After every review fix is
   in, run typecheck for each package the branch touched and the test files
   that cover the touched code (colocated `*.test.ts(x)` and the tests that
   import it). Not the full suite and not all shards.
2. **Never check after every edit.** Batch the edits, then check once. After a
   failure, re-run only the files that failed.
3. **CI is the full gate.** Never run the full sharded suite locally unless
   the user asks or you are running `/finalize`.
4. **Later fixes re-check only their delta.** In `/test` and `/ship`, a fix
   re-runs only the failing CI file, or the tests and typecheck of the package
   that fix touched, once, before the push.
