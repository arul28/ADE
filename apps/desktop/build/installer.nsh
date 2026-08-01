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
