# Fix: Logging Service Unbounded File Growth

> **Problem:** `/Users/arul/ADE/.ade/logs/main.jsonl` grew to 56GB because the logging service has no log rotation, no file size cap, and writes debug-level events unconditionally. During development with HMR and multiple agents editing files, `layout.get`, `tilingTree.get`, and `db.flushed` debug events fire many times per second, accumulating to tens of gigabytes.

> **CRITICAL WARNING — DISK SAFETY:** A previous agent session also created a 200GB file at `/private/tmp/claude-501/` from a runaway background bash loop. **NEVER spawn background bash tasks that poll in loops.** Use `TaskOutput` to check agent progress, not `while true` bash scripts. Before finishing, run `du -sh /private/tmp/claude-501/` and `ls -lh /Users/arul/ADE/.ade/logs/` to verify nothing is bloating.

---

## Root Cause

### File: `/Users/arul/ADE/apps/desktop/src/main/services/logging/logger.ts`

The logger uses `fs.appendFileSync()` to write every log entry to `main.jsonl` with:
- **No log level filter** — all `debug`, `info`, `warn`, `error` events are written
- **No log rotation** — file grows forever
- **No file size cap** — no check before writing
- **Synchronous writes** — `appendFileSync` blocks the main process

### High-frequency debug callers:

1. **`layout.get`** — logged in `registerIpc.ts` line ~1717, fires on every `useDockLayout()` mount/update
2. **`tilingTree.get`** — logged in `registerIpc.ts` line ~1733, fires on every `PaneTilingLayout` mount/update
3. **`db.flushed`** — logged in `kvDb.ts` on every database flush (125ms debounce, so up to 8x/second during writes)

During dev with Vite HMR, every file save causes React re-mounts, triggering cascading layout/tiling/db events. With 14 agents editing files concurrently for hours, this produced 56GB of logs.

---

## Required Fixes

### 1. Add log level filtering to the logger

Add a configurable minimum log level. Default to `"info"` in production and `"debug"` only when explicitly enabled (e.g., via env var `ADE_LOG_LEVEL=debug`).

```typescript
// logger.ts
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default to "info" — skip debug unless ADE_LOG_LEVEL=debug
const minLevel = LOG_LEVELS[process.env.ADE_LOG_LEVEL as LogLevel] ?? LOG_LEVELS.info;
```

Only write entries where `LOG_LEVELS[level] >= minLevel`.

### 2. Add log rotation with a file size cap

Before each write (or on a periodic check), rotate the log file when it exceeds a threshold:

- **Max file size:** 10MB per log file
- **Keep:** 2 rotated files max (`main.jsonl`, `main.1.jsonl`)
- **Rotation:** When `main.jsonl` exceeds 10MB, rename it to `main.1.jsonl` (overwriting any existing), create a new empty `main.jsonl`
- **Check frequency:** Don't `stat` on every write — check every 1000 writes or every 60 seconds, whichever comes first

### 3. Switch from `appendFileSync` to async writes

Replace `fs.appendFileSync()` with buffered async writes:
- Buffer log entries in memory (array of strings)
- Flush to disk every 500ms or when buffer exceeds 100 entries
- Use `fs.promises.appendFile()` or a write stream
- This unblocks the main Electron process

### 4. Reduce debug noise from hot-path IPC handlers

In `registerIpc.ts`, either:
- **Remove** the `logger.debug()` calls from `layout.get`, `tilingTree.get` — these are routine cache lookups, not meaningful events
- Or **rate-limit** them: only log the first call per `layoutId`, not every subsequent one

In `kvDb.ts`, reduce `db.flushed` logging:
- Change from `logger.debug` to only log when the byte count changes significantly, or remove entirely since it fires on every 125ms debounce cycle

---

## Files to Modify

1. **`/Users/arul/ADE/apps/desktop/src/main/services/logging/logger.ts`** — Add level filtering, rotation, async writes
2. **`/Users/arul/ADE/apps/desktop/src/main/services/ipc/registerIpc.ts`** — Remove or gate the `layout.get` and `tilingTree.get` debug calls
3. **`/Users/arul/ADE/apps/desktop/src/main/services/state/kvDb.ts`** — Remove or reduce `db.flushed` debug logging

## Verification

After changes:
1. Run `cd /Users/arul/ADE/apps/desktop && npx tsc --noEmit` — zero errors
2. Run `npm run dev`, interact with the app for 2 minutes, then check: `ls -lh .ade/logs/main.jsonl` — should be KB, not MB
3. Verify that `warn` and `error` level messages still appear in the log file
4. Verify rotation works: write a quick test that logs 10MB+ of info events and confirm `main.1.jsonl` is created and `main.jsonl` is reset
