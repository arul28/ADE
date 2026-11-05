#include "background.h"

#include "desk.h"
#include "parkedwindows.h"

#include <algorithm>
#include <thread>
#include <vector>

namespace ade {

namespace {

bool startsWith(const std::wstring& s, const wchar_t* prefix) { return s.rfind(prefix, 0) == 0; }

HWND rootOf(HWND hwnd) {
  HWND root = hwnd ? GetAncestor(hwnd, GA_ROOT) : nullptr;
  return root ? root : hwnd;
}

std::wstring exeNameOf(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  return pid ? lower(baseName(processImagePath(pid))) : L"";
}

bool isChromiumClass(const std::wstring& cls) {
  return startsWith(cls, L"Chrome_WidgetWin_") || startsWith(cls, L"CefBrowser");
}

// Whether any descendant of `top` has a class `match` accepts.
bool hasChild(HWND top, bool (*match)(const std::wstring&)) {
  struct Search {
    bool (*match)(const std::wstring&);
    bool found;
  } search{match, false};
  EnumChildWindows(
      top,
      [](HWND child, LPARAM param) -> BOOL {
        auto& s = *reinterpret_cast<Search*>(param);
        if (!s.match(className(child))) return TRUE;
        s.found = true;
        return FALSE;
      },
      reinterpret_cast<LPARAM>(&search));
  return search.found;
}

// UWP and WinUI hosts. Windows 11 Notepad keeps the classic "Notepad" class
// while rendering XAML, so the process name is the steadier signal; the
// Windows 10 Notepad of the same name is a classic Edit control.
bool isXamlHost(HWND root) {
  static const wchar_t* classes[] = {L"ApplicationFrameWindow", L"WinUIDesktopWin32WindowClass",
                                     L"Windows.UI.Core.CoreWindow", L"Microsoft.UI.Content.DesktopChildSiteBridge"};
  static const wchar_t* exes[] = {L"calculatorapp.exe", L"calc.exe", L"applicationframehost.exe",
                                  L"photos.exe", L"systemsettings.exe"};
  const std::wstring cls = className(root);
  for (auto c : classes) if (cls == c) return true;
  const std::wstring exe = exeNameOf(root);
  if (exe == L"notepad.exe") return !hasChild(root, [](const std::wstring& c) { return c == L"Edit"; });
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
  const std::wstring cls = className(root);
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
  if ((kind == K::Scroll || kind == K::Drag) && hasChild(root, isChromiumClass)) return true;
  return false;
}

bool shieldApplies(HWND root) { return isChromiumClass(className(root)) || isXamlHost(root); }

ParkedWindowsRecord* shieldRecord = nullptr;

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

Json backgroundDrop(HWND window, PostedInput kind) {
  HWND root = rootOf(window);
  if (!root) return Json();
  failIfElevatedWindow(root, false);
  if (!drops(root, kind)) return Json();
  Json row = Json::object();
  row["app"] = narrow(exeNameOf(root));
  row["windowClass"] = narrow(className(root));
  row["input"] = std::string(kindName(kind));
  return row;
}

void failBackgroundDropped(const Json& row) {
  const std::string app = row["app"].str();
  throw DriverError{code::kBackgroundUnavailable,
                    (app.empty() ? std::string("This app") : app) + " ignores background " + row["input"].str() +
                        " on the main desktop.",
                    row};
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

void postClick(HWND hwnd, int screenX, int screenY, const std::string& button, int count) {
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
}

void postDrag(HWND hwnd, POINT from, POINT to, int durationMs) {
  POINT c = from;
  ScreenToClient(hwnd, &c);
  PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(c.x, c.y));
  for (int i = 1; i <= 12; ++i) {
    POINT s = {from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12};
    ScreenToClient(hwnd, &s);
    PostMessageW(hwnd, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(s.x, s.y));
    Sleep(std::max(1, durationMs / 12));
  }
  POINT e = to;
  ScreenToClient(hwnd, &e);
  PostMessageW(hwnd, WM_LBUTTONUP, 0, MAKELPARAM(e.x, e.y));
}

void postScroll(HWND hwnd, int screenX, int screenY, const std::string& direction, int amount) {
  POINT p = {screenX, screenY};
  HWND target = childAt(hwnd, p);
  bool horizontal = direction == "left" || direction == "right";
  int sign = (direction == "down" || direction == "left") ? -1 : 1;
  for (int i = 0; i < std::max(1, std::min(amount, 50)); ++i) {
    PostMessageW(target, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, MAKEWPARAM(0, sign * WHEEL_DELTA),
                 MAKELPARAM(screenX, screenY));
  }
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

bool postText(HWND hwnd, const std::wstring& text) {
  // The focused control may sit on another UI thread than the frame (a
  // WebView2 does), so look across all of them.
  HWND target = focusedTarget(hwnd);
  if (!target) return false;
  for (size_t i = 0; i < text.size(); ++i) {
    wchar_t c = text[i];
    if (c == L'\r' || c == L'\n') {
      if (c == L'\r' && i + 1 < text.size() && text[i + 1] == L'\n') ++i;
      // A line break is an Enter key, not a character: rich editors
      // (RichEdit, Scintilla, LibreOffice) drop WM_CHAR 0x0A and some drop
      // 0x0D, but every one takes VK_RETURN. Give the new paragraph a moment.
      postKey(target, "return");
      Sleep(20);
      continue;
    }
    if (!PostMessageW(target, WM_CHAR, c, 1)) return false;
  }
  return true;
}

ForegroundShield::ForegroundShield(HWND window) {
  HWND root = rootOf(window);
  if (!root || !IsWindow(root) || IsHungAppWindow(root) || !shieldApplies(root)) return;
  // EnableWindow returns nonzero when the window was already disabled (a
  // modal dialog's owner, or a shield further up this call): leave that one
  // as it is.
  if (EnableWindow(root, FALSE)) return;
  root_ = root;
  if (shieldRecord) shieldRecord->setShielded(root, true);
}

ForegroundShield::~ForegroundShield() {
  if (!root_) return;
  // An app that hung inside the call would hold the input worker in
  // EnableWindow until it answers, so a thread of its own waits instead. The
  // mark stays (the thread may outlive the record at exit), and the next host
  // re-enables a window that is enabled already, which does nothing.
  if (IsHungAppWindow(root_)) {
    logLine("foreground-shield: the window stopped responding; re-enabling it in the background");
    std::thread([root = root_] { EnableWindow(root, TRUE); }).detach();
    return;
  }
  EnableWindow(root_, TRUE);
  if (shieldRecord) shieldRecord->setShielded(root_, false);
}

void setShieldRecord(ParkedWindowsRecord* record) { shieldRecord = record; }

}  // namespace ade
