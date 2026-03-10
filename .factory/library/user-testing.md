# User Testing

Testing surface, tools, URLs, setup steps, and known quirks.

**What belongs here:** How to start the app, navigate to testable surfaces, use testing tools, known UI quirks.

---

## Testing Surface

### Starting ADE
```bash
cd /Users/admin/Projects/ADE/apps/desktop && npm run dev
```
This starts both the Vite dev server (port 5173) and Electron.

### CDP / agent-browser
ADE supports Chrome DevTools Protocol when started with `--remote-debugging-port=9222`:
```bash
agent-browser connect 9222
```

### Missions Tab
- Located in left rail (rocket icon), route `/missions`
- Left sidebar: mission list with search/filter
- Main area: mission detail with tabs (Intake, Run, Evidence)
- Modals: create mission dialog, settings, clarification quiz, manual input

### Known Quirks
- App requires `node_modules` to be installed in `apps/desktop/`
- The Vite dev server must be running for the renderer to load
- Hot reload works for renderer changes but main process changes require restart
- `window.ade` is only available in the renderer process (mocked in tests)

## Testing Tools Available
- `agent-browser` — CDP automation for Electron UI testing
- `vitest` — Unit and component tests
- `tsc --noEmit` — Type checking
