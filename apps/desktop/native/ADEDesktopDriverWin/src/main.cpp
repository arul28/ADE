#include "modes.h"
#include "common.h"
#include "rdp.h"

#include <shellapi.h>

int wmain(int argc, wchar_t** argv) {
  using namespace ade;
  std::wstring mode = argc > 1 ? argv[1] : L"host";
  std::wstring home = adeHomeDir();
  std::wstring pipe;
  DWORD session = 0;
  for (int i = 2; i < argc; ++i) {
    std::wstring arg = argv[i];
    if ((arg == L"--ade-home" || arg == L"--pipe") && i + 1 < argc) {
      if (arg == L"--ade-home") home = argv[++i];
      else pipe = argv[++i];
    } else if (arg == L"--session" && mode == L"cleanup-child" && i + 1 < argc) {
      wchar_t* end = nullptr;
      auto value = wcstoul(argv[++i], &end, 10);
      if (!value || !end || *end) return 2;
      session = value;
    } else {
      logLine("unknown or incomplete argument");
      return 2;
    }
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (mode == L"host" && !home.empty()) return runHost(home);
  if (mode == L"child" && pipe.rfind(L"\\\\.\\pipe\\ade-screen-", 0) == 0) return runChild(pipe);
  if (mode == L"cleanup-child") {
    // Recovery is limited to the exact captured child of this console session.
    // Never sign out the console or select an arbitrary session by number.
    // Even recovery must not leave a helper stuck inside a Windows RPC call.
    HANDLE timer = nullptr;
    if (!CreateTimerQueueTimer(&timer, nullptr, [](PVOID, BOOLEAN) { TerminateProcess(GetCurrentProcess(), 1); },
        nullptr, 15'000, 0, WT_EXECUTEONLYONCE)) return 1;
    struct Deadline { HANDLE timer; ~Deadline() { DeleteTimerQueueTimer(nullptr, timer, INVALID_HANDLE_VALUE); } } deadline{timer};
    if (!session || childSessionId() != session || session == consoleSessionId()) return 2;
    return signOutSession(session, nowMs() + 10'000) ? 0 : 1;
  }
  if (mode == L"setup-prompt") return runSetupPrompt();
  if (mode == L"setup-elevated") return runSetupElevated();
  logLine("usage: ade-desktop-driver.exe host [--ade-home <dir>] | child --pipe <name> | setup-elevated");
  return 2;
}
