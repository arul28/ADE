# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Dependencies
- Node.js (system)
- npm (package manager)
- Electron 40.x (installed via npm)
- sql.js (WASM SQLite, no native compilation needed)
- node-pty (native module, requires electron-rebuild)
- onnxruntime-node (native module for embeddings)

## Environment Variables
- `.env.local` exists at project root (minimal config)
- No external API keys required for mission system development
- AI provider keys are user-configured in ADE Settings, not in env files

## Platform Notes
- macOS (darwin 24.3.0), 14 cores, 36GB RAM
- Electron rebuild may be needed after npm install: `npm run rebuild:native`
