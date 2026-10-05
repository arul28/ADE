#include "modes.h"
#include "common.h"
#include <wtsapi32.h>
#include <shellapi.h>

namespace ade {

// Isolate ShellExecuteEx: Windows may wait inside it for UAC consent. The
// host owns this helper process and can bound/cancel that wait without blocking
// its STA pump or killing any process found through a name search.
int runSetupPrompt() {
  // Windows shows the UAC consent for a background requester as a flashing
  // taskbar button the user has to find. A topmost owner window that tries to
  // take the foreground first lets consent open in front of ADE.
  WNDCLASSW wc = {};
  wc.lpfnWndProc = DefWindowProcW; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"ADEWindowsSetupPromptOwner";
  RegisterClassW(&wc);
  RECT work{}; SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  HWND owner = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, wc.lpszClassName, L"ADE Windows Desktop setup", WS_POPUP,
      (work.left + work.right) / 2, (work.top + work.bottom) / 2, 1, 1, nullptr, nullptr, wc.hInstance, nullptr);
  struct Owner { HWND value; ~Owner() { if (value) DestroyWindow(value); } } ownedOwner{owner};
  if (owner) {
    ShowWindow(owner, SW_SHOW);
    const HWND foreground = GetForegroundWindow();
    const DWORD foregroundThread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
    const DWORD self = GetCurrentThreadId();
    const bool attached = foregroundThread && foregroundThread != self && AttachThreadInput(self, foregroundThread, TRUE);
    BringWindowToTop(owner);
    const bool activated = SetForegroundWindow(owner) != FALSE;
    if (attached) AttachThreadInput(self, foregroundThread, FALSE);
    logLine(std::string("setup: prompt owner activated=") + (activated ? "1" : "0"));
  }
  SHELLEXECUTEINFOW execute = {sizeof(execute)};
  auto binary = exePath();
  execute.hwnd = owner;
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
