# User Testing

Testing surface: tools, URLs, setup steps, isolation notes, known quirks.

**What belongs here:** How to start the app, navigate to testable surfaces, tool usage notes, test account setup.

---

## Starting the App
```bash
cd apps/desktop && npm run dev
```
This starts Vite dev server + Electron. The app window opens automatically.

## Testing Tools
- **agent-browser**: Available at `/Users/admin/.factory/bin/agent-browser`. Can open URLs, click, type, take screenshots.
- **vitest**: `cd apps/desktop && npx vitest run` for automated tests.

## Testable Surfaces

### Settings > Memory > Health Tab
- Navigate: Open app → Settings (gear icon or Cmd+,) → Memory section → Health tab/section
- Verify: Entry counts, sweep/consolidation logs, hard limit bars, action buttons, embedding status
- Tools: agent-browser for screenshots and interaction

### Memory Inspector
- Navigate: Open app → Memory Inspector (exact navigation TBD — may be in sidebar or settings)
- Verify: Search with mode toggle (Lexical/Hybrid), Embedded column, search results
- Tools: agent-browser for screenshots

### Settings > AI/Providers
- Navigate: Open app → Settings → Providers section
- Verify: Memory consolidation model selector alongside other feature model overrides
- Tools: agent-browser for screenshots

## Known Quirks
- 31 pre-existing test failures in orchestrator code — ignore these
- 10 pre-existing typecheck errors in orchestrator code — ignore these
- The app uses Electron with React — agent-browser interacts with the renderer window
