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
// 2. THE HOOK MUST NOT BLOCK. `WH_KEYBOARD_LL` calls back on the thread that
//    installed it, and Windows silently removes a hook whose thread stops
//    pumping messages (LowLevelHooksTimeout, 300ms by default). So the hook
//    callback does nothing but flip two booleans and PostMessage — no capture,
//    no file I/O, no allocation.
//
// 3. THE CHORD IS BOTH CTRL KEYS, read from the hook struct's `vkCode`, which
//    reports VK_LCONTROL and VK_RCONTROL separately. GetAsyncKeyState cannot:
//    it collapses both into VK_CONTROL, so "both Ctrl keys" is not expressible
//    there at all.

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
#include <chrono>
#include <cstdio>
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

  SelectObject(memory_dc, previous);
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

bool JsonHasType(const std::string& line, const char* type) {
  const std::string needle = std::string("\"type\"");
  const size_t key = line.find(needle);
  if (key == std::string::npos) return false;
  const size_t value = line.find(type, key);
  return value != std::string::npos;
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
  fallback += L"ade-capture";
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
      PerformCapture();
    } else {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

  if (g_keyboard_hook != nullptr) UnhookWindowsHookEx(g_keyboard_hook);
  Gdiplus::GdiplusShutdown(gdiplus_token);
  return 0;
}
