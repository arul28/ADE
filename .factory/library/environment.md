# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Platform
- macOS (darwin 24.3.0, Apple Silicon)
- Node.js via Electron 40.x
- 14 CPU cores, 36 GB RAM

## Database
- sql.js ^1.13.0 (SQLite compiled to WASM, runs in-process)
- Database location: `<project_root>/.ade/ade.db`
- No external database server required

## Native Modules
- `node-pty` — terminal emulator, rebuilt via `electron-rebuild`
- `onnxruntime-node` — ONNX inference runtime for embedding model (to be added by W7a)
  - Must be marked as `external` in tsup config
  - Must be excluded from asar packaging
  - Requires `electron-rebuild` after installation

## AI Providers
- Multiple providers configured (Claude, OpenAI, local via Ollama)
- Model selection is user-configurable per feature via `featureModelOverrides` in project config
- No API keys needed for core mission work (uses existing configuration)

## Key Constraints
- sql.js does NOT support `loadExtension()` — no sqlite-vec, no FTS5
- FTS3 is available in the default sql.js WASM build
- Vector search must be implemented in pure TypeScript (cosine similarity)
