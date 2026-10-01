#include "modes.h"
#include "common.h"

#include <shellapi.h>

int wmain(int argc, wchar_t** argv) {
  using namespace ade;
  std::wstring mode = argc > 1 ? argv[1] : L"host";
  std::wstring home = adeHomeDir();
  std::wstring pipe;
  for (int i = 2; i < argc; ++i) {
    std::wstring arg = argv[i];
    if ((arg == L"--ade-home" || arg == L"--pipe") && i + 1 < argc) {
      if (arg == L"--ade-home") home = argv[++i];
      else pipe = argv[++i];
    } else {
      logLine("unknown or incomplete argument");
      return 2;
    }
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (mode == L"host" && !home.empty()) return runHost(home);
  if (mode == L"child" && pipe.rfind(L"\\\\.\\pipe\\ade-screen-", 0) == 0) return runChild(pipe);
  if (mode == L"setup-prompt") return runSetupPrompt();
  if (mode == L"setup-elevated") return runSetupElevated();
  logLine("usage: ade-desktop-driver.exe host [--ade-home <dir>] | child --pipe <name> | setup-elevated");
  return 2;
}
