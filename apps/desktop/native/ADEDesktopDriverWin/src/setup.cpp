#include "modes.h"
#include "common.h"
#include <wtsapi32.h>
#include <shellapi.h>

namespace ade {

// Isolate ShellExecuteEx: Windows may wait inside it for UAC consent. The
// host owns this helper process and can bound/cancel that wait without blocking
// its STA pump or killing any process found through a name search.
int runSetupPrompt() {
  SHELLEXECUTEINFOW execute = {sizeof(execute)};
  auto binary = exePath();
  execute.fMask = SEE_MASK_NOCLOSEPROCESS;
  execute.lpVerb = L"runas";
  execute.lpFile = binary.c_str();
  execute.lpParameters = L"setup-elevated";
  execute.nShow = SW_HIDE;
  if (!ShellExecuteExW(&execute)) return GetLastError() == ERROR_CANCELLED ? 2 : 1;
  DWORD wait = WaitForSingleObject(execute.hProcess, 120'000), exit = 1;
  if (wait == WAIT_OBJECT_0) GetExitCodeProcess(execute.hProcess, &exit);
  CloseHandle(execute.hProcess);
  return wait == WAIT_OBJECT_0 ? static_cast<int>(exit) : 1;
}

int runSetupElevated() {
  // Explicitly invoked by the local setup dialog after the UAC prompt.
  // This enables Remote Desktop; it does not change the firewall rules.
  if (!WTSEnableChildSessions(TRUE)) {
    logLine("setup: Windows refused to enable child sessions");
    return 1;
  }
  const DWORD allow = 0;
  LSTATUS result = RegSetKeyValueW(HKEY_LOCAL_MACHINE,
      L"SYSTEM\\CurrentControlSet\\Control\\Terminal Server",
      L"fDenyTSConnections", REG_DWORD, &allow, sizeof(allow));
  if (result != ERROR_SUCCESS) {
    logLine("setup: Windows refused to allow local Remote Desktop");
    return 1;
  }
  return 0;
}

}  // namespace ade
