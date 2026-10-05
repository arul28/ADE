#include "hostwindow.h"

namespace ade {

void bringToFront(HWND window, bool keepTopmost) {
  if (!window || !IsWindow(window)) return;
  if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
  SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  const HWND foreground = GetForegroundWindow();
  const DWORD foregroundThread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
  const DWORD ownThread = GetWindowThreadProcessId(window, nullptr);
  const DWORD self = GetCurrentThreadId();
  const bool attachedSelf = foregroundThread && foregroundThread != self && AttachThreadInput(self, foregroundThread, TRUE);
  const bool attachedOwner = foregroundThread && ownThread && ownThread != self && ownThread != foregroundThread &&
      AttachThreadInput(ownThread, foregroundThread, TRUE);
  BringWindowToTop(window);
  const bool activated = SetForegroundWindow(window) != FALSE;
  SetActiveWindow(window);
  if (attachedOwner) AttachThreadInput(ownThread, foregroundThread, FALSE);
  if (attachedSelf) AttachThreadInput(self, foregroundThread, FALSE);
  if (!keepTopmost) SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  if (!activated) {
    FLASHWINFO flash{sizeof(flash), window, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&flash);
  }
  logLine(std::string("ui: brought window to front activated=") + (activated ? "1" : "0") + " topmost=" + (keepTopmost ? "1" : "0"));
}

void parkHostWindow(HWND window, int width, int height) {
  const LONG_PTR ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
  SetWindowLongPtrW(window, GWL_EXSTYLE, (ex & ~static_cast<LONG_PTR>(WS_EX_APPWINDOW)) | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
  const int x = GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN) + 64;
  const int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
  SetWindowPos(window, HWND_BOTTOM, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
  logLine("start: host window parked outside the monitors");
}

void unparkHostWindow(HWND window, int width, int height) {
  const LONG_PTR ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
  SetWindowLongPtrW(window, GWL_EXSTYLE, (ex | WS_EX_APPWINDOW) & ~static_cast<LONG_PTR>(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE));
  RECT work{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  SetWindowPos(window, nullptr, work.left, work.top, width, height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

}  // namespace ade
