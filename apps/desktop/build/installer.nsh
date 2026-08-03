!macro customInit
  Var /GLOBAL adeHadPreviousInstall
  StrCpy $adeHadPreviousInstall "0"
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R9 != ""
    StrCpy $adeHadPreviousInstall "1"
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Configuring the ADE terminal command and per-user brain startup..."
  StrCpy $2 "stable"
  ${If} "${PRODUCT_NAME}" == "ADE Alpha"
    StrCpy $2 "alpha"
  ${ElseIf} "${PRODUCT_NAME}" == "ADE Beta"
    StrCpy $2 "beta"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-install-setup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "ADE could not configure its terminal command or background startup.$\r$\n$\r$\n$1"
    ${If} $adeHadPreviousInstall != "1"
      DetailPrint "Rolling back the incomplete ADE product installation..."
      ExecWait '"$INSTDIR\${UNINSTALL_FILENAME}" /currentuser /S' $3
      ${If} $3 != 0
        DetailPrint "Incomplete product rollback exited with code $3."
      ${EndIf}
    ${EndIf}
    Abort
  ${EndIf}

  ; Pre-authorize the LAN sync listener so first run does not raise the Windows
  ; Firewall prompt. Windows only accepts firewall rules from an elevated
  ; process and this installer is per-user (perMachine/allowElevation are both
  ; false), so the script usually reports that it skipped the change instead of
  ; making one. Never fatal: a missing firewall rule costs one Windows prompt,
  ; it does not break the install.
  DetailPrint "Pre-authorizing ADE local network sync in Windows Firewall..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-firewall-rules.ps1" -Action install -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "ADE could not pre-authorize local network sync. Windows will ask once when you first use sync on this network."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing the ADE background service and terminal command..."
  StrCpy $2 "stable"
  ${If} "${PRODUCT_NAME}" == "ADE Alpha"
    StrCpy $2 "alpha"
  ${ElseIf} "${PRODUCT_NAME}" == "ADE Beta"
    StrCpy $2 "beta"
  ${EndIf}

  ; Take the inbound allowance back out before the product goes away, so an
  ; uninstall never leaves a rule pointing at a deleted executable. Same
  ; elevation caveat as install, and same non-fatal handling.
  DetailPrint "Removing the ADE local network sync firewall rules..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-firewall-rules.ps1" -Action uninstall -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  Pop $1
  DetailPrint "$1"

  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-uninstall-cleanup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "ADE could not remove its background service or terminal command. Close ADE and try uninstalling again.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend
