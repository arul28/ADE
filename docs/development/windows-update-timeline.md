# Windows auto-update: where the minutes go

Installing an update on Windows took minutes and the app never came back, while
macOS finishes in under ten seconds once ADE quits. This is the measured account
of what actually happens, reconstructed from one PC's real update history, plus
what is fixed, what is ruled out, and what is still open.

Evidence used, all on the same machine (Windows 11, 239 Hz, single brain):

- `%APPDATA%\ade-desktop\ade-update.jsonl` — ADE's own update log. **This is the
  file to read, not `~/.ade/runtime/desktop-main.jsonl`**, which carries no
  `autoUpdate.*` events at all.
- `~/.ade/runtime/desktop-main.jsonl` — `desktop.main_started`, which dates the
  new version's first breath and reports `isPackaged` and the version.
- `~/.ade/runtime/brain-service-<hash>.ps1.log` / `.output.log` — supervisor and
  brain starts, to the millisecond.
- `%LOCALAPPDATA%\Programs\ADE` file mtimes — when the installer finished writing.

## The timeline of a real update (1.2.91, 2026-10-06)

| time (UTC) | what | source |
|---|---|---|
| 03:15:43.056 | `refresh_ready_before_install` | ade-update.jsonl |
| 03:15:45.552 | `runtime_service_uninstalled_before_install` — the startup entry is removed and the brain is stopped gracefully (2.5 s) | ade-update.jsonl |
| 03:15:45.557 | `quit_and_install` — ADE's last act, then it quits | ade-update.jsonl |
| 03:17:28.347 | last file written under `Programs\ADE` | filesystem |
| 03:18:56.648 | brain-service supervisor starts (pid 43076), brain pid 23892 | ps1.log |
| 03:18:57.745 | that brain is listening | output.log |
| 03:19:54.447 | **1.2.91 `desktop.main_started`** (pid 26600, `isPackaged: true`) | desktop-main.jsonl |
| 03:20:02.210 | a **second** supervisor starts (pid 67164), brain pid 44636 | ps1.log |
| 03:20:04.457 | `restart_not_needed` — "Background service is running 1.2.91." | ade-update.jsonl |

Three phases, and none of them is the download:

| phase | span | what is in it |
|---|---|---|
| NSIS extraction | 03:15:46 → 03:17:28, **~102 s** | installer start, the wait-for-ADE-to-close loop, unpacking ~300 MB |
| installer step 1 | 03:17:28 → 03:18:56, **~88 s** | `windows-install-setup.ps1`: PowerShell 5.1 cold start, three CLI launches, `brain start` |
| step 2 + app launch | 03:18:57 → 03:19:54, **~57 s** | `windows-firewall-rules.ps1`, then the installer's finish page waiting for a click |

`quit_and_install` → new version running, across every install this PC has
recorded:

| date | version | gap |
|---|---|---|
| 2026-09-30 | 1.2.83 | 223.6 s |
| 2026-10-05 | 1.2.90 | 353.1 s |
| 2026-10-06 | 1.2.91 | 249.4 s |

## Why ADE never relaunched

Not a race and not a timeout — there was no code path that could do it.

ADE's NSIS target is `oneClick: false` (`apps/desktop/package.json`), so the
build is the *assisted* installer. app-builder-lib's `installSection.nsh` starts
the app from exactly one place in that mode:

```nsis
!else  # assisted
  ${if} ${isForceRun}
  ${andIf} ${Silent}
    !insertmacro doStartApp
  ${endIf}
!endif
```

Both halves are required. ADE called `updater.quitAndInstall(false, true)`:

- `isForceRunAfter: true` was never the missing piece. `BaseUpdater.quitAndInstall`
  only forwards it when `isSilent` is true and substitutes
  `autoRunAppAfterInstall` otherwise — which defaults to `true`, so `--force-run`
  reached the installer either way.
- `isSilent: false` meant no `/S`, so `${Silent}` was false, so `doStartApp`
  never ran.

The fallback route does not exist either: `runAfterFinish: false` makes
app-builder-lib define `HIDE_RUN_AFTER_FINISH`, which compiles out both the
`StartApp` function and `MUI_FINISHPAGE_RUN`. (`doStartApp` itself is safe — the
`StartApp` it inserts is an unconditional macro in `common.nsh`, not that
function.)

**Fixed** by passing `isSilent: true`. That also deletes the third phase above:
a silent installer shows no pages, so nothing waits for a click.

One hazard this introduces, recorded because it is the thing to watch: NSIS's
`_CHECK_APP_RUNNING` ends in `MessageBox MB_RETRYCANCEL ... /SD IDCANCEL`, so if
`ADE.exe` is *still* running after two kill attempts, a silent install answers
Cancel and aborts instead of asking. In practice the loop should exit on its
first pass, because `prepareAutoUpdateInstall` stops the supervisor and then the
brain gracefully before handing off (measured at 2.5 s), and ADE's existing
abort/park path already handles an installer that ran and changed nothing.

## Ruled out, with measurements

- **Defender's first-touch scan of the 213 MB `ADE.exe`.** A freshly written copy
  launched in 0.36 s, with later launches at 0.03-0.15 s. There is no Defender
  exclusion for the install directory and real-time protection is on, so this was
  the leading suspect; it is not the cost. (Caveat: the copy came from an
  already-scanned source, so a payload freshly extracted from a downloaded
  installer could still differ.)
- **The installer's wait-for-ADE-to-close loop.** ADE stops the supervisor and
  the brain in `prepareAutoUpdateInstall` before quitting, which the log times at
  2.5 s, so the loop should find nothing. Seconds, not minutes.
- **The download.** `update_downloaded` lands 6-17 s after the preflight, hours
  before any install.

## Still open

- **The ~88 s of installer step 1 is not attributed.** `brain start` on Windows
  registers a scheduled task, starts it, waits up to 15 s for it to report
  `Running`, then unregisters — so a bounded 15 s plus three CLI launches plus
  PowerShell 5.1 cold start should be ~20-30 s, not 88. The rest is unexplained.
- **Why the extraction phase takes ~102 s** for ~300 MB.
- **The installer starts a brain the app immediately replaces.** Step 1 brought
  one up at 03:18:56 and the app had displaced it with a second supervisor by
  03:20:02. On an update that work looks redundant: the app re-registers the
  startup entry and runs its own brain (`transaction_completed` records the
  startup entry installed). NSIS knows `${isUpdated}`, so the install could skip
  starting the brain and only register it. **Not changed**, for two reasons: it
  trades robustness for tens of seconds, and it was only safe to consider once
  the relaunch above was fixed — before that, skipping the brain start could
  leave a user with no brain and no app.

## Making the next update attribute itself

The installer was the one part of an update that left no account of itself:
electron-builder sets `ShowInstDetails nevershow`, NSIS writes no log, and the
desktop app is not running, so the only way to time the phases above was file
mtimes after the fact.

`windows-install-setup.ps1` now appends one line per step to
`~/.ade/runtime/install-steps.log`:

```
2026-10-06T05:44:19.890Z install-setup service_status_read 0.15s ok
2026-10-06T05:44:19.939Z install-setup path_shim_install 0.04s ok
2026-10-06T05:44:21.100Z install-setup brain_start 18.30s ok
```

Best-effort and never fatal: a step that cannot write its timing still did its
work. With these, plus `quit_and_install` and `desktop.main_started`, the next
real update resolves step 1 exactly and leaves only extraction in the remainder.
`windows-firewall-rules.ps1` is deliberately not instrumented — it has several
`exit` paths and is usually a no-op at medium integrity — so its time still falls
in that remainder.
