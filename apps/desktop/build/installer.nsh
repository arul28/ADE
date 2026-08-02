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
!macroend

!macro customUnInstall
  DetailPrint "Removing the ADE background service and terminal command..."
  StrCpy $2 "stable"
  ${If} "${PRODUCT_NAME}" == "ADE Alpha"
    StrCpy $2 "alpha"
  ${ElseIf} "${PRODUCT_NAME}" == "ADE Beta"
    StrCpy $2 "beta"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-uninstall-cleanup.ps1" -InstallDir "$INSTDIR" -AppExecutableName "${APP_EXECUTABLE_FILENAME}" -PackageChannel "$2"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "ADE could not remove its background service or terminal command. Close ADE and try uninstalling again.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend
