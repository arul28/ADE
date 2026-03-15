# Plan: Add "Dev Tools" Step to Project Onboarding

## Context

The project onboarding wizard (not CTO onboarding) currently has 4 steps: ai → github → linear → context. Users need git installed locally to use ADE at all, and the gh CLI makes PR workflows smoother. We're adding a new first step that checks for both before the user proceeds.

- **git** — Required. Cannot finish onboarding without it.
- **gh** (GitHub CLI) — Recommended but not required.

## Approach

Add a new **"Dev tools"** step as the **first step** in the wizard: `tools → ai → github → linear → context`. This step runs detection on mount, shows clear status for each tool, and blocks progression if git is missing.

We create a dedicated `devToolsService` (not mixing into the existing `agentToolsService`, which handles coding assistants like Claude Code/Codex/Aider). The detection reuses the same `which()` + `spawnAsync()` pattern already proven in `agentToolsService.ts`.

---

## Files to Create

### 1. `apps/desktop/src/shared/types/devTools.ts` — New type

```typescript
export type DevToolStatus = {
  id: "git" | "gh";
  label: string;
  command: string;
  installed: boolean;
  detectedPath: string | null;
  detectedVersion: string | null;
  required: boolean;
};

export type DevToolsCheckResult = {
  tools: DevToolStatus[];
  platform: NodeJS.Platform;
};
```

### 2. `apps/desktop/src/main/services/devTools/devToolsService.ts` — Backend service

- Define two tool specs: `git` (required) and `gh` (not required)
- Copy the `which()`, `spawnAsync()`, `readVersion()`, `detectOneTool()` pattern from `agentToolsService.ts` (lines 19-92)
- Export `createDevToolsService({ logger })` returning `{ detect(force?: boolean): Promise<DevToolsCheckResult> }`
- 30s TTL cache with `force` bypass for the "Re-check" button
- Include `platform: process.platform` in the result so the frontend knows which install instructions to show

### 3. `apps/desktop/src/renderer/components/onboarding/DevToolsSection.tsx` — Frontend component

- Calls `window.ade.devTools.detect()` on mount
- Two cards using existing design tokens (`cardStyle`, `COLORS`, `SANS_FONT`, `MONO_FONT`, `inlineBadge`)
- **git card**: green "INSTALLED" badge + version/path when found; red "NOT INSTALLED" + platform-specific install instructions when missing; "REQUIRED" label
- **gh card**: green "INSTALLED" badge + version/path when found; amber "NOT INSTALLED" + install guidance when missing; "RECOMMENDED" label
- "Re-check" button that re-invokes detection with `force: true`
- Accepts `onStatusChange: (gitInstalled: boolean) => void` prop — called after each detection completes
- Platform-specific install instructions:
  - **macOS**: git → `xcode-select --install` or `brew install git`; gh → `brew install gh`
  - **Windows**: git → git-scm.com; gh → `winget install GitHub.cli`
  - **Linux**: git → `sudo apt install git` / `sudo dnf install git`; gh → cli.github.com

---

## Files to Modify

### 4. `apps/desktop/src/shared/types/index.ts` — Add barrel export
- Add `export * from "./devTools";` (after line 29)

### 5. `apps/desktop/src/shared/ipc.ts` — Add IPC channel
- Add `devToolsDetect: "ade.devTools.detect",` after line 291 (after `agentToolsDetect`)

### 6. `apps/desktop/src/main/main.ts` — Instantiate service
- Import `createDevToolsService` (near line 49, after agentTools import)
- Instantiate `const devToolsService = createDevToolsService({ logger });` (after line 551)
- Add `devToolsService,` to IPC context object (after line 2077)
- Add `devToolsService: null,` to fallback context (after line 2173)

### 7. `apps/desktop/src/main/services/ipc/registerIpc.ts` — Register handler
- Import `createDevToolsService` type (near line 492)
- Add `devToolsService` to `IpcContext` type (after line 548)
- Add handler after agentTools handler (after line 2131):
  ```typescript
  ipcMain.handle(IPC.devToolsDetect, async (_event, arg?: { force?: boolean }) => {
    const ctx = getCtx();
    return ctx.devToolsService.detect(arg?.force);
  });
  ```

### 8. `apps/desktop/src/preload/preload.ts` — Expose to renderer
- Add after line 655 (after `agentTools` block):
  ```typescript
  devTools: {
    detect: async (force?: boolean): Promise<DevToolsCheckResult> =>
      ipcRenderer.invoke(IPC.devToolsDetect, { force }),
  },
  ```

### 9. `apps/desktop/src/preload/global.d.ts` — Type declarations
- Add `DevToolsCheckResult` to the import block (line 1+)
- Add after line 594 (after `agentTools` type):
  ```typescript
  devTools: {
    detect: (force?: boolean) => Promise<DevToolsCheckResult>;
  };
  ```

### 10. `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx` — Wire into wizard
- Import `DevToolsSection` from `./DevToolsSection`
- Expand type: `type SetupStep = "tools" | "ai" | "github" | "linear" | "context";`
- Update: `const STEP_ORDER: SetupStep[] = ["tools", "ai", "github", "linear", "context"];`
- Add to `STEP_META`: `tools: { title: "Dev tools", subtitle: "Check for git and GitHub CLI." }`
- Add to `STEP_HEADERS`: `tools: { heading: "Dev tools check", sub: "ADE needs git installed. GitHub CLI is recommended for PR workflows." }`
- Add state: `const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);`
- Add step content: `if (step === "tools") return <DevToolsSection onStatusChange={setGitInstalled} />;`
- Gate buttons:
  - "Continue" disabled on tools step when `gitInstalled !== true`
  - "Finish setup" disabled when `gitInstalled === false`

---

## Key Design Decisions

1. **Separate service, not mixed into agentToolsService** — agent tools (Claude Code, Codex, Aider) are coding assistants; git/gh are system prerequisites with different required/recommended semantics.

2. **First step in wizard** — git is a fundamental prerequisite for everything ADE does. Check it before AI providers or GitHub tokens.

3. **Hard gate on Continue + Finish, but Skip Ahead still works** — the user can explore other steps, but cannot complete onboarding without git. This avoids a dead-end UX while enforcing the requirement.

4. **`force` parameter for re-check** — bypasses the 30s cache so the user can install git and immediately re-verify without waiting.

5. **Platform in response** — include `process.platform` in the detection result so the frontend renders correct install instructions without an extra IPC call.

---

## Detection Strategy (for both git and gh)

Follows the proven pattern from `agentToolsService.ts`:
1. `which()` — runs `command -v <tool>` via login shell (`sh -lc`) on Unix, `where` on Windows. This finds binaries even when Electron is launched from the dock (not terminal).
2. `readVersion()` — runs `<tool> --version`, parses first line of stdout.
3. Returns installed boolean, path, and version string.

**macOS xcode-select edge case**: On macOS, `/usr/bin/git` exists as an xcode-select shim even when CLT isn't installed. Running `git --version` on this shim triggers an install dialog. Our `which()` check finds the shim, but `readVersion()` will timeout or fail if CLT isn't installed → correctly marks git as not installed.

---

## Verification

1. **Build**: `npm run build` in `apps/desktop` — should compile without type errors
2. **Manual test (git installed)**: Open a fresh project → onboarding starts on "Dev tools" step → git shows green "INSTALLED" with version → Continue button enabled → can proceed through all steps → Finish setup works
3. **Manual test (git missing)**: Temporarily rename git binary or mock → step shows red "NOT INSTALLED" with install instructions → Continue disabled → Finish setup disabled from any step → Re-check button works after "installing"
4. **Manual test (gh missing)**: Common case — gh shows amber "NOT INSTALLED" with recommendation → does NOT block Continue or Finish
5. **Skip setup**: Still works from any step, including the tools step
