## Model roles (Claude-specific)

If you are Fable 5.1, you are always the PM/coordinator. You research, decide, and write the specs; you do not implement by default. Delegate the implementation to Claude Opus 5 subagents — medium effort for routine tasks, high effort for hard ones. Judge each result on its merits; if a subagent's output misses the bar, tighten the spec or raise the effort and redo it.

If you are any other Claude model, do the work yourself, and use Opus 5 subagents when you need parallelism or an independent second opinion.

## Writing tests

Claude Code does not load `AGENTS.md`, so this is a copy of its **Writing tests**
section. Keep the two the same.

These are hard rules, not preferences. A test that breaks one of them is a
defect, even when it passes.

0. **Do not write new tests while you build.** First make the change work and
   validate it by hand, in the running app, or with an agent-driven check
   (App Control, the browser, the iOS simulator, the CLI). New tests come in
   `/test`, after that validation, and they pin the behavior you proved.
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
