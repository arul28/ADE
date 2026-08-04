# Thermo-Nuclear Code Quality Review

Seven structural standards. The primary question for every finding: does a
"code judo" move exist — a smaller change that makes the code fundamentally
simpler, not just cleaner?

Tone: direct and demanding, not rude. Scope to the diff against the resolved
`QUALITY_REVIEW_BASE` (`main` ordinarily; the direct parent for a stacked PR) —
do not restructure untouched code.

---

## 1. Structural Simplification

Eliminate branches, helpers, and modes — do not polish them. If a function has
three code paths and one is dead or speculative, remove it. If a helper exists
for a single call site, inline it. If a mode flag switches between two behaviors,
split into two functions.

**Ask:** can I delete something and have fewer concepts?

---

## 2. File Size Threshold

Files past 1,000 lines are a code smell. They accumulate unrelated
responsibilities. When a file crosses this threshold:

- Identify distinct responsibilities
- Extract each into its own module
- The original file becomes a thin re-export or coordinator

Do not split mechanically (e.g., "lines 1-500" and "lines 501-1000"). Split by
responsibility. (ADE has genuine large coordinators — `apps/ade-cli/src/cli.ts`,
`adeRpcServer.ts`, `appStore.ts`. Flag growth, but only split along a real
responsibility seam, never mechanically.)

---

## 3. Spaghetti Prevention

Flag ad-hoc conditionals as design problems, not as things to test around.
Patterns that signal spaghetti:

- `if (type === 'X') { ... } else if (type === 'Y') { ... }` repeated in
  multiple files
- Functions that check caller identity to decide behavior
- Boolean parameters that fundamentally change what a function does
- Nested ternaries deeper than one level

The fix is a design change (strategy pattern, separate functions, data-driven
dispatch), not more tests for the branches.

---

## 4. Design Over Acceptance

When behavior stays identical, prefer a clean design over an accepted mess.
If you can restructure code to be simpler while producing the exact same
outputs for the same inputs, do it. "It works" is not a reason to keep a bad
structure.

---

## 5. Direct Code Preferred

Avoid brittle or magical behavior:

- No dynamic property access when static access works
- No `eval`, `new Function`, or runtime code generation
- No string-based dispatch when an object/map literal works
- No reflection or metaprogramming when a plain function call works
- No implicit ordering dependencies between modules

Prefer code that a grep can find and a human can trace.

---

## 6. Type and Boundary Clarity

Challenge unnecessary optionality and type casts:

- `as` casts: why is the type system not enough?
- `!` non-null assertions: why is the value potentially null?
- `any` types: what is the actual shape?
- Optional properties that are always present in practice
- Union types with members that never occur

Every `as`, `!`, and `any` is a question. Most have answers that make the code
stronger. In ADE this matters most at IPC/preload boundaries, where a sloppy
cast hides a contract that will break in runtime-backed mode.

---

## 7. Canonical Layer Logic

Flag feature logic that has leaked into shared paths:

- Feature-specific validation in generic middleware
- Business rules in UI components
- Data transformation in IPC handlers (belongs in the service layer)
- Presentation logic in service functions
- Feature flags checked in shared utilities

Each layer has a job. Feature logic in a shared path means every feature pays
the complexity cost. In ADE, prefer fixing the underlying service or shared type
over layering a renderer-only workaround on top.

---

## Applying the Standards

For each finding:

1. **Cite** — file, line, the specific code
2. **Standard** — which of the 7 applies
3. **Judo move** — the smallest change that resolves it structurally
4. **Auto-fix** — the synthesis step applies it directly if it is unambiguous and
   behavior-preserving

**A judo move must not cost Windows parity.** Windows parity is a default
requirement, and platform handling is exactly the kind of code that reads as
redundant. Before proposing a move, check it against `windows-quirks.md`:
collapsing `pathsEqual` back to `===`, replacing `terminateProcessTree` with
`child.kill()`, folding a `.cmd`/`.ps1`/`PATHEXT` branch into one call,
narrowing a lock check to `EEXIST`, or deleting a "duplicate" `win32` branch are
regressions dressed as simplifications. Standard 5 (direct code) and standard 7
(canonical layers) both prefer the **named cross-platform helper** over an
inlined shortcut — that is the simpler code here, not the platform branch.

Do not list findings you will not fix. Every finding either gets fixed in this
pass or is flagged as requiring human judgment with a clear explanation of why.
