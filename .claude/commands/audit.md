---
description: Audit recent work — trace error paths, probe edge cases, fix any bugs or gaps found
---

Audit the work you just did in this session. Don't stop at "it compiles" or "it looks right" — actively go hunting for what's wrong.

1. **Retrace the changes.** List every file you touched. For each, re-read the final state (not just the diff you remember) so you see what actually lives there now.

2. **Trace every error path.** For each changed code path: what happens on empty / nil / malformed input? When an upstream caller passes something unexpected? When a dependency throws or times out? Walk the failure branches, not just the happy path.

3. **Hunt edge cases.** Off-by-ones, empty collections, unicode, concurrency, first-run vs. repeat-run, reduce-motion / accessibility, different device/viewport sizes, streaming vs. terminal states, cancellation, partial failure. Pick the categories that actually apply to what you changed and work through them.

4. **Check the surrounding contract.** Did the change break any callers, tests, types, styling, or invariants elsewhere? Grep for references to anything you removed or renamed and confirm.

5. **Fix what you find.** For each real bug or gap, make the fix directly. For anything genuinely ambiguous, call it out rather than guessing.

6. **Report.** End with a short list: what you checked, what you fixed, and anything you deliberately left alone (and why).

Be honest — if the work was already solid, say so in one line. Don't manufacture busywork.
