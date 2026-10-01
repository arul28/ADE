// Top-level windows, processes, app launch, and input for one session.
//
// Everything here acts on the desktop of the session this process runs in:
// the private child session in Mode A, the user's console session in Mode B.

#pragma once

#include "common.h"

#include <map>
#include <set>
#include <string>
#include <vector>

namespace ade {

struct WinInfo {
  HWND hwnd = nullptr;
  DWORD pid = 0;          // the app's process (the real one behind a UWP frame)
  std::wstring title;
  std::wstring exePath;
  std::wstring appName;   // file description, else the exe name
  std::wstring exeName;   // lower-case, e.g. notepad.exe; the "bundle id"
  RECT frame = {};
  bool minimized = false;
};

// App windows of this session's desktop, top of the z-order first. Shell
// windows (taskbar, desktop, Start) are left out.
std::vector<WinInfo> listAppWindows();
bool describeWindow(HWND hwnd, WinInfo& out);
bool isAppWindow(HWND hwnd);

std::wstring processImagePath(DWORD pid);
std::wstring appNameForExe(const std::wstring& exePath);
DWORD parentProcessId(DWORD pid);
// The pid and every descendant alive now.
std::set<DWORD> processTree(DWORD root);
std::map<DWORD, FILETIME> processTreeIdentities(DWORD root, const FILETIME& expectedRoot);
FILETIME processCreationTime(DWORD pid);

struct LaunchResult {
  DWORD pid = 0;  // 0 when Windows activated the app without a process handle
  std::wstring resolved;
};
// Opens an app name, an exe path, a file, a URL, or `shell:AppsFolder\<AUMID>`.
LaunchResult launchTarget(const std::wstring& target, const std::vector<std::wstring>& args);

// Asks a window to close; returns false when it did not go within the wait.
bool closeWindowGracefully(HWND hwnd, DWORD waitMs);
bool terminatePid(DWORD pid, const FILETIME& expectedCreation);

// ---- Input ---------------------------------------------------------------

// Key names use the macOS driver's vocabulary (`return`, `escape`, `tab`,
// `left`, `f5`, a single character). Modifiers: `cmd`/`command` and
// `ctrl`/`control` both mean Ctrl, `alt`/`option` Alt, `shift`, `win`.
WORD virtualKeyForName(const std::string& name, bool* needsShift);

// Real input through SendInput. Coordinates are virtual-screen pixels.
bool sendMove(int x, int y);
bool sendClick(int x, int y, const std::string& button, int count);
bool sendDrag(int fromX, int fromY, int toX, int toY, int durationMs);
bool sendScroll(int x, int y, const std::string& direction, int amount);
bool sendKeys(const std::string& key, const std::vector<std::string>& modifiers);
bool sendText(const std::wstring& text);
void releaseAllButtons();

// Quiet input for the shared desktop: posted to one window, no pointer.
bool postClick(HWND hwnd, int screenX, int screenY, const std::string& button, int count);
bool postScroll(HWND hwnd, int screenX, int screenY, const std::string& direction, int amount);
bool postText(HWND hwnd, const std::wstring& text);

// The foreground dance for the shared desktop: bring a lane window forward
// for real keys, then hand the user's window back.
HWND currentForeground();
bool forceForeground(HWND hwnd);

}  // namespace ade
