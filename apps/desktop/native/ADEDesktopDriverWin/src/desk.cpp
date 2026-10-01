#include "desk.h"

#include <dwmapi.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <map>

namespace ade {

namespace {

bool isCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0;
}

std::wstring className(HWND hwnd) {
  wchar_t buf[256];
  int n = GetClassNameW(hwnd, buf, 256);
  return std::wstring(buf, n > 0 ? n : 0);
}

bool isShellClass(const std::wstring& cls) {
  static const wchar_t* shell[] = {L"Progman", L"WorkerW", L"Shell_TrayWnd", L"Shell_SecondaryTrayWnd",
                                   L"Windows.UI.Core.CoreWindow", L"NotifyIconOverflowWindow",
                                   L"TopLevelWindowForOverflowXamlIsland", L"XamlExplorerHostIslandWindow"};
  for (auto s : shell) {
    if (cls == s) return true;
  }
  return false;
}

// A UWP app's top-level window belongs to ApplicationFrameHost; its content
// (and the pid that matters) is the child CoreWindow.
DWORD realPidForFrame(HWND hwnd, DWORD fallback) {
  if (className(hwnd) != L"ApplicationFrameWindow") return fallback;
  DWORD found = fallback;
  EnumChildWindows(
      hwnd,
      [](HWND child, LPARAM lp) -> BOOL {
        if (className(child) == L"Windows.UI.Core.CoreWindow") {
          DWORD pid = 0;
          GetWindowThreadProcessId(child, &pid);
          *reinterpret_cast<DWORD*>(lp) = pid;
          return FALSE;
        }
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&found));
  return found;
}

std::map<std::wstring, std::wstring>& appNameCache() {
  static std::map<std::wstring, std::wstring> cache;
  return cache;
}
std::mutex& appNameMutex() {
  static std::mutex m;
  return m;
}

}  // namespace

std::wstring processImagePath(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return L"";
  wchar_t buf[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(buf));
  std::wstring out;
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) out.assign(buf, size);
  CloseHandle(h);
  return out;
}

std::wstring appNameForExe(const std::wstring& exePath) {
  if (exePath.empty()) return L"";
  {
    std::lock_guard<std::mutex> lock(appNameMutex());
    auto it = appNameCache().find(exePath);
    if (it != appNameCache().end()) return it->second;
  }
  std::wstring name;
  DWORD handle = 0;
  DWORD size = GetFileVersionInfoSizeW(exePath.c_str(), &handle);
  if (size > 0) {
    std::vector<BYTE> data(size);
    if (GetFileVersionInfoW(exePath.c_str(), 0, size, data.data())) {
      struct Lang {
        WORD lang, codepage;
      }* langs = nullptr;
      UINT len = 0;
      if (VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&langs), &len) &&
          len >= sizeof(Lang)) {
        wchar_t key[64];
        swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", langs[0].lang, langs[0].codepage);
        wchar_t* value = nullptr;
        UINT vlen = 0;
        if (VerQueryValueW(data.data(), key, reinterpret_cast<void**>(&value), &vlen) && vlen > 1) {
          name.assign(value, vlen - 1);
        }
      }
    }
  }
  if (name.empty()) {
    size_t slash = exePath.find_last_of(L"\\/");
    name = exePath.substr(slash == std::wstring::npos ? 0 : slash + 1);
    size_t dot = name.find_last_of(L'.');
    if (dot != std::wstring::npos) name = name.substr(0, dot);
  }
  std::lock_guard<std::mutex> lock(appNameMutex());
  appNameCache()[exePath] = name;
  return name;
}

bool isAppWindow(HWND hwnd) {
  if (!IsWindowVisible(hwnd)) return false;
  if (isCloaked(hwnd)) return false;
  LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  HWND owner = GetWindow(hwnd, GW_OWNER);
  bool appWindow = (ex & WS_EX_APPWINDOW) != 0;
  if ((ex & WS_EX_TOOLWINDOW) && !appWindow) return false;
  if (owner && !appWindow) {
    // Owned dialogs (Save As, message boxes) are part of the app's work.
    LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if (!(style & WS_CAPTION)) return false;
  }
  if (isShellClass(className(hwnd))) return false;
  RECT r;
  if (!GetWindowRect(hwnd, &r) || r.right - r.left < 2 || r.bottom - r.top < 2) return false;
  return true;
}

bool describeWindow(HWND hwnd, WinInfo& out) {
  if (!IsWindow(hwnd)) return false;
  out.hwnd = hwnd;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  out.pid = realPidForFrame(hwnd, pid);
  wchar_t title[512];
  int n = GetWindowTextW(hwnd, title, 512);
  out.title.assign(title, n > 0 ? n : 0);
  out.exePath = processImagePath(out.pid);
  out.appName = appNameForExe(out.exePath);
  size_t slash = out.exePath.find_last_of(L"\\/");
  out.exeName = lower(out.exePath.substr(slash == std::wstring::npos ? 0 : slash + 1));
  RECT r;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) GetWindowRect(hwnd, &r);
  out.frame = r;
  out.minimized = IsIconic(hwnd) != FALSE;
  return true;
}

std::vector<WinInfo> listAppWindows() {
  std::vector<HWND> handles;
  EnumWindows(
      [](HWND hwnd, LPARAM lp) -> BOOL {
        reinterpret_cast<std::vector<HWND>*>(lp)->push_back(hwnd);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&handles));
  std::vector<WinInfo> out;
  DWORD self = GetCurrentProcessId();
  for (HWND h : handles) {
    if (!isAppWindow(h)) continue;
    WinInfo info;
    if (!describeWindow(h, info)) continue;
    if (info.pid == self) continue;
    out.push_back(std::move(info));
  }
  return out;
}

DWORD parentProcessId(DWORD pid) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W pe = {sizeof(pe)};
  DWORD parent = 0;
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    if (pe.th32ProcessID == pid) {
      parent = pe.th32ParentProcessID;
      break;
    }
  }
  CloseHandle(snap);
  return parent;
}

std::set<DWORD> processTree(DWORD root) {
  std::set<DWORD> tree;
  if (!root) return tree;
  tree.insert(root);
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return tree;
  std::vector<std::pair<DWORD, DWORD>> pairs;
  PROCESSENTRY32W pe = {sizeof(pe)};
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    pairs.emplace_back(pe.th32ProcessID, pe.th32ParentProcessID);
  }
  CloseHandle(snap);
  // Parent pids are reused on Windows; a child must also be younger than its
  // parent to count, or a recycled pid would adopt unrelated processes.
  bool grew = true;
  while (grew) {
    grew = false;
    for (auto& [pid, parent] : pairs) {
      if (tree.count(pid) || !tree.count(parent)) continue;
      FILETIME c = processCreationTime(pid);
      FILETIME p = processCreationTime(parent);
      if (CompareFileTime(&c, &p) < 0) continue;
      tree.insert(pid);
      grew = true;
    }
  }
  return tree;
}

FILETIME processCreationTime(DWORD pid) {
  FILETIME created = {}, exited, kernel, user;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (h) {
    GetProcessTimes(h, &created, &exited, &kernel, &user);
    CloseHandle(h);
  }
  return created;
}

LaunchResult launchTarget(const std::wstring& target, const std::vector<std::wstring>& args) {
  LaunchResult result;
  std::wstring params;
  for (const auto& a : args) {
    if (!params.empty()) params += L" ";
    bool quote = a.empty() || a.find_first_of(L" \t\"") != std::wstring::npos;
    if (quote) {
      params += L"\"";
      size_t slashes = 0;
      for (wchar_t c : a) {
        if (c == L'\\') { ++slashes; continue; }
        params.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        params += c;
        slashes = 0;
      }
      params.append(slashes * 2, L'\\');
      params += L"\"";
    } else {
      params += a;
    }
  }
  SHELLEXECUTEINFOW sei = {sizeof(sei)};
  sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
  sei.lpVerb = L"open";
  sei.lpFile = target.c_str();
  sei.lpParameters = params.empty() ? nullptr : params.c_str();
  sei.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&sei)) {
    DWORD err = GetLastError();
    fail(code::kInvalidArgument, "Windows could not open \"" + narrow(target) + "\" (error " + std::to_string(err) +
                                     "). Pass an app name such as notepad, a full path, or a URL.");
  }
  if (sei.hProcess) {
    result.pid = GetProcessId(sei.hProcess);
    CloseHandle(sei.hProcess);
  }
  result.resolved = target;
  return result;
}

bool closeWindowGracefully(HWND hwnd, DWORD waitMs) {
  PostMessageW(hwnd, WM_CLOSE, 0, 0);
  DWORD start = GetTickCount();
  while (GetTickCount() - start < waitMs) {
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return true;
    Sleep(50);
  }
  return !IsWindow(hwnd);
}

bool terminatePid(DWORD pid, const FILETIME& expectedCreation) {
  HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return false;
  FILETIME created, exited, kernel, user;
  DWORD session = 0;
  if (!GetProcessTimes(h, &created, &exited, &kernel, &user) ||
      CompareFileTime(&created, &expectedCreation) != 0 ||
      !ProcessIdToSessionId(pid, &session) || session != currentSessionId()) {
    CloseHandle(h); return false;
  }
  bool ok = TerminateProcess(h, 1) != FALSE;
  WaitForSingleObject(h, 2000);
  CloseHandle(h);
  return ok;
}

// ---- Input ----------------------------------------------------------------

WORD virtualKeyForName(const std::string& raw, bool* needsShift) {
  if (needsShift) *needsShift = false;
  std::string name = lowerA(raw);
  static const std::map<std::string, WORD> named = {
      {"return", VK_RETURN},  {"enter", VK_RETURN},     {"tab", VK_TAB},          {"escape", VK_ESCAPE},
      {"esc", VK_ESCAPE},     {"space", VK_SPACE},      {"backspace", VK_BACK},   {"delete", VK_BACK},
      {"forwarddelete", VK_DELETE}, {"del", VK_DELETE}, {"left", VK_LEFT},        {"right", VK_RIGHT},
      {"up", VK_UP},          {"down", VK_DOWN},        {"home", VK_HOME},        {"end", VK_END},
      {"pageup", VK_PRIOR},   {"pagedown", VK_NEXT},    {"insert", VK_INSERT},    {"menu", VK_APPS},
      {"printscreen", VK_SNAPSHOT}, {"capslock", VK_CAPITAL},
  };
  auto it = named.find(name);
  if (it != named.end()) return it->second;
  if (name.size() >= 2 && name[0] == 'f') {
    int n = atoi(name.c_str() + 1);
    if (n >= 1 && n <= 24) return static_cast<WORD>(VK_F1 + n - 1);
  }
  if (raw.size() == 1) {
    SHORT vk = VkKeyScanW(static_cast<wchar_t>(static_cast<unsigned char>(raw[0])));
    if (vk != -1) {
      if (needsShift) *needsShift = (HIBYTE(vk) & 1) != 0;
      return LOBYTE(vk);
    }
  }
  return 0;
}

namespace {

INPUT keyInput(WORD vk, bool up) {
  INPUT in = {};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = vk;
  in.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
  switch (vk) {
    case VK_LEFT: case VK_RIGHT: case VK_UP: case VK_DOWN: case VK_HOME: case VK_END:
    case VK_PRIOR: case VK_NEXT: case VK_INSERT: case VK_DELETE:
      in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
      break;
    default:
      break;
  }
  return in;
}

INPUT mouseInput(int x, int y, DWORD flags, DWORD data = 0) {
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  int vw = std::max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
  int vh = std::max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dx = static_cast<LONG>((static_cast<int64_t>(x - vx) * 65535) / vw);
  in.mi.dy = static_cast<LONG>((static_cast<int64_t>(y - vy) * 65535) / vh);
  in.mi.mouseData = data;
  in.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return in;
}

bool sendAll(std::vector<INPUT>& inputs) {
  if (inputs.empty()) return true;
  UINT sent = SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
  // A locked console makes SendInput accept 0 events: report it rather than
  // claiming the click happened.
  return sent == inputs.size();
}

std::vector<WORD> modifierKeys(const std::vector<std::string>& modifiers) {
  std::vector<WORD> keys;
  for (const auto& m : modifiers) {
    std::string n = lowerA(m);
    if (n == "cmd" || n == "command" || n == "ctrl" || n == "control") keys.push_back(VK_CONTROL);
    else if (n == "alt" || n == "option" || n == "opt") keys.push_back(VK_MENU);
    else if (n == "shift") keys.push_back(VK_SHIFT);
    else if (n == "win" || n == "meta" || n == "super") keys.push_back(VK_LWIN);
  }
  std::sort(keys.begin(), keys.end());
  keys.erase(std::unique(keys.begin(), keys.end()), keys.end());
  return keys;
}

void buttonFlags(const std::string& button, DWORD& down, DWORD& up) {
  if (button == "right") {
    down = MOUSEEVENTF_RIGHTDOWN;
    up = MOUSEEVENTF_RIGHTUP;
  } else if (button == "middle") {
    down = MOUSEEVENTF_MIDDLEDOWN;
    up = MOUSEEVENTF_MIDDLEUP;
  } else {
    down = MOUSEEVENTF_LEFTDOWN;
    up = MOUSEEVENTF_LEFTUP;
  }
}

}  // namespace

bool sendMove(int x, int y) {
  std::vector<INPUT> in = {mouseInput(x, y, MOUSEEVENTF_MOVE)};
  return sendAll(in);
}

bool sendClick(int x, int y, const std::string& button, int count) {
  DWORD down, up;
  buttonFlags(button, down, up);
  std::vector<INPUT> in = {mouseInput(x, y, MOUSEEVENTF_MOVE)};
  for (int i = 0; i < std::max(1, std::min(count, 3)); ++i) {
    in.push_back(mouseInput(x, y, down));
    in.push_back(mouseInput(x, y, up));
  }
  return sendAll(in);
}

bool sendDrag(int fromX, int fromY, int toX, int toY, int durationMs) {
  std::vector<INPUT> start = {mouseInput(fromX, fromY, MOUSEEVENTF_MOVE), mouseInput(fromX, fromY, MOUSEEVENTF_LEFTDOWN)};
  if (!sendAll(start)) return false;
  int steps = std::max(4, std::min(60, durationMs / 16));
  for (int i = 1; i <= steps; ++i) {
    int x = fromX + (toX - fromX) * i / steps;
    int y = fromY + (toY - fromY) * i / steps;
    std::vector<INPUT> move = {mouseInput(x, y, MOUSEEVENTF_MOVE)};
    sendAll(move);
    Sleep(std::max(1, durationMs / steps));
  }
  std::vector<INPUT> end = {mouseInput(toX, toY, MOUSEEVENTF_LEFTUP)};
  return sendAll(end);
}

bool sendScroll(int x, int y, const std::string& direction, int amount) {
  int clicks = std::max(1, std::min(amount, 50));
  DWORD flag = (direction == "left" || direction == "right") ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
  int sign = (direction == "down" || direction == "left") ? -1 : 1;
  std::vector<INPUT> in = {mouseInput(x, y, MOUSEEVENTF_MOVE)};
  for (int i = 0; i < clicks; ++i) in.push_back(mouseInput(x, y, flag, static_cast<DWORD>(sign * WHEEL_DELTA)));
  return sendAll(in);
}

bool sendKeys(const std::string& key, const std::vector<std::string>& modifiers) {
  bool needsShift = false;
  WORD vk = virtualKeyForName(key, &needsShift);
  if (!vk) fail(code::kInvalidArgument, "\"" + key + "\" is not a key this driver knows.");
  std::vector<WORD> mods = modifierKeys(modifiers);
  if (needsShift && std::find(mods.begin(), mods.end(), static_cast<WORD>(VK_SHIFT)) == mods.end()) mods.push_back(VK_SHIFT);
  std::vector<INPUT> in;
  for (WORD m : mods) in.push_back(keyInput(m, false));
  in.push_back(keyInput(vk, false));
  in.push_back(keyInput(vk, true));
  for (auto it = mods.rbegin(); it != mods.rend(); ++it) in.push_back(keyInput(*it, true));
  return sendAll(in);
}

bool sendText(const std::wstring& text) {
  // Deliver each logical line before Enter. WinUI editors can rebuild their
  // text control on Enter; one giant mixed VK_PACKET/Enter batch races that.
  std::vector<INPUT> in;
  auto flush = [&] { bool ok = sendAll(in); in.clear(); return ok; };
  for (size_t i = 0; i < text.size(); ++i) {
    wchar_t c = text[i];
    if (c == L'\r' || c == L'\n' || c == L'\t') {
      if (!flush()) return false;
      if (c == L'\r' && i + 1 < text.size() && text[i + 1] == L'\n') ++i;
      if (!sendKeys(c == L'\t' ? "tab" : "enter", {})) return false;
      // Let the receiving editor process the control key before its next line.
      Sleep(20);
      continue;
    }
    INPUT down = {};
    down.type = INPUT_KEYBOARD;
    down.ki.wScan = c;
    down.ki.dwFlags = KEYEVENTF_UNICODE;
    INPUT up = down;
    up.ki.dwFlags |= KEYEVENTF_KEYUP;
    in.push_back(down);
    in.push_back(up);
    if (in.size() >= 256 && !flush()) return false;
  }
  return flush();
}

void releaseAllButtons() {
  POINT p;
  GetCursorPos(&p);
  std::vector<INPUT> in;
  if (GetAsyncKeyState(VK_LBUTTON) & 0x8000) in.push_back(mouseInput(p.x, p.y, MOUSEEVENTF_LEFTUP));
  if (GetAsyncKeyState(VK_RBUTTON) & 0x8000) in.push_back(mouseInput(p.x, p.y, MOUSEEVENTF_RIGHTUP));
  if (GetAsyncKeyState(VK_MBUTTON) & 0x8000) in.push_back(mouseInput(p.x, p.y, MOUSEEVENTF_MIDDLEUP));
  for (WORD m : {static_cast<WORD>(VK_CONTROL), static_cast<WORD>(VK_MENU), static_cast<WORD>(VK_SHIFT),
                 static_cast<WORD>(VK_LWIN)}) {
    if (GetAsyncKeyState(m) & 0x8000) in.push_back(keyInput(m, true));
  }
  sendAll(in);
}

namespace {

// The deepest child window under a screen point, for posted mouse messages.
HWND childAt(HWND top, POINT screen) {
  HWND current = top;
  for (int depth = 0; depth < 16; ++depth) {
    POINT client = screen;
    ScreenToClient(current, &client);
    HWND child = ChildWindowFromPointEx(current, client, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
    if (!child || child == current) break;
    current = child;
  }
  return current;
}

}  // namespace

bool postClick(HWND hwnd, int screenX, int screenY, const std::string& button, int count) {
  POINT p = {screenX, screenY};
  HWND target = childAt(hwnd, p);
  POINT client = p;
  ScreenToClient(target, &client);
  LPARAM lp = MAKELPARAM(client.x, client.y);
  UINT down = WM_LBUTTONDOWN, up = WM_LBUTTONUP, dbl = WM_LBUTTONDBLCLK;
  WPARAM mk = MK_LBUTTON;
  if (button == "right") {
    down = WM_RBUTTONDOWN;
    up = WM_RBUTTONUP;
    dbl = WM_RBUTTONDBLCLK;
    mk = MK_RBUTTON;
  }
  PostMessageW(target, WM_MOUSEMOVE, 0, lp);
  for (int i = 0; i < std::max(1, std::min(count, 3)); ++i) {
    PostMessageW(target, i == 1 ? dbl : down, mk, lp);
    PostMessageW(target, up, 0, lp);
  }
  return true;
}

bool postScroll(HWND hwnd, int screenX, int screenY, const std::string& direction, int amount) {
  POINT p = {screenX, screenY};
  HWND target = childAt(hwnd, p);
  bool horizontal = direction == "left" || direction == "right";
  int sign = (direction == "down" || direction == "left") ? -1 : 1;
  for (int i = 0; i < std::max(1, std::min(amount, 50)); ++i) {
    PostMessageW(target, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, MAKEWPARAM(0, sign * WHEEL_DELTA),
                 MAKELPARAM(screenX, screenY));
  }
  return true;
}

bool postText(HWND hwnd, const std::wstring& text) {
  HWND target = hwnd;
  GUITHREADINFO gti = {sizeof(gti)};
  if (!GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, nullptr), &gti) || !gti.hwndFocus) return false;
  target = gti.hwndFocus;
  if (target != hwnd && !IsChild(hwnd, target)) return false;
  for (size_t i = 0; i < text.size(); ++i) {
    wchar_t c = text[i];
    if (c == L'\r' && i + 1 < text.size() && text[i + 1] == L'\n') ++i;
    if (!PostMessageW(target, WM_CHAR, c == L'\n' ? L'\r' : c, 1)) return false;
  }
  return true;
}

HWND currentForeground() { return GetForegroundWindow(); }

bool forceForeground(HWND hwnd) {
  if (!hwnd || !IsWindow(hwnd)) return false;
  if (GetForegroundWindow() == hwnd) return true;
  HWND fg = GetForegroundWindow();
  DWORD fgThread = fg ? GetWindowThreadProcessId(fg, nullptr) : 0;
  DWORD self = GetCurrentThreadId();
  bool attached = fgThread && fgThread != self && AttachThreadInput(self, fgThread, TRUE);
  BOOL ok = SetForegroundWindow(hwnd);
  if (attached) AttachThreadInput(self, fgThread, FALSE);
  if (!ok) {
    // The documented way around the foreground lock for a process the user
    // is not interacting with: a synthetic Alt tap marks input as recent.
    INPUT alt[2] = {};
    alt[0].type = INPUT_KEYBOARD;
    alt[0].ki.wVk = VK_MENU;
    alt[1] = alt[0];
    alt[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, alt, sizeof(INPUT));
    ok = SetForegroundWindow(hwnd);
  }
  return ok != FALSE;
}

}  // namespace ade
