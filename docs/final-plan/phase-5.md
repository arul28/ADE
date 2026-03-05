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
- Phase 5 has **zero dependency on Phase 4** (CTO + Ecosystem). Both phases depend only on Phase 3 and run fully in parallel with separate agents.

### Execution Order

Workstreams are numbered in dependency order. Hand them to agents sequentially — or in parallel where noted.

```
Wave 1 (start day 1):
  W1: Lane Environment Init & Overlay Policy   ← foundation

Wave 2 (parallel, after W1):
  W2: Lane Template System                     ← needs W1 only
  W3: Port Allocation & Lease                  ← needs W1

Wave 3 (after W3):
  W4: Per-Lane Hostname Isolation & Preview    ← needs W3

Wave 4 (parallel, after W4):
  W5: Auth Redirect Handling                   ← needs W4
  W6: Runtime Diagnostics                      ← needs W1, W3, W4
```

Dependency graph:
```
W1 (Lane Init + Overlay) ──→ W2 (Templates)
         │
         └──→ W3 (Port Allocation) ──→ W4 (Hostname + Preview) ──→ W5 (Auth Redirect)
                                              │
                                              └──→ W6 (Diagnostics)
```

Each workstream includes its own renderer/UI changes and validation tests (no standalone workstreams for these).

### Workstreams

#### W1: Lane Environment Init & Overlay Policy
- BranchBox-style environment initialization on lane creation.
- Environment file copying/templating with lane-specific values (ports, hostnames, API keys).
- Docker service startup for lane-specific Docker Compose services (databases, caches, queues).
- Dependency installation (`npm install`, `pip install`, etc.).
- Standardized runtime mount points for agent profile/context files.
- **Overlay policy**: Extend existing `laneOverlayMatcher.ts` for env/port/proxy overlays. Per-lane overrides for environment variables, port mappings, proxy settings, and compute backend selection.
- **Renderer**: Lane creation dialog shows environment init progress. Overlay config visible in lane settings.

**Tests:**
- Multi-lane collision tests for env init.
- Overlay policy application tests.
- Lane creation end-to-end with env setup.

#### W2: Lane Template System
- Templates stored in `local.yaml` defining reusable initialization recipes.
- Template selection available in the Create Lane dialog.
- Templates specify env files, port ranges, Docker compose paths, and install commands.
- Project-level default template in Settings.
- **Renderer**: Template selector dropdown in Create Lane dialog. Template management in Settings.

**Tests:**
- Template loading and application tests.
- Default template selection.
- Template with all fields populated.

#### W3: Port Allocation & Lease
- Dynamic port range per lane (e.g., 3000-3099 for lane 1, 3100-3199 for lane 2).
- Lease/release lifecycle with crash recovery.
- Port conflict detection and resolution.
- **Renderer**: Port allocation visible in lane detail view.

**Tests:**
- Lease recovery tests on crash/restart.
- Port exhaustion tests.
- Port conflict detection tests.

#### W4: Per-Lane Hostname Isolation & Preview
- `*.localhost` reverse proxy with a single proxy port routing by Host header.
- Hostname pattern: `<lane-slug>.localhost`.
- Cookie/auth isolation via unique hostname per lane — no cross-lane session leakage.
- Generate preview URLs per lane. Open in browser with one click. Share preview links for quick visual review.
- **Renderer**: Preview URL button in lane list. Proxy & preview status indicators in lane detail. Copy preview URL action.

**Tests:**
- Hostname routing tests.
- Cookie isolation tests.
- Preview URL generation.
- E2E proxy routing tests.

#### W5: Auth Redirect Handling
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
- **Renderer**: Setup assistant in Settings → Proxy & Preview shows redirect URI helper.

**Tests:**
- OAuth callback routing tests per lane.
- State parameter encoding/decoding.
- Multi-lane concurrent OAuth flow tests.

#### W6: Runtime Diagnostics
- Lane health checks (process alive, port responding, proxy route active).
- Port conflict detection across lanes.
- Proxy status dashboard.
- Fallback mode when isolation fails.
- **Renderer**: Runtime diagnostics panel accessible from lane detail. Proxy status dashboard in Settings. Health check indicators in lane list.

**Tests:**
- Health check detection (process alive, port responding).
- Proxy status reporting.
- Fallback mode activation on isolation failure.

### Exit criteria

- Multiple lanes run simultaneously with deterministic routing.
- Lane environment initialization is automatic and template-driven.
- Per-lane hostname isolation prevents cookie/auth leakage between lanes.
- Preview URLs are generated and shareable.
- Isolation state is visible and manageable from Play.
- Failures provide actionable fallback paths.
