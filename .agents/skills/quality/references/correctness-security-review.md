# Correctness & Security Review

Comprehensive correctness and security audit of a checked-out lane. This is the
correctness half of the thermo dual-review — its companion is the maintainability
rubric in `thermo-nuclear-review.md`, and its ADE-specific rules are in
`ade-review-rules.md`.

You are a security-minded reviewer performing a thorough review of a checked-out
lane. Audit the lane's changes for bugs, changes that break existing features,
and security/safety issues. Be rigorous — nothing should slip through.

---

## Scope

- ONLY report issues in code being **added or modified** on this lane. Focus on
  the diff against the resolved `QUALITY_REVIEW_BASE` (`main` ordinarily; the
  direct parent for a stacked PR).
- Do NOT report pre-existing issues in untouched code.
- Trace cross-module side effects of the changed code even into unchanged files,
  but the *finding* must trace back to something this lane changed.

```bash
git diff "$QUALITY_REVIEW_BASE"
git diff "$QUALITY_REVIEW_BASE" --name-only
```

---

## 1. Breaking Functionality

ADE is a multi-surface system with tight coupling across process and app
boundaries: `apps/desktop` main process ↔ `src/preload` ↔ `src/renderer` ↔
`src/shared` (IPC + types), and `apps/desktop` ↔ `apps/ade-cli` (shared core
services, the `ade actions` registry, the TUI) ↔ `apps/ios` (sync payloads).
A simple change in one place has subtle interactions that break functionality
elsewhere. Trace side effects end-to-end:

- A changed **shared type / IPC contract** (`src/shared/**`, `registerIpc`)
  flows to the preload exposure, every renderer caller, the `ade-cli` RPC path,
  and any mock/test. A field rename or signature change can silently break a
  caller or the CLI. Grep the call sites.
- A changed **main-process service** signature can break every IPC handler and
  renderer component that calls it, **and** the headless/daemon path the CLI
  uses. Verify both the desktop socket path and headless mode.
- A changed **sync / CRR payload or schema** can break the iOS companion or
  desync peers — CRR tables and the iOS SQLite schema do not enforce identical
  constraints (see `ade-review-rules.md` on cr-sqlite).
- A renderer change that depends on a service only present in one runtime mode
  (in-process dev vs runtime-backed/daemon production) can crash in the mode it
  wasn't tested in. This is ADE's most common production-only bug class — see
  `ade-review-rules.md` §1–2.

## 2. Breaking Devex (developer experience)

It is easy to break the ability to run/build/test locally. Catch:

- **Node version assumptions** — the desktop suite runs under Node 22 (`.nvmrc`;
  `node:sqlite` is the DB engine). A change that assumes a newer Node, or that
  trips renderer tests on the default toolchain, is a devex break.
- **Per-app dependency drift** — each app under `apps/` has its own
  `node_modules` + `package-lock.json` (no workspaces). A `package.json` change
  without a regenerated lock file breaks CI's `npm ci`.
- **New required scripts/steps** — a change that forces a developer to run a new
  build step, native rebuild, or flag to keep working. Adding an *alternative*
  way to run something is fine; changing the *existing* way is a devex break.
- **IPC/preload/shared/renderer skew** — leaving any one of the four out of sync
  when an interface changes (a renderer calling a channel the main process no
  longer registers, or vice versa).

## 3. Security & Safety Surface

ADE runs agents and computer-use against the user's machine and stores
credentials. Treat these as the highest-risk class:

- **Computer-use policy & artifact ownership** — policy enforcement and artifact
  ownership are hard requirements that must live in a code path, not in prompt
  guidance. A change that moves enforcement into a prompt, or lets one session's
  capture land in another's proof drawer, is a leak.
- **Secrets at rest** — do not store secrets in plaintext project files when an
  encrypted store already exists (`.ade/secrets`). Flag any new plaintext write
  of a token/key/PIN.
- **Runtime action surface** — new `ade actions` / runtime-action domains must
  enforce the same authorization and scoping as the desktop path they mirror;
  a headless route that skips a check the desktop UI enforces is a leak.
- **Sync / pairing integrity** — changes to sync, pairing PINs, or CRR
  application should not widen who can read/write a peer's data, and must not
  trust remote-supplied IDs without validating ownership.

## 4. Intended Breakage

If you find a high-risk change that is clearly the **intent** of the lane (e.g.
removing a flag, retiring a safeguard) AND the scope is well-constrained, do not
waste the author's time reporting it as a bug. BUT still report it if: the author
seems unaware of the full blast radius, they are likely under-weighting the
negative impact, or the change looks malicious.

## 5. Over-Reporting Calibration

If you mark issues High when they are not, developers stop trusting the review.
Never misreport priority. Trace each issue end-to-end to full confidence before
reporting its severity.

---

## Severity Definitions

These severities drive the synthesis step's dedupe/rank and `/ship`'s merge gate.

- **Blocker** — security/safety hole, data loss, credential or artifact leak, or
  breaks an existing user-facing feature (including "works in dev, crashes in the
  runtime-backed production build"). Must not merge.
- **High** — likely runtime failure, IPC/shared-contract drift that breaks a
  caller or the CLI, missing enforcement on a sensitive path, or a devex break to
  the standard dev loop. Fix before merge.
- **Medium** — correctness bug on an edge path, unhandled error branch, missing
  validation, or debt that will compound.
- **Low** — nit, cosmetic, opportunistic cleanup.

---

## Critical Rules

- **Never present a finding with unfinished research.** You have main-process,
  preload, renderer, CLI, and iOS code in this repo — if a renderer concern
  depends on main-process or daemon behavior, go read it and confirm. Do not say
  "X is a problem unless the service handles it" when you can check the service
  yourself.
- **Audit with fresh eyes first.** Complete your independent audit before reading
  any PR discussion.
- **Then reconcile with PR comments.** If a PR exists and you have
  medium-or-higher findings, read the PR discussion and review-bot comments
  (`gh pr view --comments`, or the `ade-pr-workflows` skill). ADE's bots are
  `@copilot` (first push) and `@codex` (later iterations). Never trust a bot
  finding as fact: validate each against the real code before folding it in, and
  attribute anything you adopt.

---

## Output Per Finding

1. **Severity** — Blocker / High / Medium / Low (per the definitions above)
2. **Location** — `file:line`
3. **Evidence** — the specific code and the end-to-end trace that proves it
4. **Fix** — the recommended change. Mark whether it is unambiguous and
   behavior-preserving (the synthesis step may auto-apply those) or requires
   human judgment (surfaced for the author / `/ship` gate).
