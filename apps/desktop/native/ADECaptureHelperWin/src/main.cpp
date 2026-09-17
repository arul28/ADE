// ADE's global capture helper, Windows half.
//
// Same NDJSON contract as the macOS helper in native/ADECaptureHelper:
//
//   stdin   {"type":"capture"} | {"type":"settings","enabled":bool} | {"type":"quit"}
//   stdout  {"type":"ready"} | {"type":"chord"} | {"type":"captured",...}
//           | {"type":"permission-denied"} | {"type":"no-window"}
//           | {"type":"capture-failed","message":...}
//
// Three things about this process are load-bearing:
//
// 1. SHUTDOWN IS `{"type":"quit"}` ON STDIN. Windows has no deliverable
//    SIGTERM: Node's `child.kill("SIGTERM")` becomes TerminateProcess, which
//    gives a process mid-BitBlt no chance to release its DCs and bitmaps. The
//    supervisor sends `quit`, this process posts WM_QUIT to its own message
//    loop, and the forced kill is only the backstop for a wedged helper. The
//    loop ALSO exits when stdin closes, so an orphaned helper cannot survive
//    its parent.
//
// 2. THE HOOK MUST NOT BLOCK — AND NEITHER MAY THE LOOP THAT SERVES IT.
//    `WH_KEYBOARD_LL` calls back on the thread that installed it, and Windows
//    silently removes a hook whose thread stops pumping messages
//    (LowLevelHooksTimeout, 300ms by default). So the hook callback does
//    nothing but flip two booleans and PostMessage — no capture, no file I/O,
//    no allocation. That is only half the rule: the posted message is handled
//    by the SAME thread, so running the capture there stalls the pump for as
//    long as PrintWindow + a PNG encode take — routinely past 300ms on a large
//    or unresponsive window — and the hook is removed with no error anywhere.
//    The chord then simply stops working until the helper restarts. The
//    capture therefore runs on a detached worker (mirroring the macOS helper's
//    `DispatchQueue.global(qos: .userInitiated)`), one at a time, while this
//    thread keeps pumping.
//
// 3. THE CHORD IS BOTH CTRL KEYS, read from the hook struct's `vkCode`, which
//    reports VK_LCONTROL and VK_RCONTROL separately. Polling cannot replace the
//    hook: GetKeyState collapses both into VK_CONTROL, and polling at all would
//    mean a timer racing the user's fingers. GetAsyncKeyState(VK_LCONTROL /
//    VK_RCONTROL) IS side-aware, which is why it seeds the two flags once at
//    startup - the hook only ever learns a key is up from an event, so a Ctrl
//    already held when the helper starts would otherwise stay stuck false.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <dwmapi.h>
#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Present in the Windows 8+ SDK; defined here so an older SDK still compiles
// rather than silently losing the only capture path that works for Chromium and
// DirectComposition windows.
#ifndef PW_RENDERFULLCONTENT
#define PW_RENDERFULLCONTENT 0x00000002
#endif

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dwmapi.lib")

namespace {

constexpr UINT kMsgChord = WM_APP + 1;
constexpr UINT kMsgCapture = WM_APP + 2;

std::mutex g_stdout_mutex;
std::atomic<bool> g_enabled{true};
std::atomic<bool> g_left_ctrl_down{false};
std::atomic<bool> g_right_ctrl_down{false};
// Latch, exactly as in the macOS ChordDetector: modifier keys are held, and key
// repeat would otherwise fire the gesture dozens of times for one press.
std::atomic<bool> g_chord_engaged{false};
// One capture at a time, and never on the message-loop thread. See the
// dispatch in main() for why.
std::atomic<bool> g_capture_in_flight{false};
DWORD g_main_thread_id = 0;
HHOOK g_keyboard_hook = nullptr;
std::wstring g_output_directory;

/* ───────────────────────────── stdout ───────────────────────────── */

void EmitRaw(const std::string& line) {
  std::lock_guard<std::mutex> guard(g_stdout_mutex);
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fflush(stdout);
}

// Minimal JSON string escaping. The only values that ever reach it are a
// filesystem path, a window title and an error message, but a window title is
// attacker-influenced in the sense that any app can set one containing a quote.
std::string JsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out += static_cast<char>(ch);
        }
    }
  }
  return out;
}

std::string Utf8From(const std::wstring& value) {
  if (value.empty()) return std::string();
  int needed = WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
                                   static_cast<int>(value.size()),
                                   nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
                      out.data(), needed, nullptr, nullptr);
  return out;
}

void EmitSimple(const char* type) {
  EmitRaw(std::string("{\"type\":\"") + type + "\"}\n");
}

void EmitFailure(const std::string& message) {
  EmitRaw("{\"type\":\"capture-failed\",\"message\":\"" + JsonEscape(message) + "\"}\n");
}

/* ───────────────────────────── keyboard hook ───────────────────────────── */

LRESULT CALLBACK LowLevelKeyboardProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const KBDLLHOOKSTRUCT* event = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    if (event != nullptr && event->vkCode == VK_LCONTROL) {
      // Right Ctrl arrives as VK_RCONTROL, left as VK_LCONTROL, but only the
      // low-level hook reports them separately at all - GetAsyncKeyState(VK_CONTROL)
      // collapses both.
      const bool down = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
      g_left_ctrl_down.store(down);
    } else if (event != nullptr && event->vkCode == VK_RCONTROL) {
      const bool down = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
      g_right_ctrl_down.store(down);
    }
    const bool both = g_left_ctrl_down.load() && g_right_ctrl_down.load();
    const bool was_engaged = g_chord_engaged.exchange(both);
    if (both && !was_engaged && g_enabled.load()) {
      // PostMessage, never the capture itself: this callback runs on the
      // installing thread and a slow one gets the hook silently uninstalled.
      PostThreadMessage(g_main_thread_id, kMsgChord, 0, 0);
    }
  }
  return CallNextHookEx(g_keyboard_hook, code, wParam, lParam);
}

/* ───────────────────────────── capture ───────────────────────────── */

int GetPngEncoderClsid(CLSID* clsid) {
  UINT count = 0;
  UINT size = 0;
  if (Gdiplus::GetImageEncodersSize(&count, &size) != Gdiplus::Ok || size == 0) return -1;
  std::vector<BYTE> buffer(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buffer.data());
  if (Gdiplus::GetImageEncoders(count, size, encoders) != Gdiplus::Ok) return -1;
  for (UINT i = 0; i < count; ++i) {
    if (wcscmp(encoders[i].MimeType, L"image/png") == 0) {
      *clsid = encoders[i].Clsid;
      return 0;
    }
  }
  return -1;
}

std::wstring NextCapturePath() {
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  std::wstring path = g_output_directory;
  if (!path.empty() && path.back() != L'\\') path += L'\\';
  path += L"capture-";
  path += std::to_wstring(now);
  path += L".png";
  return path;
}

/**
 * The executable base name of the process that owns a window, without ".exe".
 *
 * QueryFullProcessImageNameW rather than GetModuleFileNameEx: it needs only
 * PROCESS_QUERY_LIMITED_INFORMATION, which a medium-integrity process is
 * granted for most other processes, where the module APIs would fail. An empty
 * string is an ordinary answer - an elevated or protected process refuses the
 * handle, and the shot is still worth delivering without a name.
 */
std::wstring OwnerAppName(DWORD owner_pid) {
  if (owner_pid == 0) return std::wstring();
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, owner_pid);
  if (process == nullptr) return std::wstring();
  wchar_t buffer[MAX_PATH * 2] = {0};
  DWORD length = static_cast<DWORD>(std::size(buffer));
  const BOOL ok = QueryFullProcessImageNameW(process, 0, buffer, &length);
  CloseHandle(process);
  if (!ok || length == 0) return std::wstring();
  std::wstring full(buffer, length);
  const size_t slash = full.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? full : full.substr(slash + 1);
  if (name.size() > 4) {
    const std::wstring tail = name.substr(name.size() - 4);
    if (_wcsicmp(tail.c_str(), L".exe") == 0) name.resize(name.size() - 4);
  }
  return name;
}

void PerformCapture() {
  HWND window = GetForegroundWindow();
  if (window == nullptr || !IsWindow(window) || IsIconic(window)) {
    EmitSimple("no-window");
    return;
  }

  RECT rect{};
  // The *extended frame* bounds, not GetWindowRect: since Vista a window's
  // rect includes the invisible resize border, so BitBlt of GetWindowRect
  // produces a screenshot with transparent gutters down both sides.
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))
      && !GetWindowRect(window, &rect)) {
    EmitFailure("The window bounds could not be read.");
    return;
  }
  const int width = rect.right - rect.left;
  const int height = rect.bottom - rect.top;
  if (width < 40 || height < 40) {
    EmitSimple("no-window");
    return;
  }

  HDC screen_dc = GetDC(nullptr);
  if (screen_dc == nullptr) {
    EmitFailure("No screen device context is available.");
    return;
  }
  HDC memory_dc = CreateCompatibleDC(screen_dc);
  HBITMAP bitmap = memory_dc ? CreateCompatibleBitmap(screen_dc, width, height) : nullptr;
  if (memory_dc == nullptr || bitmap == nullptr) {
    if (bitmap) DeleteObject(bitmap);
    if (memory_dc) DeleteDC(memory_dc);
    ReleaseDC(nullptr, screen_dc);
    EmitFailure("A capture buffer could not be allocated.");
    return;
  }
  HGDIOBJ previous = SelectObject(memory_dc, bitmap);

  // PrintWindow first: it asks the window to redraw itself, which is the only
  // way to capture a window that is partly covered, and PW_RENDERFULLCONTENT is
  // what makes it work for DirectComposition/Chromium surfaces. Some windows
  // still return a blank frame, so BitBlt of the screen is the fallback - it
  // captures whatever is actually on top, which is at least honest.
  BOOL printed = PrintWindow(window, memory_dc, PW_RENDERFULLCONTENT);
  if (!printed) {
    printed = BitBlt(memory_dc, 0, 0, width, height, screen_dc, rect.left, rect.top,
                     SRCCOPY | CAPTUREBLT);
  }

  // Unselect BEFORE encoding. GDI batches drawing per thread, and an HBITMAP
  // that is still selected into a DC may have writes outstanding that GDI+
  // never sees - `Gdiplus::Bitmap(HBITMAP, ...)` reads the bits directly and
  // does not flush for you. The result is a torn or blank PNG on a machine
  // fast enough to reach the encode before the batch drains. SelectObject of
  // the previous object flushes the DC and hands the bitmap back, which is the
  // supported way to read it.
  SelectObject(memory_dc, previous);

  bool saved = false;
  std::wstring destination;
  if (printed) {
    CLSID png_clsid{};
    if (GetPngEncoderClsid(&png_clsid) == 0) {
      CreateDirectoryW(g_output_directory.c_str(), nullptr);
      destination = NextCapturePath();
      Gdiplus::Bitmap image(bitmap, nullptr);
      saved = image.Save(destination.c_str(), &png_clsid, nullptr) == Gdiplus::Ok;
    }
  }

  DeleteObject(bitmap);
  DeleteDC(memory_dc);
  ReleaseDC(nullptr, screen_dc);

  if (!saved) {
    // Windows has no screen-capture permission gate, so there is no
    // `permission-denied` path here: a refusal is always a technical failure.
    EmitFailure("The window could not be captured.");
    return;
  }

  wchar_t title_buffer[512] = {0};
  GetWindowTextW(window, title_buffer, 511);
  DWORD owner_pid = 0;
  GetWindowThreadProcessId(window, &owner_pid);

  std::string payload = "{\"type\":\"captured\",\"path\":\"";
  payload += JsonEscape(Utf8From(destination));
  payload += "\"";
  // `describeShot` names the app before the window title, and the macOS helper
  // supplies it from kCGWindowOwnerName. Windows has no equivalent, so the
  // closest honest answer is the owning process's executable base name -
  // "Chrome", "Xcode", "Slack" - which is what the user calls the app anyway.
  const std::string app = JsonEscape(Utf8From(OwnerAppName(owner_pid)));
  if (!app.empty()) {
    payload += ",\"appName\":\"" + app + "\"";
  }
  const std::string title = JsonEscape(Utf8From(title_buffer));
  if (!title.empty()) {
    payload += ",\"windowTitle\":\"" + title + "\"";
  }
  payload += ",\"ownerPid\":" + std::to_string(static_cast<unsigned long>(owner_pid));
  payload += ",\"bounds\":{\"x\":" + std::to_string(rect.left)
           + ",\"y\":" + std::to_string(rect.top)
           + ",\"width\":" + std::to_string(width)
           + ",\"height\":" + std::to_string(height) + "}}\n";
  EmitRaw(payload);
}

/* ───────────────────────────── stdin ───────────────────────────── */

/**
 * True when the line really is `{"type": <type>}` - not merely a line that
 * mentions both somewhere.
 *
 * A bare substring search anywhere after the key matched `{"type":"settings",
 * "note":"\"quit\""}` as a quit, so one crafted or simply chatty field ended
 * the helper. The value has to follow the key and its colon immediately, with
 * only whitespace between, which is the whole grammar the host ever emits.
 */
bool JsonHasType(const std::string& line, const char* type) {
  const std::string needle = std::string("\"type\"");
  size_t key = line.find(needle);
  while (key != std::string::npos) {
    size_t cursor = key + needle.size();
    while (cursor < line.size() && std::isspace(static_cast<unsigned char>(line[cursor]))) cursor += 1;
    if (cursor < line.size() && line[cursor] == ':') {
      cursor += 1;
      while (cursor < line.size() && std::isspace(static_cast<unsigned char>(line[cursor]))) cursor += 1;
      if (line.compare(cursor, std::strlen(type), type) == 0) return true;
    }
    key = line.find(needle, key + needle.size());
  }
  return false;
}

void ReadCommands() {
  std::string line;
  int ch = 0;
  while ((ch = std::fgetc(stdin)) != EOF) {
    if (ch != '\n') {
      if (ch != '\r') line.push_back(static_cast<char>(ch));
      // A single line can never legitimately exceed this; a runaway write on
      // the pipe must not grow the buffer without bound.
      if (line.size() > 64 * 1024) line.clear();
      continue;
    }
    if (!line.empty()) {
      if (JsonHasType(line, "\"quit\"")) {
        PostThreadMessage(g_main_thread_id, WM_QUIT, 0, 0);
        return;
      }
      if (JsonHasType(line, "\"capture\"")) {
        PostThreadMessage(g_main_thread_id, kMsgCapture, 0, 0);
      } else if (JsonHasType(line, "\"settings\"")) {
        g_enabled.store(line.find("\"enabled\":false") == std::string::npos);
        // Clear the half-state too, not just the chord latch. The hook only
        // ever learns a key is UP from an event, so a Ctrl held across a
        // disable/enable leaves its flag stuck down and the very next press of
        // the OTHER Ctrl fires a capture the user never chorded.
        g_left_ctrl_down.store(false);
        g_right_ctrl_down.store(false);
        g_chord_engaged.store(false);
      }
    }
    line.clear();
  }
  // stdin closed: ADE is gone. Nothing is reading our events any more, so the
  // hook and the message loop have no reason to stay installed.
  PostThreadMessage(g_main_thread_id, WM_QUIT, 0, 0);
}

std::wstring ResolveOutputDirectory() {
  wchar_t buffer[MAX_PATH * 2] = {0};
  DWORD length = GetEnvironmentVariableW(L"ADE_CAPTURE_OUTPUT_DIR", buffer,
                                         static_cast<DWORD>(std::size(buffer)));
  if (length > 0 && length < std::size(buffer)) return std::wstring(buffer, length);
  wchar_t temp[MAX_PATH + 1] = {0};
  const DWORD temp_length = GetTempPathW(MAX_PATH, temp);
  std::wstring fallback(temp, temp_length);
  // Only reached when the host passed no directory. The host always does,
  // and its path is per channel; this is a last resort, not a shared location.
  fallback += L"ade-capture-fallback";
  return fallback;
}

}  // namespace

int main() {
  // Binary stdout: the default text mode turns every \n in the NDJSON stream
  // into \r\n, which the supervisor's line splitter would hand to JSON.parse
  // with a stray carriage return attached.
  _setmode(_fileno(stdout), _O_BINARY);

  g_main_thread_id = GetCurrentThreadId();
  g_output_directory = ResolveOutputDirectory();
  CreateDirectoryW(g_output_directory.c_str(), nullptr);

  Gdiplus::GdiplusStartupInput gdiplus_input;
  ULONG_PTR gdiplus_token = 0;
  if (Gdiplus::GdiplusStartup(&gdiplus_token, &gdiplus_input, nullptr) != Gdiplus::Ok) {
    EmitFailure("GDI+ could not be initialized.");
    return 1;
  }

  // Per-monitor DPI awareness so PrintWindow sees physical pixels. Without it
  // the captured bitmap of a window on a scaled display is blurry and the
  // bounds we report do not match what the user saw.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Seed both latches from the real keyboard state (see note 3 at the top).
  // They start false and the hook only observes transitions, so a user already
  // holding a Ctrl when the helper starts - which is how it starts: ADE
  // launches it while the user is typing - has that side stuck false until
  // they release and press it again, and the chord silently does not work.
  g_left_ctrl_down.store((GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0);
  g_right_ctrl_down.store((GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0);
  g_chord_engaged.store(g_left_ctrl_down.load() && g_right_ctrl_down.load());

  g_keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc,
                                      GetModuleHandleW(nullptr), 0);
  if (g_keyboard_hook == nullptr) {
    // The only way this fails in practice is a policy or integrity-level block,
    // which is the closest Windows equivalent of the macOS permission refusal.
    EmitSimple("permission-denied");
  }

  std::thread stdin_thread(ReadCommands);
  stdin_thread.detach();

  EmitSimple("ready");

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == kMsgChord) {
      if (g_enabled.load()) EmitSimple("chord");
    } else if (message.message == kMsgCapture) {
      // Detached rather than joined: joining here would be the very stall this
      // exists to avoid. The latch keeps it to one at a time, and the shutdown
      // path below waits for it to clear before GDI+ goes away.
      if (!g_capture_in_flight.exchange(true)) {
        std::thread([] {
          PerformCapture();
          g_capture_in_flight.store(false);
        }).detach();
      }
    } else {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

  if (g_keyboard_hook != nullptr) UnhookWindowsHookEx(g_keyboard_hook);
  // A detached worker still holding GDI+ objects when GdiplusShutdown runs is a
  // crash on the way out, which the supervisor would read as a helper that
  // died. The bound is the supervisor's own grace window
  // (GRACEFUL_SHUTDOWN_MS in captureHelper.ts): waiting longer than that buys
  // nothing, because it kills us at that mark regardless, and waiting less
  // would tear GDI+ down while the process is still alive and working.
  constexpr int kShutdownDrainMs = 500;
  for (int waited = 0; g_capture_in_flight.load() && waited < kShutdownDrainMs; waited += 25) {
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  Gdiplus::GdiplusShutdown(gdiplus_token);
  return 0;
}
