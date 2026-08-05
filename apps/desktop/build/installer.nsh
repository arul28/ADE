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

  DetailPrint "Step 1 of 2: configuring the ADE terminal command and starting the background service..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-install-setup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Step 1 of 2 failed with exit code $0."
    MessageBox MB_ICONSTOP|MB_OK "ADE could not configure its terminal command or background startup.$\r$\n$\r$\nThe setup step exited with code $0. Run the installer again. If it fails the same way, install from PowerShell with:$\r$\n$\r$\nirm https://ade-app.dev/install.ps1 | iex$\r$\n$\r$\nThat path prints the full error."
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
!macroend
