// Background input on the shared seat: messages posted to one lane window,
// with no pointer and no foreground change.
//
// PostMessage reports success whether or not the app acts on the message, and
// several UI frameworks ignore posted input entirely. So before posting, the
// driver checks the target's framework and refuses with
// WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE instead of claiming a click or key
// that never landed. The service falls back to real input for keys and text,
// and posts a click, scroll or drag anyway (`BackgroundOverride`), since a
// parked window has no real path for one.
//
// The framework table, the focused-child walk and the foreground shield follow
// trycua/cua's cua-driver (MIT), `platform-windows/src/input/delivery.rs`,
// `input/keyboard.rs` and `uia/fg_bypass.rs`, where each row was measured.

#pragma once

#include "common.h"

#include <string>

namespace ade {

enum class PostedInput { Click, Drag, Scroll, Key, Text };

// Refuses an administrator window (WINDOWS_DESKTOP_ELEVATED_WINDOW: Windows
// drops posted input from the un-elevated driver) and a window whose framework
// is known to drop this kind of posted input (WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE).
// The refusal carries `app` (exe name), `windowClass` and `input` for the
// service's report; never a window title.
void failIfBackgroundDropped(HWND window, PostedInput kind);

// While one is alive on this thread, a framework row no longer refuses: the
// input is posted as it was before the table existed, and `used()` says so.
// The service asks for this (`forceBackground`) on its retry when a refused
// action has no real-input path, so nothing that worked before stops working
// on the strength of a table not yet measured here. The elevated refusal stands.
class BackgroundOverride {
 public:
  explicit BackgroundOverride(bool on);
  ~BackgroundOverride();
  BackgroundOverride(const BackgroundOverride&) = delete;
  BackgroundOverride& operator=(const BackgroundOverride&) = delete;
  bool used() const;

 private:
  bool previous_ = false;
};

// The window that has keyboard focus inside `top`: `top` itself or the deepest
// focused descendant across every UI thread under it (WebView2 keeps its
// focused child on a thread of its own). Null when nothing in `top` has focus.
HWND focusedTarget(HWND top);

// Posts one key press (WM_KEYDOWN, then WM_KEYUP) with no modifiers to the
// focused control inside `window`, or to `window` itself. Throws
// invalid_argument for an unknown key name and WINDOWS_DESKTOP_BACKGROUND_UNAVAILABLE
// for a key that needs Shift: posted keys do not change the keyboard state an
// app reads for modifiers.
void postKey(HWND window, const std::string& key);

// UWP, WinUI and Chromium apps call SetForegroundWindow on themselves while
// they handle a UI Automation Invoke, Toggle, Select, Expand or SetValue, which
// pulls a parked lane window in front of the user. Disabling the window's root
// for the call blocks that, and the pattern still lands (UI Automation does not
// go through the input queue EnableWindow gates). Other frameworks do not steal,
// so the shield does nothing for them, nor for a null window.
class ForegroundShield {
 public:
  explicit ForegroundShield(HWND window);
  ~ForegroundShield();
  ForegroundShield(const ForegroundShield&) = delete;
  ForegroundShield& operator=(const ForegroundShield&) = delete;

 private:
  HWND root_ = nullptr;
};

// Re-enables every window a shield holds. For a host about to end itself while
// a UI Automation call is stuck inside a shield, so no app stays disabled.
void releaseForegroundShields();

}  // namespace ade
