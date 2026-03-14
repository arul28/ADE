<p align="center">
  <img src="logo/dark.png" alt="ADE" width="200" />
</p>

<h1 align="center">ADE</h1>
<p align="center"><strong>Agentic Development Environment</strong></p>

<p align="center">
  <a href="https://github.com/arul28/ADE/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-purple" alt="License" /></a>
  <a href="https://github.com/arul28/ADE/releases"><img src="https://img.shields.io/github/v/release/arul28/ADE" alt="Release" /></a>
</p>

---

ADE is a desktop application for AI-native software development. It combines agent orchestration, persistent memory, multi-provider AI support, and deep git integration into a single local-first environment. Built with Electron, React, and TypeScript.

## Features

- **Lanes** -- Isolated git worktrees for parallel development with automatic conflict detection
- **CTO Agent** -- Persistent AI team lead with identity, memory, and Linear integration
- **Missions** -- Multi-step orchestrated execution with planning, workers, and approval gates
- **Agent Chat** -- Interactive AI coding with multi-provider support (Claude, Codex, local models)
- **Memory System** -- Persistent knowledge that survives across sessions with semantic search
- **Linear Integration** -- Workflow automation triggered by Linear issues
- **Automations** -- Event-driven background execution with triggers, guardrails, and templates
- **Computer Use** -- Visual verification through screenshot-based proofs
- **Context Packs** -- Structured, bounded context delivery for agents
- **PR Management** -- GitHub PR workflows with stacking, conflict simulation, and queue landing

## Download

Download the latest release for macOS from [GitHub Releases](https://github.com/arul28/ADE/releases).

1. Go to [Releases](https://github.com/arul28/ADE/releases) and download the `.dmg` file
2. Open the `.dmg` and drag ADE to your Applications folder
3. Launch ADE and open a project directory
4. Configure your AI provider (Claude, OpenAI, or local models) in Settings
5. ADE will detect your project stack and set up initial context automatically

ADE auto-updates when new versions are published. You will see an update indicator in the app header when a new version is available.

## Development Setup

```bash
cd apps/desktop
npm install
npm run dev
```

Run checks before submitting changes:

```bash
npm run typecheck
npm test
```

## Documentation

Full documentation is available at [ade-ac1c6011.mintlify.app](https://ade-ac1c6011.mintlify.app).

## Tech Stack

Electron, React, TypeScript, SQLite, Vite, Tailwind CSS

## License

[AGPL-3.0](LICENSE) -- Copyright (c) 2025 Arul Sharma
