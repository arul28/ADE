# Windows auto-update: where the time goes

Installing an update on Windows takes about 42-44 s from quit-and-install to the
new version's main-process start, against under 10 s on macOS. This file says
where that time goes, what keeps the relaunch working, and how to measure the
next update.

## Where to read an update

- `%APPDATA%\ade-desktop\ade-update.jsonl`: the desktop's own update log
  (`refresh_ready_before_install`, `runtime_service_uninstalled_before_install`,
  `quit_and_install`, `restart_not_needed`). `~/.ade/runtime/desktop-main.jsonl`
  has no `autoUpdate.*` events.
- `~/.ade/runtime/desktop-main.jsonl`: `desktop.main_started` dates the new
  version's first start (`isPackaged`, version).
- `~/.ade/runtime/install-steps.log`: one timing line per installer step, from
  `apps/desktop/scripts/windows-install-setup.ps1` and
  `apps/desktop/build/ade-update-holders.ps1` (best effort, never fatal):

  ```
  2026-10-06T05:44:19.890Z install-setup service_status_read 0.15s ok
  2026-10-06T05:44:19.939Z install-setup path_shim_install 0.04s ok
  ```

  `windows-firewall-rules.ps1` is not instrumented (several `exit` paths, usually
  a no-op at medium integrity).
- `~/.ade/runtime/brain-service-<hash>.ps1.log` and `.output.log`: supervisor
  and brain starts.
- `%LOCALAPPDATA%\Programs\ADE` file mtimes: when the installer finished writing.

## Where the time goes

- **NSIS extraction** of about 800 MB (about 2,900 files) is nearly all of it.
- The two PowerShell steps left in the install take about 4 s together: service
  removal (2.4-2.9 s) and the terminal-command shim (about 1 s).
- On an update the installer passes `-Updating` (`apps/desktop/build/installer.nsh`),
  so `windows-install-setup.ps1` returns after the shim: it neither registers the
  brain's startup entry nor starts a brain. The relaunched app does both.

Ruled out:

- **Defender's first-touch scan of `ADE.exe`.** A freshly written copy launched
  in 0.36 s (caveat: copied from an already-scanned source).
- **The installer's wait-for-the-app-to-close loop.** `prepareAutoUpdateInstall`
  stops the supervisor and then the brain gracefully (about 2.5 s) before
  handing off, so the loop finds nothing.
- **The download.** `update_downloaded` lands hours before any install.

## The relaunch depends on a silent install

The NSIS target is the assisted installer (`oneClick: false`,
`runAfterFinish: false` in `apps/desktop/package.json`). In that mode
app-builder-lib starts the app from exactly one place, and only when the
installer is both force-run and silent:

```nsis
!else  # assisted
  ${if} ${isForceRun}
  ${andIf} ${Silent}
    !insertmacro doStartApp
  ${endIf}
!endif
```

`runAfterFinish: false` compiles out the finish-page run option, so there is no
other route. That is why `autoUpdateService.ts` calls
`updater.quitAndInstall(true, true)` (silent, force-run). Never change the first
argument back to `false`: the app would install and never come back, and a
visible installer would wait for a click on its finish page.

The hazard: NSIS's `_CHECK_APP_RUNNING` ends in `MessageBox MB_RETRYCANCEL ...
/SD IDCANCEL`, so if `ADE.exe` is still running after two kill attempts, a silent
install answers Cancel and aborts. The graceful stop before the handoff makes
this unlikely, and the existing abort/park path handles an installer that ran and
changed nothing.

## Open

- Why extraction of about 800 MB takes most of the 42-44 s on a fast disk.
