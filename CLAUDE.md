## Model roles (Claude-specific)

If you are Fable 5.1, you are always the PM/coordinator. You research, decide, and write the specs; you do not implement by default. Delegate the implementation to Claude Opus 5 subagents — medium effort for routine tasks, high effort for hard ones. Judge each result on its merits; if a subagent's output misses the bar, tighten the spec or raise the effort and redo it.

If you are any other Claude model, do the work yourself, and use Opus 5 subagents when you need parallelism or an independent second opinion.

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

0. **Do not write new tests while you build.** First make the change work and
   validate it by hand, in the running app, or with an agent-driven check
   (App Control, the browser, the iOS simulator, the CLI). New tests come in
   `/test`, after that validation, and they pin the behavior you proved.
   - When the user asks for tests directly, write them; this rule covers tests
     that nobody asked for.
   - Run existing tests during the work as often as you want. This rule stops
     writing new tests, not running old ones.
   - When an existing test breaks because you changed behavior on purpose,
     leave it for `/test`. Do not bend it during the work.
   - **The one exception:** the behavior can only be validated by a test (a
     race, a pure parser, a state machine with no UI or CLI surface). Then the
     test is the validation tool, and you may write it during the work. Say
     why in your report.
1. **A test must fail only when behavior breaks.** It must never fail when a
   refactor keeps the behavior. Test through the public seam: the exported
   function, the IPC handler, the service API, what the user sees and does.
2. **List the failure modes while you build.** Write down, as notes in your
   report and not as test code, the ways the contract can fail for a caller.
   `/test` tests those, not the lines you changed.
3. **Never write a tautological test.** Do not assert that a mock returns what
   you told it to return. Do not assert that arguments pass through unchanged
   to a mock. Do not compute the expected value with the code under test. Do
   not assert that a constant contains its own substrings.
4. **Never write a change-detector test.** Do not read source files
   (`readFileSync` of `.ts`, `.tsx`, `.swift`) to grep for code or statement
   order. Do not pin CSS classes, pixel values, SVG paths, exact copy, or the
   call order of internal helpers. Do not assert that a removed button, field,
   or option stays removed.
5. **No regression test without a gap.** A bug fix gets a new test only when no
   existing test would fail on the pre-fix code. First, extend the existing
   test for that contract or add a row to its `it.each` table.
6. **Combine before you add.** Trivial cases of one contract are one `it.each`
   table, not many small tests. Extend the existing test file for the module;
   do not create a sibling file for one concern.
7. **Prove that each new test can fail.** Break the behavior on purpose, run the
   test, and see it fail. Then restore the code. A test that still passes
   proves nothing; delete it.
8. **Mock only at process boundaries:** file system, network, child processes,
   Electron APIs, IPC. Never mock the module under test.
9. **Wait on events, receipts, promises, or fake timers — never on wall-clock
   sleeps.** A test that needs a `sleep` or a raised timeout to pass is wrong;
   fix the seam instead.
10. **Do not replace service tests with end-to-end tests.** The most valuable
    tests here are service-level tests of races and seams (process-kill guards,
    multi-brain claims, token refresh order). An end-to-end run cannot reach
    them reliably.
11. **No test-only production seam.** Do not add an export, flag, wrapper, or
    hook that no production caller needs. Test through the real boundary, or
    do not add the test.
12. **One contract, one owner.** A second test of the same contract needs a
    failure the owner cannot reach, such as a transport or lifecycle break.
    Otherwise extend the owner.

`/quality` records a coverage gap. It does not add the test. `/test` adds one
only when it can name the behavior, the failure that turns the test red, and
why no existing test already catches that.
