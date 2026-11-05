// Background input on the shared seat: messages posted to one lane window,
// with no pointer and no foreground change.
//
// PostMessage reports success whether or not the app acts on the message, and
// several UI frameworks ignore posted input entirely. So before posting, the
// driver checks the target's framework (`backgroundDrop`). The service asks for
// keys and text to be refused there, and sends them again as real input; a
// click, scroll or drag has no real path on a parked window, so for those (and
// for a caller's explicit mode) it asks the driver to post anyway and to name
// the row in its reply.
//
// The framework table, the focused-child walk and the foreground shield follow
// trycua/cua's cua-driver (MIT), `platform-windows/src/input/delivery.rs`,
// `input/keyboard.rs` and `uia/fg_bypass.rs`, where each row was measured.

#pragma once

#include "common.h"

#include <string>

namespace ade {

class ParkedWindowsRecord;

enum class PostedInput { Click, Drag, Scroll, Key, Text };

// Refuses an administrator window (WINDOWS_DESKTOP_ELEVATED_WINDOW: Windows
// drops posted input from the un-elevated driver). Then, when the window's
// framework is known to drop this kind of posted input, returns the row as
// {app (exe name), windowClass, input}; never a window title. Null otherwise.
Json backgroundDrop(HWND window, PostedInput kind);

// The refusal for a row `backgroundDrop` returned:
// WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE carrying the row's fields.
[[noreturn]] void failBackgroundDropped(const Json& row);

// The window that has keyboard focus inside `top`: `top` itself or the deepest
// focused descendant across every UI thread under it (WebView2 keeps its
// focused child on a thread of its own). Null when nothing in `top` has focus.
HWND focusedTarget(HWND top);

// Posted input, aimed at the child window under the point (or, for keys and
// text, the focused control).
void postClick(HWND hwnd, int screenX, int screenY, const std::string& button, int count);
void postDrag(HWND hwnd, POINT from, POINT to, int durationMs);
void postScroll(HWND hwnd, int screenX, int screenY, const std::string& direction, int amount);
// One key press (WM_KEYDOWN, then WM_KEYUP) with no modifiers. Throws
// invalid_argument for an unknown key name and WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE
// for a key that needs Shift: posted keys do not change the keyboard state an
// app reads for modifiers.
void postKey(HWND window, const std::string& key);
// Characters as WM_CHAR, a line break as an Enter key. False when nothing in
// `hwnd` has focus or the window went away.
bool postText(HWND hwnd, const std::wstring& text);

// UWP, WinUI and Chromium apps call SetForegroundWindow on themselves while
// they handle a UI Automation Invoke, Toggle, Select, Expand, SetValue or
// SetFocus (a posted key's target), which pulls a parked lane window in front
// of the user. Disabling the window's root for the call blocks that, and the
// pattern still lands (UI Automation does not go through the input queue
// EnableWindow gates). Other frameworks do not steal, so the shield does
// nothing for them, nor for a null window or a hung one (EnableWindow would
// wait on it). Never around a window real input just brought forward on
// purpose: SetFocus refuses a disabled window.
//
// A shielded window is marked in the parked-windows record, so a driver that
// dies inside the call does not leave the app disabled: the next host
// re-enables it when it puts the parked windows back.
class ForegroundShield {
 public:
  explicit ForegroundShield(HWND window);
  ~ForegroundShield();
  ForegroundShield(const ForegroundShield&) = delete;
  ForegroundShield& operator=(const ForegroundShield&) = delete;

 private:
  HWND root_ = nullptr;
};

// Where shields mark their windows. Set once by the host before any input.
void setShieldRecord(ParkedWindowsRecord* record);

}  // namespace ade
