# Phase 5.5: Compute Backend Abstraction

## Phase 5.5 -- Compute Backend Abstraction (3-4 weeks)

Goal: Abstract lane execution behind a pluggable compute backend interface, enabling lanes to run locally, on a VPS, in Daytona cloud sandboxes, or in E2B microVMs. Add computer use capabilities for agents that need to interact with running applications visually.

### Reference docs

- [features/LANES.md](../features/LANES.md) — compute backend table, lane overlay policies
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Compute Backends settings
- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph

### Dependencies

- Phase 5 complete.
- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).
- Phase 4 complete (CTO agent, memory architecture, learning packs — see `phase-4.md`).

### Workstreams

#### W1: ComputeBackend Interface
- Abstract backend interface with `create`, `destroy`, `exec`, `getPreviewUrl` methods.
- Typed configuration per backend.
- Backend capability discovery (supports Docker, supports preview URLs, etc.).
- Runtime context/profile file mount contract so agent definitions behave consistently across backends.

#### W2: Local Backend Adapter
- Implements `ComputeBackend` for local Docker/process execution.
- Default backend — no additional configuration required.
- Uses host machine resources.

#### W3: Daytona Backend (Opt-in)
- Daytona SDK integration for workspace creation and management.
- Opt-in cloud sandbox compute — never required for ADE functionality.
- Requires API key configuration in Settings.
- Region selection and resource allocation (CPU, RAM, disk).
- Auto-stop timeout for idle workspace cleanup.

#### W4: VPS Backend Stub
- Placeholder adapter for Phase 8 relay integration.
- Interface-compliant but delegates to relay connection.

#### W5: Backend Selection & Config
- Per-project default backend in project settings.
- Per-lane backend override on lane creation.
- Per-mission backend selection by orchestrator based on mission requirements.
- Settings UI for backend configuration.

#### W6: Preview URL Unification
- Preview URLs work across all backends.
- Local: `<lane-slug>.localhost` proxy.
- Daytona: SDK-provided workspace URL.
- VPS: relay-routed preview.

#### W7: E2B Backend (Opt-in)
- Integrate E2B SDK for Firecracker microVM-based sandboxes.
- Workspace creation via E2B API with repo cloning and environment setup.
- Sub-150ms cold start for lightweight agent tasks.
- Desktop sandbox support: full Xfce environment with Chromium, mouse/keyboard APIs, screenshot capture.
- E2B configuration in Settings → Compute Backends:
  - API key
  - Default sandbox template (custom or standard)
  - Resource allocation (CPU, RAM)
  - Auto-stop timeout
- E2B is always opt-in and never required for ADE functionality.

#### W8: Compute Environment Types
- Each compute backend supports multiple environment types:
  - **terminal-only**: Default. Agent gets a shell in a worktree/sandbox. No GUI rendering. Suitable for code changes, test runs, CLI operations.
  - **browser**: Headless browser (Playwright/Puppeteer) available. Agent can launch web apps, navigate, screenshot, interact. Suitable for web application testing and verification.
  - **desktop**: Full virtual desktop (Xvfb + window manager). Agent gets mouse/keyboard control and screenshot/video capture. Suitable for desktop apps (Electron, native), mobile emulators, and any GUI application.
- Environment type is declared by the agent/mission planner based on task requirements.
- Backend capability matrix:
  | Backend | terminal-only | browser | desktop |
  |---------|:---:|:---:|:---:|
  | Local | Yes | Yes (local Playwright) | Yes (local Xvfb) |
  | VPS | Yes | Yes | Yes |
  | Daytona | Yes | Yes | Yes (native computer use API) |
  | E2B | Yes | Yes | Yes (Desktop Sandbox) |

#### W9: Computer Use MCP Tools
- New MCP tools exposed to agents for GUI interaction:
  - `screenshot_environment` — Capture current screen state as PNG. Returns base64-encoded image.
  - `interact_gui` — Execute mouse/keyboard actions: click(x,y), type(text), scroll, key_press, drag. Uses Anthropic's computer use tool format for Claude agents, or equivalent for Codex.
  - `record_environment` — Start/stop video recording of the agent's environment. Produces MP4 artifact.
  - `launch_app` — Start an application in the environment (browser, Electron app, mobile emulator).
  - `get_environment_info` — Return current environment type, resolution, running processes.
- These tools are only available when the compute environment supports GUI interaction (browser or desktop mode).
- **Computer use loop detail**: screenshot → send to model with full action space definition → receive structured actions → execute actions in environment → verify with follow-up screenshot → repeat. Max loop iterations capped (configurable, default 50) and total time limit enforced (configurable, default 300s) to prevent runaway agents. If computer use fails after N consecutive failed attempts (default 3), escalate to human intervention rather than continuing blindly.
- For Claude agents: uses Anthropic's computer use API (`computer_20251124` tool) natively. The tool provides coordinate-based mouse/keyboard actions with screenshot feedback.
- For Codex agents: uses OpenAI's CUA (Computer-Using Agent) API via the Responses API. CUA provides equivalent visual understanding and action capabilities.
- Artifacts produced (screenshots, videos) are automatically attached to the lane or mission.

##### macOS-Specific Capabilities
- **macOS Automator MCP**: AppleScript/JXA integration for scriptable application control. Enables agents to interact with Mac-native apps (Xcode, Finder, System Preferences) via Apple's scripting bridge without requiring pixel-level computer use. More reliable and faster than screenshot-based interaction for supported apps.
- **macOS Accessibility API**: UI automation via the Accessibility framework, functioning as "Playwright for native Mac apps." Agents can enumerate UI elements, read labels/values, click buttons, and fill text fields by accessibility identifier rather than screen coordinates. Preferred over raw computer use when apps expose accessibility metadata.
- **Apple Containers (macOS 26)**: Lightweight VM sandboxing using Apple's native container runtime for agent isolation on macOS. Provides process-level isolation without full VM overhead, suitable for running untrusted agent workloads locally on Apple Silicon.

##### Security Considerations for Computer Use
- **Docker Sandboxes**: Isolate agents in microVMs or containers, each with its own Docker daemon. Prevents agents from accessing host resources or interfering with each other.
- **Filesystem isolation**: Each agent can only access specific directories (project worktree, designated temp). Host filesystem is not mounted into the agent environment.
- **Network isolation**: Default-deny outbound network policy. Required endpoints (npm registry, GitHub API, etc.) must be explicitly whitelisted per agent or per mission.
- **Permission scoping per agent identity**: Agent capabilities are bounded by their role. A careful-reviewer agent gets read-only access even for computer use interactions (can screenshot and inspect but cannot click or type). Write-capable agents are scoped to their lane's worktree.
- **Screen recording consent and data handling**: Computer use sessions that capture screenshots/video must respect user consent preferences configured in Settings. Captured data is stored locally and never transmitted without explicit user action. Recordings are auto-purged after configurable retention period.
- **Reference**: NVIDIA practical security guidance for agentic AI systems, OWASP Agentic AI Top 10 threat categories (prompt injection, excessive agency, insecure output handling).

##### Computer Use Artifact Storage
- Computer use artifacts (screenshots, videos) are stored as lane artifacts and referenced in `.ade/history/`.
- Large binary artifacts are NOT stored in `.ade/` — they are stored in `.ade-artifacts/` (gitignored) or external storage to keep the repository lightweight.
- Artifact metadata (file paths, descriptions, timestamps, dimensions, duration) is stored in `.ade/` for portability and cross-machine access.

#### W10: Validation
- Backend interface contract tests.
- Local backend parity tests (existing behavior preserved).
- Daytona backend integration tests (opt-in, requires API key).
- E2B backend integration tests (opt-in, requires API key).
- Backend selection persistence and override tests.
- Compute environment type selection and capability validation tests.
- Computer use MCP tool tests (screenshot, interact, record, launch, get_environment_info).
- Computer use loop tests (screenshot → model → actions → execute cycle).
- Artifact attachment tests (screenshots, videos auto-attached to lanes and missions).

### Exit criteria

- Lanes can execute on Local, Daytona, E2B, or VPS (stub) backends via unified interface.
- Daytona is fully opt-in with clear configuration in Settings.
- E2B is fully opt-in with clear configuration in Settings.
- Preview URLs work across all backends.
- Backend selection is configurable per-project, per-lane, and per-mission.
- E2B backend creates and manages sandboxes via the E2B SDK.
- Computer use MCP tools (screenshot, interact, record, launch) function across all backends that support GUI.
- Desktop compute environments provide full virtual desktop with mouse/keyboard control.
- Browser compute environments provide headless browser interaction via Playwright.
- Agents can produce visual artifacts (screenshots, videos) that attach to lanes and missions.
