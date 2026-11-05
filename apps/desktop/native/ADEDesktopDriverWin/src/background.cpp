#include "background.h"

#include "desk.h"

#include <algorithm>
#include <mutex>
#include <set>
#include <vector>

namespace ade {

namespace {

std::wstring classOf(HWND hwnd) {
  wchar_t buf[256];
  int n = GetClassNameW(hwnd, buf, 256);
  return std::wstring(buf, n > 0 ? n : 0);
}

bool startsWith(const std::wstring& s, const wchar_t* prefix) { return s.rfind(prefix, 0) == 0; }

HWND rootOf(HWND hwnd) {
  HWND root = hwnd ? GetAncestor(hwnd, GA_ROOT) : nullptr;
  return root ? root : hwnd;
}

std::wstring exeNameOf(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  std::wstring path = pid ? processImagePath(pid) : L"";
  size_t slash = path.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
  std::transform(name.begin(), name.end(), name.begin(), [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); });
  return name;
}

bool isChromiumClass(const std::wstring& cls) {
  return startsWith(cls, L"Chrome_WidgetWin_") || startsWith(cls, L"CefBrowser");
}

bool hasChromiumChild(HWND top) {
  bool found = false;
  EnumChildWindows(
      top,
      [](HWND child, LPARAM param) -> BOOL {
        if (!isChromiumClass(classOf(child))) return TRUE;
        *reinterpret_cast<bool*>(param) = true;
        return FALSE;
      },
      reinterpret_cast<LPARAM>(&found));
  return found;
}

// UWP and WinUI hosts. Windows 11 Notepad keeps the classic "Notepad" class
// while rendering XAML, so the process name is the steadier signal.
bool isXamlHost(HWND root) {
  static const wchar_t* classes[] = {L"ApplicationFrameWindow", L"WinUIDesktopWin32WindowClass",
                                     L"Windows.UI.Core.CoreWindow", L"Microsoft.UI.Content.DesktopChildSiteBridge"};
  static const wchar_t* exes[] = {L"notepad.exe", L"calculatorapp.exe", L"calc.exe", L"applicationframehost.exe",
                                  L"photos.exe", L"systemsettings.exe"};
  const std::wstring cls = classOf(root);
  for (auto c : classes) if (cls == c) return true;
  const std::wstring exe = exeNameOf(root);
  for (auto e : exes) if (exe == e) return true;
  return false;
}

const char* kindName(PostedInput kind) {
  switch (kind) {
    case PostedInput::Click: return "clicks";
    case PostedInput::Drag: return "drags";
    case PostedInput::Scroll: return "scrolling";
    case PostedInput::Key: return "keys";
    case PostedInput::Text: return "typed text";
  }
  return "input";
}

// Which posted input each framework drops while PostMessage reports success.
bool drops(HWND root, PostedInput kind) {
  using K = PostedInput;
  const std::wstring cls = classOf(root);
  // Chromium and Electron take pointer and key input only from the system
  // input queue.
  if (isChromiumClass(cls)) return true;
  // WPF ignores posted pointer messages unless the real cursor is over the
  // window, and posted keys unless it is the foreground window.
  if (startsWith(cls, L"HwndWrapper")) {
    if (kind == K::Click || kind == K::Drag) return true;
    return kind == K::Key && GetAncestor(GetForegroundWindow(), GA_ROOT) != root;
  }
  // WinUI 3 content is a composition island that reads only real pointer input.
  if (cls == L"WinUIDesktopWin32WindowClass" && (kind == K::Click || kind == K::Drag)) return true;
  // Tk reads button and key state from GetKeyState, which posting leaves alone.
  if (cls == L"TkTopLevel" || startsWith(cls, L"TkTopLevel.")) return kind != K::Drag && kind != K::Scroll;
  // GTK buttons ignore posted clicks (drawing areas accept them; one HWND
  // covers both, so clicks are refused as a whole).
  if (startsWith(cls, L"gdkWindow") || startsWith(cls, L"gdkSurface")) return kind == K::Click;
  // LibreOffice (VCL) runs keys through TranslateAccelerator, which reads
  // GetKeyState; typed text still lands.
  if (startsWith(cls, L"SAL")) return kind == K::Key;
  // XAML editors and controls take keys and characters only from real input
  // (or UI Automation, which the caller tries first).
  if ((kind == K::Key || kind == K::Text) && isXamlHost(root)) return true;
  // A WebView2 inside a native frame takes posted clicks and text, but not
  // the wheel or drags.
  if ((kind == K::Scroll || kind == K::Drag) && hasChromiumChild(root)) return true;
  return false;
}

bool isExtendedKey(WORD vk) {
  switch (vk) {
    case VK_LEFT: case VK_RIGHT: case VK_UP: case VK_DOWN:
    case VK_PRIOR: case VK_NEXT: case VK_HOME: case VK_END:
    case VK_INSERT: case VK_DELETE: case VK_APPS:
      return true;
    default:
      return false;
  }
}

std::mutex& shieldMutex() {
  static std::mutex m;
  return m;
}

std::multiset<HWND>& shielded() {
  static std::multiset<HWND> windows;
  return windows;
}

bool shieldApplies(HWND root) { return isChromiumClass(classOf(root)) || isXamlHost(root); }

}  // namespace

namespace {
thread_local bool overrideOn = false;
thread_local bool overrideUsed = false;
}  // namespace

BackgroundOverride::BackgroundOverride(bool on) : previous_(overrideOn) {
  overrideOn = on;
  overrideUsed = false;
}

BackgroundOverride::~BackgroundOverride() { overrideOn = previous_; }

bool BackgroundOverride::used() const { return overrideUsed; }

void failIfBackgroundDropped(HWND window, PostedInput kind) {
  HWND root = rootOf(window);
  if (!root) return;
  failIfElevatedWindow(root, false);
  if (!drops(root, kind)) return;
  if (overrideOn) {
    overrideUsed = true;
    return;
  }
  WinInfo info;
  std::string app = describeWindow(root, info) && !info.appName.empty() ? narrow(info.appName) : "This app";
  std::string message = app + " (" + narrow(classOf(root)) + ") ignores background " + kindName(kind) + " on the main desktop.";
  if (kind == PostedInput::Key || kind == PostedInput::Text) {
    message += " Send it as real input (--real); the main desktop brings the window forward for it and hands yours back.";
  } else {
    message += " Act on an element by handle instead (observe, then click or scroll --handle), or use the private screen.";
  }
  Json details = Json::object();
  details["app"] = narrow(exeNameOf(root));
  details["windowClass"] = narrow(classOf(root));
  details["input"] = std::string(kindName(kind));
  throw DriverError{code::kBackgroundUnavailable, message, details};
}

HWND focusedTarget(HWND top) {
  if (!top || !IsWindow(top)) return nullptr;
  std::vector<DWORD> threads = {GetWindowThreadProcessId(top, nullptr)};
  EnumChildWindows(
      top,
      [](HWND child, LPARAM param) -> BOOL {
        auto& list = *reinterpret_cast<std::vector<DWORD>*>(param);
        DWORD thread = GetWindowThreadProcessId(child, nullptr);
        if (thread && std::find(list.begin(), list.end(), thread) == list.end()) list.push_back(thread);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&threads));
  HWND best = nullptr;
  int bestDepth = -1;
  for (DWORD thread : threads) {
    GUITHREADINFO gti = {sizeof(gti)};
    if (!thread || !GetGUIThreadInfo(thread, &gti) || !gti.hwndFocus) continue;
    HWND focus = gti.hwndFocus;
    if (focus != top && !IsChild(top, focus)) continue;
    int depth = 0;
    for (HWND w = focus; w && w != top && depth < 64; w = GetParent(w)) ++depth;
    if (depth > bestDepth) {
      best = focus;
      bestDepth = depth;
    }
  }
  return best;
}

void postKey(HWND window, const std::string& key) {
  bool needsShift = false;
  WORD vk = virtualKeyForName(key, &needsShift);
  if (!vk) fail(code::kInvalidArgument, "\"" + key + "\" is not a key this driver knows.");
  if (needsShift) {
    fail(code::kBackgroundUnavailable,
         "\"" + key + "\" needs Shift, and a key posted in the background cannot hold a modifier. Send it as real input (--real).");
  }
  HWND target = focusedTarget(window);
  if (!target) target = window;
  UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  LPARAM down = static_cast<LPARAM>(1u | (scan << 16) | (isExtendedKey(vk) ? 1u << 24 : 0u));
  LPARAM up = static_cast<LPARAM>(static_cast<uint32_t>(down) | (1u << 30) | (1u << 31));
  if (!PostMessageW(target, WM_KEYDOWN, vk, down)) fail(code::kNoWindow, "That window closed before the key was sent.");
  // Let the app translate the key down (which makes its WM_CHAR) first.
  Sleep(4);
  PostMessageW(target, WM_KEYUP, vk, up);
}

ForegroundShield::ForegroundShield(HWND window) {
  HWND root = rootOf(window);
  if (!root || !IsWindow(root) || !shieldApplies(root)) return;
  std::lock_guard<std::mutex> lock(shieldMutex());
  // EnableWindow returns nonzero when the window was already disabled (a
  // modal dialog's owner): leave that one as it is.
  if (EnableWindow(root, FALSE)) return;
  root_ = root;
  shielded().insert(root);
}

ForegroundShield::~ForegroundShield() {
  if (!root_) return;
  std::lock_guard<std::mutex> lock(shieldMutex());
  auto it = shielded().find(root_);
  // Already released by releaseForegroundShields.
  if (it == shielded().end()) return;
  shielded().erase(it);
  EnableWindow(root_, TRUE);
}

void releaseForegroundShields() {
  std::unique_lock<std::mutex> lock(shieldMutex(), std::try_to_lock);
  if (!lock.owns_lock()) return;
  for (HWND w : shielded()) EnableWindow(w, TRUE);
  shielded().clear();
}

}  // namespace ade
