# Phase 5: Play Runtime Isolation

## Phase 5 -- Play Runtime Isolation (5-6 weeks)

Goal: Concurrent lane runtimes without collisions. Full lane environment initialization, port isolation, hostname-based routing, preview URL generation, and deterministic runtime workspace mounts for agent execution.

### Reference docs

- [features/PROJECT_HOME.md](../features/PROJECT_HOME.md) — Run tab (managed processes, stack buttons, test suites)
- [features/LANES.md](../features/LANES.md) — lane/worktree lifecycle, lane types, lane environment init, proxy & preview, overlay policies
- [features/TERMINALS_AND_SESSIONS.md](../features/TERMINALS_AND_SESSIONS.md) — PTY sessions in lane worktrees
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Lane Templates, Proxy & Preview, Browser Profiles settings
- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph (new laneRuntimeService, laneProxyService)

### Dependencies

- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).

### Workstreams

#### W1: Lane Environment Init
- BranchBox-style environment initialization on lane creation.
- Environment file copying/templating with lane-specific values (ports, hostnames, API keys).
- Docker service startup for lane-specific Docker Compose services (databases, caches, queues).
- Dependency installation (`npm install`, `pip install`, etc.).
- Standardized runtime mount points for agent profile/context files.

#### W2: Port Allocation & Lease
- Dynamic port range per lane (e.g., 3000-3099 for lane 1, 3100-3199 for lane 2).
- Lease/release lifecycle with crash recovery.
- Port conflict detection and resolution.

#### W3: Per-Lane Hostname Isolation
- `*.localhost` reverse proxy with a single proxy port routing by Host header.
- Hostname pattern: `<lane-slug>.localhost`.
- Cookie/auth isolation via unique hostname per lane — no cross-lane session leakage.

#### W4: Preview Launch Service
- Generate preview URLs per lane.
- Open in browser with one click.
- Share preview links for quick visual review.

#### W5: Lane Template System
- Templates stored in `local.yaml` defining reusable initialization recipes.
- Template selection available in the Create Lane dialog.
- Templates specify env files, port ranges, Docker compose paths, and install commands.
- Project-level default template in Settings.

#### W6: Auth Redirect Handling
- Redirect URI rewriting per-lane hostname.
- OAuth callback routing to correct lane dev server.
- **State-parameter routing** (recommended approach):
  - Single OAuth callback URL registered with provider: `localhost:8080/oauth/callback`
  - ADE's proxy intercepts all OAuth callbacks at this URL
  - The `state` parameter in OAuth flows (which ADE controls) encodes the originating lane ID
  - Proxy parses the lane ID from the `state` parameter and forwards the callback to the correct lane's dev server
  - This requires zero changes to OAuth provider configuration regardless of how many lanes are running
  - Works with any OAuth provider (GCP, Auth0, GitHub, etc.) since `state` is a standard OAuth 2.0 parameter
- **Hostname-based routing** (alternative for providers supporting wildcards):
  - Register `*.localhost:8080/callback` as redirect URI (where supported)
  - Each lane gets its own hostname: `lane-1.localhost:8080`, `lane-2.localhost:8080`
  - Proxy routes by Host header to the correct lane's dev server
- **Setup assistant**: Settings → Proxy & Preview shows a "Copy Redirect URIs" helper that generates the exact URIs to register with your OAuth provider based on your proxy configuration.

#### W7: LaneOverlayPolicy Extension
- Extend existing `laneOverlayMatcher.ts` for env/port/proxy overlays.
- Per-lane overrides for environment variables, port mappings, proxy settings, and compute backend selection.

#### W8: Runtime Diagnostics
- Lane health checks (process alive, port responding, proxy route active).
- Port conflict detection across lanes.
- Proxy status dashboard.
- Fallback mode when isolation fails.

#### W9: Renderer Updates
- Play controls for isolated preview launch/stop and diagnostics.
- Lane template selection in Create Lane dialog.
- Proxy & preview status indicators in lane list.
- Runtime diagnostics panel.

#### W10: Validation
- Multi-lane collision tests.
- Lease recovery tests on crash/restart.
- E2E tests for lane isolation, proxy routing, env init.
- Port exhaustion and conflict detection tests.

### Exit criteria

- Multiple lanes run simultaneously with deterministic routing.
- Lane environment initialization is automatic and template-driven.
- Per-lane hostname isolation prevents cookie/auth leakage between lanes.
- Preview URLs are generated and shareable.
- Isolation state is visible and manageable from Play.
- Failures provide actionable fallback paths.
