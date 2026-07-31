!macro customUnInstall
  DetailPrint "Removing the ADE background service and terminal command..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ade-cli\windows-uninstall-cleanup.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "ADE could not remove its background service or terminal command. Close ADE and try uninstalling again.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend
