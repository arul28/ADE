# Computer Use in ADE — Research & Brainstorm

## What Cursor Built (Cloud Agents + Computer Use)

**Architecture**: Each agent gets an isolated Linux VM with full dev environment. The agent:
1. Clones repo, installs deps, starts dev server
2. Opens a browser, navigates to localhost, interacts with the UI
3. Uses screenshot → reason → act loops to verify work
4. Records video artifacts (MP4) and screenshots (PNG) as proof
5. Produces a merge-ready PR with artifacts attached

**Key results**: 30%+ of merged PRs at Cursor created by autonomous agents. Agents launched from web, desktop, mobile, Slack, GitHub.

**Use cases they demonstrated**:
- Building new features + recording demo videos
- Reproducing security vulnerabilities visually
- Quick UI fixes with before/after verification
- Full docs site testing (45 min walkthrough)

**Underlying tech**: Xvfb + window manager + VNC + noVNC in Docker. Anthropic's `computer_20250124` / `computer_20251124` tool for Claude. OpenAI CUA API for GPT models.

**User pain points** (from forum):
- Auth/env secrets in cloud VMs is hard
- DB setup in isolated environments
- Network allowlisting
- Speed (users want faster iterations)
- Video analysis for self-correction (not just demo) unclear

---

## What ADE Already Plans

ADE's docs are **remarkably well-prepared** for this. Key existing specs:

### Computer Use MCP Tools (AI_INTEGRATION.md:429-454)
Already specified:
- `screenshot_environment` — capture screen → Base64 PNG
- `interact_gui` — mouse/keyboard actions
- `record_environment` — start/stop video → MP4 artifact
- `launch_app` — open any app
- `get_environment_info` — resolution, processes

Provider-specific mappings for Claude and Codex already documented.

### Desktop Environment Stack (AI_INTEGRATION.md:1210-1237)
Full Xvfb pipeline spec'd:
- Xvfb virtual display → Fluxbox/Mutter → VNC → noVNC → xdotool → ffmpeg
- Three tiers: terminal-only, browser, desktop

### Lane Artifacts (LANES.md:714-745)
- `screenshot` and `video` artifact types already first-class
- Auto-attach to lanes, missions, agent runs
- PR integration: screenshots embedded in PR body, videos linked

### Milestone 5 Validation (plans/milestone-5)
- `MissionCloseoutRequirement` supports `"screenshot"`, `"browser_verification"` keys
- CompletionDiagnostic system blocks close if artifacts missing
- Agent-browser capability flag on PhaseCards

### Agent Browser (AGENT_BROWSER.md)
- Playwright via CDP for Electron testing
- Peekaboo mentioned as macOS native alternative

---

## The Gap: Native macOS Computer Use

ADE's current desktop spec is **Linux/Xvfb-based** — great for containerized CI, but doesn't work natively on macOS where ADE runs. Users want to:
- Work on **any** app (Figma, Xcode, native macOS apps, mobile simulators)
- Verify work on the **actual user machine** (not just a container)
- Have agents operate macOS desktop like a human would

### Option A: Ghost OS (Best Native macOS Option)

[ghostwright/ghost-os](https://github.com/ghostwright/ghost-os) — MIT, 554 stars, actively maintained (v2.1.2, March 2026)

**What it does**: 26 MCP tools for full macOS computer use:
- **Perception**: `ghost_context`, `ghost_state`, `ghost_find`, `ghost_read`, `ghost_inspect`
- **Vision**: `ghost_screenshot`, `ghost_annotate` (numbered labels on interactive elements!), `ghost_ground` (ShowUI-2B local VLM)
- **Actions**: `ghost_click`, `ghost_type`, `ghost_hover`, `ghost_drag`, `ghost_scroll`, `ghost_press`, `ghost_hotkey`
- **Window mgmt**: `ghost_focus`, `ghost_window`, `ghost_wait`
- **Recipes**: Self-learning JSON workflows — frontier model figures it out once, small model runs it forever

**Architecture**:
```
AI Agent → MCP Protocol (stdio) → Ghost OS MCP Server (Swift)
  ├── AXorcist (macOS accessibility engine)
  ├── ShowUI-2B (local vision model, fallback)
  ├── Actions (click, type, scroll)
  └── Recipes (self-learning workflows)
```

**Key advantage over screenshot-only approaches**:
- Reads macOS **accessibility tree** — structured, labeled data about every element
- Only falls back to vision (screenshots) when AX tree is insufficient
- `ghost_annotate` produces annotated screenshots with numbered labels — agents don't need to "guess" coordinates

**Integration path**: `brew install ghostwright/ghost-os/ghost-os` → MCP server → ADE workers connect via MCP

### Option B: Anthropic Computer Use (Container-Based)

Docker container with Xvfb + VNC + agent loop. Works great for:
- CI/CD verification
- Isolated testing environments
- Cloud agent sandboxes (like Cursor)

Limitation: Linux-only, containerized, not native macOS.

### Option C: Apple Accessibility API + AppleScript (DIY)

Build our own using:
- `AXUIElement` API for element discovery
- AppleScript for app automation
- `CGWindowListCopyWindowInfo` for screenshots
- `CGEvent` for mouse/keyboard input

Downside: Massive effort. Ghost OS already does this in ~6K lines of Swift.

### Option D: Hybrid (Recommended)

Layer all three:
1. **Ghost OS** for native macOS computer use (any app)
2. **Playwright/CDP** for web/Electron apps (already in plan)
3. **Xvfb containers** for isolated CI verification (already in plan)

---

## How This Ties Into ADE's Mission System

### The Vision: Video-Verified Mission Completion

```
User → "Build a settings page with dark mode toggle"
  │
  CTO Agent → Creates mission, decomposes into phases
  │
  Worker Agent (with computer use):
    1. Writes code in lane worktree
    2. Starts dev server
    3. Opens browser / launches app
    4. Navigates to settings page
    5. Clicks dark mode toggle
    6. Takes screenshots of both states
    7. Records video walkthrough
    8. Attaches artifacts to lane
    9. Reports completion with proof
  │
  Orchestrator → Validates:
    - Tests pass ✓
    - Screenshot artifacts present ✓
    - Video artifact present ✓
    - Browser verification requirement met ✓
  │
  PR Created → Screenshots + video embedded in description
```

### RALPH Loop via Visual Verification

Currently ADE's review loops are code-based. With computer use, you get **visual RALPH**:

```
Review:   Take screenshot → AI analyzes visual output
Assess:   Does it match the design spec? Any visual regressions?
Log:      Record video of the issue / success
Plan:     If visual issue detected, plan fix
Handle:   Apply fix, re-screenshot, re-verify
```

This is the "put an agent into a RALPH loop but via video/image verification" idea. Implementation:

1. **Phase card** specifies `capabilities: ['agent-browser', 'computer-use']`
2. **Worker** receives screenshot/interact tools
3. **After implementation**, worker enters verification loop:
   - `screenshot_environment` → send to vision model
   - Vision model returns structured assessment: `{ matches_spec: bool, issues: [...] }`
   - If issues: fix code → rebuild → re-screenshot → re-assess
   - Loop until passes or max iterations
4. **On success**: `record_environment` captures final demo video
5. **Closeout** requires `"screenshot"` and `"browser_verification"` artifacts

### Working on ANY App Type (Not Just Electron)

With Ghost OS integration:

| App Type | Automation Layer | How |
|----------|-----------------|-----|
| Web apps | Playwright (headless) | Navigate localhost, interact, screenshot |
| Electron apps | CDP + Playwright | Attach to Electron's Chromium via CDP |
| Native macOS apps | Ghost OS (AX tree) | Read accessibility tree, click, type |
| iOS Simulator | Ghost OS + simctl | Launch simulator, Ghost OS automates the window |
| Xcode projects | Ghost OS | Interact with Xcode UI, build, run |
| Figma | Ghost OS (browser) | Automate Figma desktop app or browser |
| Terminal apps | Direct shell | Already supported |
| Docker containers | Xvfb pipeline | For isolated CI environments |

### User-Customizable Computer Use

Let users define **verification recipes** per project:

```json
// .ade/computer-use.json
{
  "verification": {
    "startup": "npm run dev",
    "wait_for": "http://localhost:3000",
    "steps": [
      { "navigate": "/login" },
      { "type": "#email", "text": "test@example.com" },
      { "click": "button[type=submit]" },
      { "screenshot": "after-login" },
      { "assert_visible": ".dashboard" }
    ]
  },
  "demo_recording": {
    "enabled": true,
    "format": "mp4",
    "resolution": "1920x1080"
  }
}
```

Or leverage Ghost OS recipes for non-web flows:

```json
// .ade/recipes/verify-xcode-build.json
{
  "name": "verify-xcode-build",
  "steps": [
    { "tool": "ghost_focus", "app": "Xcode" },
    { "tool": "ghost_hotkey", "keys": "cmd+b" },
    { "tool": "ghost_wait", "condition": "title_contains:Build Succeeded" },
    { "tool": "ghost_screenshot" }
  ]
}
```

---

## Implementation Roadmap Ideas

### Phase 1: Ghost OS Integration (Quick Win)
- Add Ghost OS as optional MCP server dependency
- Wire `ghost_screenshot`, `ghost_click`, `ghost_type` into worker tool registry
- Enable screenshot capture as mission artifacts
- **Time**: Relatively small — MCP is already the protocol

### Phase 2: Visual Verification Loop
- Implement screenshot → vision analysis → fix → re-screenshot loop
- Add `computer-use` capability flag to phase cards
- Wire closeout requirements for `"screenshot"` and `"browser_verification"`
- **Time**: Moderate — builds on existing closeout validation system

### Phase 3: Video Recording & Proof of Work
- Integrate `record_environment` / screen recording
- Auto-attach MP4 artifacts to missions and PRs
- CTO agent can review video summaries instead of reading diffs
- **Time**: Moderate — ffmpeg + artifact pipeline

### Phase 4: Self-Learning Recipes
- Leverage Ghost OS recipe system for repeatable verification
- User defines verification workflows once → agents run them automatically
- Agents can create new recipes from successful workflows
- **Time**: Depends on Ghost OS recipe quality

### Phase 5: Cloud Sandboxes (Cursor-style)
- Spin up Linux VMs for isolated parallel agent work
- Full Xvfb + VNC pipeline per agent
- noVNC for browser-based remote desktop takeover
- **Time**: Significant infrastructure work

---

## Key Technical Decisions to Make

1. **Ghost OS vs. DIY macOS automation**: Ghost OS is MIT, 6K lines Swift, well-maintained. Building our own would duplicate effort. Recommend adopting Ghost OS.

2. **Local-first vs. cloud-first**: Cursor went cloud VMs. ADE's DNA is local-first. Recommend starting with native macOS (Ghost OS) and adding cloud containers later.

3. **Vision model for verification**: Options:
   - Use the same LLM (Claude/GPT) with vision — simple but expensive per screenshot
   - Local VLM (ShowUI-2B via Ghost OS) — free, private, lower quality
   - Hybrid: local VLM for basic checks, frontier model for complex assessment

4. **Recording approach**:
   - macOS native: `screencapture` CLI or ScreenCaptureKit framework
   - ffmpeg x11grab (Linux containers)
   - Ghost OS screenshot sequences → stitch into video

5. **Permission model**: Computer use is powerful and dangerous. Need clear user consent, scope limitations, and the ability to watch/intervene in real-time.

---

## Summary

ADE is **90% of the way there in docs/specs**. The Computer Use MCP tools, artifact system, closeout requirements, and agent-browser are all specified. The main gaps are:

1. **Native macOS support** — Ghost OS fills this perfectly
2. **Visual verification loop** — Screenshot → assess → fix → re-verify
3. **Video proof of work** — Recording + auto-attach to missions/PRs
4. **User-customizable recipes** — Per-project verification workflows
5. **Real-time observation** — Watch agent work via VNC/screen sharing

The combination of Ghost OS (native macOS) + existing Playwright/CDP (web/Electron) + Xvfb containers (CI) gives ADE full-spectrum computer use across any app type, on any platform, user-customizable.
