You are working in /Users/arul/ADE/.ade/worktrees/fixing-cli-send-error-099dff5b only. Do not switch repos or lanes.

Goal:
Fix the ADE Work tab bug where sending a prompt to a CLI session shows a blank black terminal with an orange cursor or falls back to a closed-session resume pane instead of a live Claude/Codex session. Then verify it with Computer Use on the live ADE desktop app.

Important context:
- The prior “success” was false. The UI was showing a closed session resume pane, not a live CLI session.
- The user wants the actual live terminal to appear after sending a prompt from the Work tab.
- This must work for both Claude and Codex providers.
- Verification must be visual with Computer Use, not just logs.
- Keep the scope to the Work-tab CLI launch/render path.

What I already learned:
- `useWorkSessions.ts` already opens the optimistic terminal immediately after creating a PTY session.
- `TerminalView.tsx` hydrates missed startup output from `window.ade.sessions.readTranscriptTail(...)`.
- The local-runtime path previously looked suspicious because transcript hydration could miss live PTY output, but the remaining problem now appears to be the actual CLI launch command path, not just rendering.
- The likely place to inspect next is the CLI launch builder in:
  - `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
  - `apps/desktop/src/main/services/ai/providerTaskRunner.ts`
  - anything that generates the Codex/Claude startup command or resume command
- There are existing files already modified in the worktree from earlier attempts:
  - `apps/desktop/src/main/services/adeActions/registry.ts`
  - `apps/desktop/src/main/services/adeActions/registry.test.ts`
  - `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts`
  - `apps/desktop/src/renderer/components/terminals/useWorkSessions.test.ts`

Likely bug shape:
- A bad launch arg / command string is causing the CLI to exit immediately or launch into a resume flow.
- The UI then shows the closed session/resume pane instead of a live terminal.
- There may be a provider-specific mismatch between Claude and Codex startup/resume commands.

What to do:
1. Inspect the actual command generation for Work-tab CLI launches for Claude and Codex.
2. Trace how the session is created, how startup commands are assembled, and how the session gets marked as live vs resumable.
3. Fix the underlying launch command issue, not just the renderer.
4. Keep changes narrow and preserve the existing Work-tab optimistic open behavior unless it is directly part of the bug.
5. Add or update tests around the real failure mode.
6. Verify with focused tests first.
7. Run the desktop dev app and use Computer Use to send a fresh Work-tab prompt like “test message” for both CLI providers if feasible.
8. Confirm visually that the app shows a live terminal session, not the closed resume pane.

Validation expectations:
- Run the smallest relevant tests first.
- Then run whatever broader checks are necessary for the touched code path.
- Use Computer Use for the final proof of the live UI state.
- If you capture proof, make sure it is visual, not just textual.

Useful files to inspect:
- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`
- `apps/desktop/src/main/services/ai/providerTaskRunner.ts`
- `apps/desktop/src/main/services/sessions/sessionService.ts`
- `apps/desktop/src/main/services/ipc/registerIpc.ts`
- `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts`
- `apps/desktop/src/renderer/components/terminals/TerminalView.tsx`
- `apps/desktop/src/renderer/components/terminals/WorkCliSessionHeader.tsx`

Known recent state:
- There was already a false-positive verification run.
- The user is frustrated and wants the actual fix plus proof.
- Stay direct and keep the work scoped to the live CLI launch issue.
