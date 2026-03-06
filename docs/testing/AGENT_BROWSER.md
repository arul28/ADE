# Agent Browser Smoke Testing

Use `agent-browser` against the live Electron app over Chrome DevTools Protocol (CDP).

For ADE, this is the correct path:

- do not use `agent-browser open ...` to test ADE itself
- do use `agent-browser connect <port>` to attach to Electron

Why:

- `open` launches a separate Chromium instance managed by Playwright
- `connect` attaches to the Chromium engine already inside Electron

Official references:

- `agent-browser` CDP mode supports Electron apps
- Playwright `connectOverCDP()` attaches to existing Chromium-based apps

## Prerequisites

- `agent-browser` installed
- Electron dev app running
- remote debugging port reachable

Quick checks:

```bash
which agent-browser
agent-browser --help
```

## Start ADE

From `apps/desktop`:

```bash
pnpm dev
```

By default ADE exposes CDP on `9222`.

To override:

```bash
ADE_ELECTRON_REMOTE_DEBUGGING_PORT=9333 pnpm dev
```

The dev launcher prints the exact endpoint:

```text
[ade] electron CDP endpoint: http://127.0.0.1:9222/json/version
```

## Verify CDP Before Using agent-browser

In a second terminal:

```bash
curl http://127.0.0.1:9222/json/version
```

Expected:

- JSON payload with browser metadata
- no connection refused

If this fails:

- Electron is not running
- Electron crashed before opening a debuggable renderer
- the port is blocked or changed

## Attach agent-browser

Once CDP is live:

```bash
agent-browser connect 9222
agent-browser snapshot -i --json
agent-browser tab
```

## Recommended ADE Workflow

```bash
agent-browser connect 9222
agent-browser snapshot -i --json
agent-browser click @e...
agent-browser snapshot -i --json
```

Use repeated snapshots to discover refs after each UI change.

## Troubleshooting

### `agent-browser open ...` fails

That mode launches its own Playwright Chromium browser.

Fixes:

```bash
agent-browser install
```

Or use a system Chrome build:

```bash
AGENT_BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  agent-browser open https://example.com --headed
```

For ADE, prefer `connect`, not `open`.

### `agent-browser connect 9222` fails

Check CDP first:

```bash
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

If those fail, fix Electron startup first.

### Electron starts and immediately exits

Run with logging:

```bash
ELECTRON_ENABLE_LOGGING=1 ELECTRON_ENABLE_STACK_DUMPING=1 pnpm dev
```

Common causes:

- running in a restricted/headless sandbox
- native Electron crash before renderer load
- port conflicts or environment problems

### Port conflict

Use a different port:

```bash
ADE_ELECTRON_REMOTE_DEBUGGING_PORT=9333 pnpm dev
agent-browser connect 9333
```

## Notes

- `agent-browser` uses a client-daemon architecture and Playwright by default.
- CDP attach is lower fidelity than a native Playwright protocol connection, but it is the intended way to automate Electron with `agent-browser`.
- If you want native macOS window automation instead of Chromium-only automation, use `Peekaboo`.
