# ADE Review Rules

ADE-specific correctness rules for the `/quality` Track A review. These encode
bug classes ADE has actually shipped and had to fix. Each rule is a **check**:
confirm the pattern against the real diff before raising a finding, and verify
any named service/flag still exists (this repo moves fast) rather than asserting
it from this list. Companion: the general `correctness-security-review.md`.

---

## 1. Runtime-backed null services (the #1 production-only crash)

**Class:** A preload IPC route that calls an in-process service directly instead
of going through daemon/runtime routing crashes on a null service in
runtime-backed (production) mode. It works in dev because the in-process service
exists there; it's `null` in the runtime-backed build, so the call throws.

**Check:** For every IPC handler / preload route touched on this lane, confirm it
resolves its service through the same routing the rest of the surface uses. A
handler that reaches for an in-process singleton, or assumes a service is always
constructed, is a Blocker if that path is reachable in the runtime-backed build.

**Trace:** dev (in-process) path **and** runtime-backed/daemon path. A finding
here must show the service is null in the production mode.

## 2. Daemon action-domain wiring

**Class:** A new feature's IPC is wired only in-process and never registered in
the daemon action domain, so it crashes in every real build (the daemon never
routes it). Orchestrator mode hit exactly this.

**Check:** When a lane adds a new action/domain or a new IPC surface, verify it is
reachable through the daemon action domain / `ade actions` registry, not just the
in-process wiring. Cross-check `apps/ade-cli` (`adeRpcServer.ts`, the actions
allowlist) — if the desktop UI can call it but the CLI/headless path can't, the
daemon wiring is missing.

## 3. cr-sqlite CRR constraints

**Class:** cr-sqlite CRDT tables have hard rules that, when violated, corrupt sync
or crash on apply.

**Check:**
- **No unique index** (other than the primary key) on a CRR-tracked table — a
  secondary unique index breaks CRR. Flag any migration that adds one.
- **Operations-table / DB bloat** — watch for unbounded growth in the operations
  table and shared-DB-across-channels contention; prefer the established cleanup
  path over a new one.
- **Schema asymmetry** — desktop CRR tables and the iOS SQLite schema do not
  enforce identical foreign keys. A valid remote CRDT batch can arrive in an
  order that local foreign-key checks reject. Changes to sync payloads or schema
  must consider apply-order on the iOS side.
- A change to the static/headless runtime must still ship the cr-sqlite native
  artifact and resolve it at runtime; a missing extension surfaces as a CRR
  crash, not a clean degrade.

## 4. IPC / preload / shared / renderer contract drift

**Class:** An interface change that updates some but not all of: the main-process
handler, the `src/shared` IPC/type, the preload exposure, the renderer caller,
and the tests/mocks. Any one left behind is a runtime break.

**Check:** For each changed contract, confirm all five points moved together.
Prefer fixing the underlying service or shared type over a renderer-only
workaround. This is High unless proven harmless.

## 5. Fast-mode / serviceTiers loading is per-provider

**Class:** Model fast-mode / service-tier loading differs by provider, and a
change that treats them uniformly silently drops tiers for some providers.

**Check:** Codex always queries the app-server for tiers (its `activateRuntime`
is a no-op); Cursor/Droid gate tiers on `activateRuntime`; the TUI fast toggle
reads from the `models` surface via the `adeApi` wrapper. A change that routes
all providers through one path, or that reads tiers before `activateRuntime` for
a gating provider, is a correctness bug for the affected providers.

## 6. Subagent / runtime capability gating

**Class:** Per-runtime subagent capabilities are not uniform (Codex / Claude /
OpenCode / Cursor / Droid differ; some worker APIs are mode-gated). A change that
assumes a capability exists for all runtimes breaks the ones that lack it.

**Check:** When a lane touches subagent/worker logic, verify the capability is
gated per-runtime, not assumed globally.

## 6.5 Mobile host compatibility contract

**Class:** A new mobile app can auto-update before the user's host brain does. If
sync handshake or command routing becomes strict, the phone cannot connect long
enough to show the update banner or ask the host to update itself.

**Check:** When a lane touches `apps/desktop/src/shared/types/sync.ts`,
`syncHostService`, `syncRemoteCommandService`, iOS `SyncService`, mobile-facing
remote commands, or host update flows, verify:

- `hello_ok` remains additive. Missing new feature flags must degrade to limited
  capability mode, not reject the WebSocket connection.
- `apps/desktop/src/shared/syncMobileCompatibility.ts` includes every host
  command ADE Mobile requires, and the brain advertises missing required actions
  through `features.mobileCompatibility`.
- iOS gates unsupported actions locally before queueing/sending them and keeps
  the connection alive for update guidance.
- Tests cover legacy hosts that omit `mobileCompatibility` and hosts that report
  missing required actions.

## 7. Node / test-env discipline

**Check:** Desktop/renderer tests run under **Node 22** (`.nvmrc`); a newer
default breaks `window.localStorage` and produces spurious renderer failures —
do not "fix" those by editing the tests. Each app has its own lockfile; a
`package.json` change without a regenerated `package-lock.json` is a CI break.

## 8. Worktree path discipline

**Check:** This session runs in a lane worktree (`.ade/worktrees/<lane>/`). Any
edit, generated file, or state path that lands under the project-root checkout
instead of the worktree is wrong — the change ends up on the wrong branch. Flag
absolute paths in the diff that escape the worktree.

## 9. Merge / release policy awareness (advisory, for /ship & /release)

**Check:** `main` is guarded by a ruleset — `gh pr merge` (even `--admin`) can be
rejected for non-linear history; the fallback is a local admin-bypass push. This
isn't a code finding but flag any automation that assumes a plain merge will
succeed.

---

## Output

Same per-finding shape as `correctness-security-review.md`: Severity / Location
(`file:line`) / Evidence (the end-to-end trace) / Fix (mark auto-applyable vs
needs-judgment). A rule firing is only a finding once you've confirmed the
pattern in the actual diff — these are where to look, not a checklist to assert.
