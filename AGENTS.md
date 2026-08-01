# ADE Project Instructions

## About this project

- ADE is a local-first desktop application for orchestrating coding agents, lanes, PR workflows, and proof/artifact capture.
- The main product lives in `apps/desktop` and is built with Electron, React, and TypeScript.
- The ADE CLI lives in `apps/ade-cli` and shares core services with the desktop app.
- State is primarily stored under `.ade/` inside the active project, with runtime metadata in SQLite and machine-local files under `.ade/secrets`, `.ade/cache`, and `.ade/artifacts`.

## Dev loop

Day-to-day work follows a five-stage loop, each stage an agent-folder skill under
`.agents/skills/` (invocable as `/<name>` across runtimes — ADE discovers them via
`apps/desktop/src/shared/agentSkillRoots.ts`, and `.claude/skills` symlinks to
`.agents/skills` for native Claude):

`/context` → work → `/quality` → `/test` → `/ship`

- **/context** — session primer: detects the lane's area and loads only the matching docs + perf skill (never a broad dump).
- **/quality** — dual-track review (correctness/security + maintainability/code-judo); fixes every verified finding at every severity. It gates only a product decision the agent cannot make or a behavior change the branch was not authorized to make.
- **/test** — test steward: prune/consolidate/add + docs/mobile/CLI/TUI parity + CI-mirrored shards; records a named regression test or exact alternate verification for every accepted correctness finding.
- **/ship** — autonomous PR→merge loop (poll → fix → rebase → merge). Run baseline `/quality` and `/test` first; after any ship-loop mutation, ship reruns commit-bound `/quality` revalidation before pushing or merging. Wraps `docs/playbooks/ship-lane.md`.

Utilities (run when relevant, not part of the core loop): **/audit** (targeted bug hunt), **/finalize** (optional pre-push local-CI gate), **/optimize** (perf profiling), **/release** (cut a release).

## Playbooks

- `docs/playbooks/ship-lane.md` — autonomous PR-to-merge driver (poll → fix → rebase → merge). Baseline `/quality` and `/test` run before it; mutation-specific commit-bound quality revalidation runs inside it. Any agent CLI can follow it directly; Claude Code invokes it via the `/ship` skill.

## Working norms

- Preserve existing desktop app patterns before introducing new abstractions.
- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.
- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.
- For ADE CLI changes, verify both headless mode and the desktop socket-backed ADE RPC path.
- For computer-use changes, treat policy enforcement and artifact ownership as hard requirements, not prompt guidance.
- `ade search "<query>" --text` searches everything in ADE (chats, terminal scrollback, PRs, commits, branches, lanes, files, Linear) instead of grepping `.ade/` internals; see the ade-search skill.

## Validation

- Desktop checks:
  - `npm --prefix apps/desktop run typecheck`
  - `npm run test:desktop:sharded`
  - `npm --prefix apps/desktop run build`
  - `npm --prefix apps/desktop run lint`
- ADE CLI checks:
  - `npm --prefix apps/ade-cli run typecheck`
  - `npm --prefix apps/ade-cli run test`
  - `npm --prefix apps/ade-cli run build`
- Run the smallest relevant subset first when iterating, then finish with the broader checks that cover the touched surfaces.
- Run full desktop tests with the root `npm run test:desktop:sharded` command; use single-file or single-shard Vitest commands for iteration.

## Terminology

- Use "lane" for ADE worktrees/branches.
- Use "computer use" for screenshot/video/GUI/browser proof flows.
## Style preferences

- Prefer direct, operational language over marketing phrasing.
- Keep user-facing copy concrete and stateful: say what changed, what is blocked, and what the next action is.
- Use sentence case for headings and labels unless the existing UI pattern is intentionally uppercase.

## Content boundaries

- Do not reframe ADE as a docs site, Mintlify project, or generic template app.
- Do not store secrets in plaintext project files when an encrypted store already exists.
- Do not leave policy enforcement in prompts alone when a code path can enforce it directly.

## Releases via `asc` (App Store Connect CLI)

Release flows live behind `asc` (installed at `/opt/homebrew/bin/asc`). There's no manual IPA/cert shuffling — prefer the CLI end-to-end and consult the `asc-*` skills (`asc-xcode-build`, `asc-testflight-orchestration`, `asc-release-flow`, `asc-signing-setup`, `asc-submission-health`). Auth is keychain-backed (`asc doctor` to verify) with the API key at `~/.apple/asc/keys/AuthKey_*.p8` and `~/.asc/config.json`.

iOS signing gotchas (don't repeat these):

- The iOS project uses **automatic** signing (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM = VQ372F39G6`). `apps/ios/ExportOptions.plist` ships with `signingStyle = manual` + named profiles for CI/archive determinism, but local ad-hoc exports need `signingStyle = automatic` instead (drop the per-bundle profile map).
- The ADE app **embeds an App Clip** (`com.ade.ios.Clip`, target `ADEClip`, added in PR #706) alongside the app (`com.ade.ios`) and widgets (`com.ade.ios.widgets`). A manual-signing export needs a distribution profile for **every** embedded bundle. The clip's — **`ADE App Clip App Store`** (already minted in ASC, bound to the same distribution certs as the app) — is mapped in `ExportOptions.plist`. If a manual export ever fails signing the clip, the profile is missing/expired: re-mint with `asc profiles create --name "ADE App Clip App Store" --profile-type IOS_APP_STORE --bundle 97ZL5TPJB8 --certificate <dist-cert-ids>`. `ExportOptions.auto.plist` avoids the whole issue — Xcode provisions the clip via `-allowProvisioningUpdates`.
- `asc signing fetch` only downloads provisioning profiles and the `.cer` — it does **not** include the private key. Don't expect it to make local signing work on its own.
- Local exports need the App Store Connect API key passed to `xcodebuild` so it can create/fetch missing Distribution assets on demand. Add these flags (in addition to `-allowProvisioningUpdates`):
  ```
  -authenticationKeyPath ~/.apple/asc/keys/AuthKey_WRRA7YU7RA.p8 \
  -authenticationKeyID WRRA7YU7RA \
  -authenticationKeyIssuerID 4d523a6c-e68c-49b2-8560-34e59786d8e3
  ```
  (Pull the current values from `~/.asc/config.json` rather than hard-coding.) This works even when the local keychain has only the Development cert, because xcodebuild provisions the Distribution cert via ASC.
- For the full flow, `asc publish testflight --app <APP_ID> --project apps/ios/ADE.xcodeproj --scheme ADE --version <x.y.z> --build-number <N> --export-options <auto-plist> --group "<Beta Group>" --wait` does archive + export + upload + distribute in one shot.
- After upload, `processingState = VALID` alone isn't enough for TestFlight distribution — you also need `usesNonExemptEncryption` answered (`asc builds update --build-id <ID> --uses-non-exempt-encryption=false`) and the build assigned to a beta group (`asc publish testflight --build <ID> --group "<Group>"`).

Desktop release:

- Tag a commit on `main` with `vX.Y.Z` and push the tag. `.github/workflows/release.yml` triggers, runs the `release-core.yml` job, and publishes a draft GitHub Release with `.dmg`, `.zip`, blockmap, and `latest-mac.yml` assets. The workflow requires the tagged commit to be an ancestor of `origin/main`.
- Draft releases stay unpublished until you flip them (`gh release edit vX.Y.Z --draft=false` or the UI). Don't publish silently.
- Main is protected by a ruleset: admin bypass is required for direct pushes, and the "strict required status checks" rule makes GitHub's "Merge pull request" button reject merges that use a non-linear history (even when the branch already contains `main`). `gh pr merge --admin` hits the same block; merging locally and pushing (admin bypass) is the fallback.

## Cursor Cloud specific instructions

### Environment overview

- **Node.js 22.x** is required (`node:sqlite` is used as the primary database engine).
- Each app under `apps/` has its own independent `node_modules` and `package-lock.json` (no npm workspaces).
- Validation commands are documented in the "Validation" section above.
- The desktop test suite is large; CI shards it. For local iteration, run a single file or one CI-style shard rather than the full suite.

### Working in ADE lanes (worktrees)

- When an agent session runs inside an ADE lane, its working directory is the lane's worktree (e.g. `/path/to/ADE/.ade/worktrees/<lane-slug>/`). **All file reads, edits, and writes MUST target paths under that worktree, never under the main project-root checkout.**
- `grep`, `find`, and Explore agents may return absolute paths rooted at the main checkout. Before editing, translate those paths to the worktree: replace the project root prefix with the worktree root. For example, `/Users/admin/Projects/ADE/apps/desktop/src/foo.ts` becomes `<worktree>/apps/desktop/src/foo.ts`.
- Use relative paths from your working directory whenever possible — they resolve to the worktree automatically.
- If `ADE_REPO_ROOT` is set in the environment, use it as the canonical base for all file operations.
- When launching dev servers (Vite, Electron, etc.) for a lane, run them from the worktree, not the main checkout: `cd <worktree>/apps/desktop && npm run dev:vite`.

### Running the ADE desktop web renderer (Vite-only preview)

- The desktop renderer can run standalone in a browser without Electron via `npm run dev:vite` in `apps/desktop`. This starts Vite on port 5173 with a browser mock for `window.ade`.
- To seed the mock with real data from the ADE database, run `npm run export:browser-mock-ade` in `apps/desktop` first, or let the `predev:vite` hook do it automatically. The export script reads `.ade/ade.db` from the primary project root and writes a snapshot to `src/renderer/browser-mock-ade-snapshot.generated.json`.
- This works from any lane worktree: `cd <worktree>/apps/desktop && npm run dev:vite`. The export script detects worktree paths and resolves the `.ade/ade.db` location from the parent project root.
- For live data (connected to the ADE runtime socket instead of mock data), use `npm run dev:vite:live`. This starts both Vite and a browser-runtime bridge. Note: this calls `ensureRuntime` which may restart a stale dev runtime — avoid if the ADE beta or another runtime is already running on the target socket.
- Open `http://localhost:5173/work` in a browser or ADE's built-in browser to view the Work tab.

### Inspecting the local Electron desktop app with Codex Computer Use on macOS

- To inspect ADE desktop parity locally with Codex Computer Use, launch the dev app from the worktree with `npm run dev` in `apps/desktop`.
- Treat the Electron process spawned by that command as the source of truth, even if the window title or bundle branding says "ADE". In Codex Computer Use, call `list_apps` / `get_app_state` and prefer the `Electron` app entry (`App=com.github.Electron`) over the installed `ADE` app entry (`App=com.ade.desktop`).
- Confirm the Codex Computer Use app state shows an ADE window whose HTML content URL contains `localhost:5173`. That is the local dev Electron surface.
- The first `Electron` window exposed to Codex Computer Use may be DevTools (`Developer Tools - http://localhost:5173/`). Press `Cmd+\`` in the `Electron` app to cycle to the main ADE window before interacting with the app.
- On first launch, the dev app may open to `localhost:5173/#/project` with no project selected. Open the recent `ADE /Users/admin/Projects/ADE` project inside that dev window before comparing desktop parity.
- Do not use Safari as the desktop parity reference. ADE desktop parity should be checked against the Electron app surface unless the task explicitly asks for renderer-only Vite behavior.
- Keep the dev terminal logs visible while inspecting. Useful confirmation lines include `dev launcher using http://localhost:5173`, `DevTools listening on ws://127.0.0.1:9222`, `window.loading_url`, and `renderer.route_change`.

### Pairing the iOS simulator with the desktop dev app on macOS

- When the user wants the ADE iOS app paired to desktop, run the desktop dev app from the active lane's `apps/desktop`, but set `ADE_PROJECT_ROOT` to the ADE project root the phone should sync with. For this local setup, that is commonly `ADE_PROJECT_ROOT=/Users/arul/ADE npm run dev`, even when the code under test is in `/Users/arul/ADE/.ade/worktrees/...`.
- Do not interact with an already-open Xcode GUI window unless the user explicitly says it is the ADE iOS project. Other projects may be open. Prefer `xcodebuild` and `xcrun simctl` for building, installing, launching, and inspecting the simulator.
- The desktop sync PIN can be read or configured through the dev Electron preload once the `localhost:5173` page is running. Use the CDP endpoint printed by the dev app (`http://127.0.0.1:9222/json/list`) and evaluate `window.ade.sync.getStatus()` to verify `pairingPinConfigured`, `pairingPin`, the sync port, and `connectedPeers`.
- A successful simulator pairing is not just the Settings screen showing "Connected". Also verify desktop `connectedPeers > 0`, inspect the simulator database under `xcrun simctl get_app_container <UDID> com.ade.ios data`, and check recent simulator logs for `incoming message failed`, `FOREIGN KEY`, or changeset errors.
- If pairing reaches WebSocket but the phone reports `FOREIGN KEY constraint failed` while applying `changeset_batch`, treat it as an iOS sync/materialization bug until disproven. Desktop CRR tables may not enforce the same foreign keys as the iOS SQLite schema, so valid remote CRDT batches can arrive in an order that local foreign-key checks reject.

### Running the Electron desktop app on Linux

- Set `ADE_DISABLE_HARDWARE_ACCEL=1` — the VM has no real GPU, and without this the app crashes on `WebGL1 blocklisted`.
- `node-pty` ships only macOS/Windows prebuilds. After `npm install`, run `npm --prefix apps/desktop run rebuild:native` to compile `pty.node` for Electron on Linux. Then manually compile the spawn-helper: `cd apps/desktop/node_modules/node-pty && g++ -o build/Release/spawn-helper src/unix/spawn-helper.cc`.
- The `npm run dev` script has a race condition: `predev` clears `dist/`, then tsup + Electron start in parallel, so the first Electron launch fails with "Cannot find module main.cjs" and auto-restarts. To avoid this, pre-build first (`npm run build`) then run the dev launcher directly: `node scripts/normalize-runtime-binaries.cjs && node scripts/ensure-electron.cjs && node scripts/dev.cjs`.
- Alternatively, start Vite and Electron separately for more control: `npx vite --port 5173 --strictPort --force &` then `VITE_DEV_SERVER_URL=http://localhost:5173 npx electron . --no-sandbox`.
- `cr-sqlite` extension binaries are only available for macOS. On Linux the app logs `db.crsqlite_unavailable` as a warning and continues without CRDT sync — this is non-blocking for development.
- The `ADE_PROJECT_ROOT=/workspace` env var tells the main process to auto-open a project at startup. However, there is a timing race: the renderer's initial `getProject()` call may return null before the async project switch completes, causing the welcome screen to appear even though the backend loaded the project. A workaround is to open the project manually via the "Open a project" button in the top bar.
- Computer-use features (screenshot, video capture, GUI automation) are macOS-only (`screencapture`, `osascript`). On Linux these gracefully degrade — the app returns `blocked_by_capability`.
- `electron-builder` config only defines a `mac` target. Distributable Linux builds (deb/AppImage) are not configured, but dev mode works fine.
- The pinned Vitest 0.34.6 does not support `--project`. Use `npx vitest run <specific-test-file>` in `apps/desktop` for targeted tests, `npx vitest run --shard=<n>/8` for a CI-style shard, or `npm run test:desktop:sharded` from the repo root for the full desktop unit workspace.
- In the Cursor Cloud VM the active X display is `:1`, not `:99`. When launching Electron set `DISPLAY=:1`.
- To launch the desktop dev app quickly when the CLI is already built: `npm run dev:desktop -- --skip-runtime-build`.
- To launch the TUI against an already-running dev runtime: `npm run dev:code -- --skip-runtime-build --attach --project-root <path> --workspace-root <path>`.
