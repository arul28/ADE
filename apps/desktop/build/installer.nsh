; nsExec::ExecToLog, not ExecToStack, on every PowerShell step below.
;
; ExecToStack buffers the child's entire output and hands it back only after the
; child exits, so for the whole of a step -- and step 1 registers and starts the
; per-user brain, which is not instant -- the page shows one stale status line
; and looks hung. ExecToLog DetailPrints each line as it arrives, and the
; InstFiles page mirrors the newest detail line into the status text above the
; progress bar, so the step visibly talks the whole time it runs. That status
; text is the surface that matters here: electron-builder's common.nsh sets
; `ShowInstDetails nevershow`, so the detail listbox itself is never on screen.
;
; The trade: ExecToLog pushes only the exit code, so a failing step no longer
; hands its message back for the MessageBox. Rather than point at a log the user
; cannot open, each failure modal reports the exit code and names the PowerShell
; install path, which runs the same work in a console where the error is visible.

; Replaces electron-builder's _CHECK_APP_RUNNING, which runs in the installer and
; again in the old uninstaller. Its chain starts powershell.exe three or four
; times per pass (Get-Command Get-CimInstance, Get-ExecutionPolicy, then a
; Get-CimInstance probe per retry), 1.5-2.5s each: about 15s of every update,
; measured in Windows Sandbox, before a single file was copied. This does the
; same job, stop every process whose image lives under $INSTDIR and wait until
; they are gone, in one PowerShell run per pass, with the same dialogs and the
; same silent-mode answers. The install folder and this process's own id ride in
; the environment, so a path holding a quote stays data and an uninstaller
; running in place never stops itself. If PowerShell cannot start at all, the
; check steps aside the way the default does without PowerShell.
; ADE_CHECK_MODE picks the pass: "probe" only reports (exit 1 = running),
; "stop" stops them (exit 0 = gone, 2 = still running 10s after forcing began).
; A process query that fails is retried, never read as "nothing running"; one
; that keeps failing past the deadline answers 2. The command is compact on
; purpose: the expanded line has to stay under NSIS's 1024-character limit.
; ADE_CHECK_GRACE_SECONDS is how long "stop" only waits before it forces. An
; update gets 4s: electron-updater starts the installer and then quits ADE, and
; ADE's quit is what ends its agent and terminal children (they live outside
; $INSTDIR, so nothing here would). The default check waited about as long.
!define ADE_CHECK_APP_RUNNING_COMMAND `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=($$env:ADE_CHECK_INSTDIR.TrimEnd([char]92)+[char]92).ToLowerInvariant();$$s=[int]$$env:ADE_CHECK_SELF_PID;$$g=(Get-Date).AddSeconds([int]$$env:ADE_CHECK_GRACE_SECONDS);$$e=$$g.AddSeconds(10);while(1){try{$$p=@(Get-CimInstance Win32_Process -Filter 'ExecutablePath IS NOT NULL' -ErrorAction Stop|?{$$_.ProcessId -ne $$s -and $$_.ExecutablePath.ToLowerInvariant().StartsWith($$d)})}catch{if((Get-Date) -gt $$e){exit 2};sleep -m 200;continue};if(!$$p.Count){exit 0};if($$env:ADE_CHECK_MODE -eq 'probe'){exit 1};if((Get-Date) -lt $$g){sleep -m 200;continue};$$p|%{Stop-Process -Id $$_.ProcessId -Force -EA 0};if((Get-Date) -gt $$e){exit 2};sleep -m 200}"`
!macro customCheckAppRunning
  System::Call 'kernel32::GetCurrentProcessId()i.r9'
  System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_INSTDIR", t "$INSTDIR")i'
  System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_SELF_PID", t "$9")i'
  ${If} ${isUpdated}
    System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_GRACE_SECONDS", t "4")i'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_GRACE_SECONDS", t "0")i'
  ${EndIf}
  ${IfNot} ${isUpdated}
    System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_MODE", t "probe")i'
    nsExec::Exec `${ADE_CHECK_APP_RUNNING_COMMAND}`
    Pop $R0
    ${If} $R0 == 1
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariable(t "ADE_CHECK_MODE", t "stop")i'
  DetailPrint "$(appClosing)"
  ${Do}
    nsExec::Exec `${ADE_CHECK_APP_RUNNING_COMMAND}`
    Pop $R0
    ${If} $R0 == 0
    ${OrIf} $R0 == "error"
      ${Break}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
    Quit
  ${Loop}
!macroend

!macro customInit
  Var /GLOBAL adeHadPreviousInstall
  StrCpy $adeHadPreviousInstall "0"
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R9 != ""
    StrCpy $adeHadPreviousInstall "1"
  ${EndIf}
!macroend

!macro customInstall
  StrCpy $2 "stable"
  ${If} "${PRODUCT_NAME}" == "ADE Alpha"
    StrCpy $2 "alpha"
  ${ElseIf} "${PRODUCT_NAME}" == "ADE Beta"
    StrCpy $2 "beta"
  ${EndIf}

  ; An update refreshes only the terminal shim here: the relaunched app
  ; reinstalls, restarts and verifies the background service itself, so doing
  ; it here too only kept ADE closed longer (see windows-install-setup.ps1).
  StrCpy $3 ""
  ${If} ${isUpdated}
    StrCpy $3 "-Updating"
  ${EndIf}

  DetailPrint "Step 1 of 2: configuring the ADE terminal command and starting the background service..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-install-setup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2" $3'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Step 1 of 2 failed with exit code $0."
    MessageBox MB_ICONSTOP|MB_OK "ADE could not configure its terminal command or background startup.$\r$\n$\r$\nThe setup step exited with code $0. Run the installer again. If it fails the same way, install from PowerShell with:$\r$\n$\r$\nirm https://ade-app.dev/install.ps1 | iex$\r$\n$\r$\nThat path prints the full error." /SD IDOK
    ${If} $adeHadPreviousInstall != "1"
      DetailPrint "Rolling back the incomplete ADE product installation..."
      ExecWait '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser /S' $3
      ${If} $3 != 0
        DetailPrint "Incomplete product rollback exited with code $3."
      ${EndIf}
    ${EndIf}
    Abort
  ${EndIf}
  DetailPrint "Step 1 of 2 done."

  ; This runs on updates too. An uninstaller older than the -Updating branch
  ; below removes the rule on every update, and the script is idempotent and
  ; about a second, so putting the rule back costs less than losing it.
  ;
  ; Pre-authorize the LAN sync listener so first run does not raise the Windows
  ; Firewall prompt. Windows only accepts firewall rules from an elevated
  ; process and this installer is per-user (perMachine/allowElevation are both
  ; false), so the script usually reports that it skipped the change instead of
  ; making one. Never fatal: a missing firewall rule costs one Windows prompt,
  ; it does not break the install.
  DetailPrint "Step 2 of 2: pre-authorizing ADE local network sync in Windows Firewall..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-firewall-rules.ps1" -Action install -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ADE could not pre-authorize local network sync. Windows will ask once when you first use sync on this network."
  ${EndIf}
  DetailPrint "Step 2 of 2 done."
!macroend

!macro customUnInstall
  StrCpy $2 "stable"
  ${If} "${PRODUCT_NAME}" == "ADE Alpha"
    StrCpy $2 "alpha"
  ${ElseIf} "${PRODUCT_NAME}" == "ADE Beta"
    StrCpy $2 "beta"
  ${EndIf}

  ; electron-builder runs the OLD uninstaller with --updated whenever a new
  ; installer replaces this install, so ${isUpdated} here means "the product is
  ; not going away". Then only the background service stops (nothing may
  ; respawn a brain from the folder being replaced); the firewall rule, the
  ; terminal command, PATH, ade:// and file associations stay for the new
  ; version, which would put each one straight back.
  ${If} ${isUpdated}
    DetailPrint "Stopping the ADE background service for the update..."
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-uninstall-cleanup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2" -Updating'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Stopping the background service exited with code $0."
      MessageBox MB_ICONSTOP|MB_OK "ADE could not stop its background service for the update. Close ADE and try again.$\r$\n$\r$\nThe cleanup step exited with code $0." /SD IDOK
      Abort
    ${EndIf}
    Goto adeUninstallCleanupDone
  ${EndIf}

  ; Take the inbound allowance back out before the product goes away, so an
  ; uninstall never leaves a rule pointing at a deleted executable. Same
  ; elevation caveat as install, and same non-fatal handling.
  DetailPrint "Step 1 of 2: removing the ADE local network sync firewall rules..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-firewall-rules.ps1" -Action uninstall -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Firewall rule removal exited with code $0. Continuing the uninstall."
  ${EndIf}
  DetailPrint "Step 1 of 2 done."

  DetailPrint "Step 2 of 2: removing the ADE background service and terminal command..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-uninstall-cleanup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Step 2 of 2 failed with exit code $0."
    MessageBox MB_ICONSTOP|MB_OK "ADE could not remove its background service or terminal command. Close ADE and try uninstalling again.$\r$\n$\r$\nThe cleanup step exited with code $0."
    Abort
  ${EndIf}
  DetailPrint "Step 2 of 2 done."
  adeUninstallCleanupDone:
!macroend
