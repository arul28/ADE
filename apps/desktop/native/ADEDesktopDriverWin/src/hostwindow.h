// The host's own window: the Remote Desktop control's frame, which is the
// sign-in window the user may see, and the parked frame of a live private
// screen.

#pragma once

#include "common.h"

namespace ade {

// Brings a window this background process owns in front of the user's
// foreground app (ADE). A process without foreground rights cannot simply
// SetForegroundWindow; attaching to the foreground thread's input usually
// allows it, and a topmost window is above ADE even when activation is refused.
void bringToFront(HWND window, bool keepTopmost);

// Windows treats the private session as minimized while the Remote Desktop
// control that shows it is hidden: the session keeps drawing, but it drops
// every injected pointer and key event (SetCursorPos and SendInput change
// nothing, so no click, key or window activation reaches an app there). The
// control stays shown, at its full size, outside every monitor, and off the
// taskbar and Alt+Tab, so the session stays live and the user sees nothing.
void parkHostWindow(HWND window, int width, int height);

// Undoes parkHostWindow before a sign-in, which may show this window to the
// user: on the primary monitor, on the taskbar.
void unparkHostWindow(HWND window, int width, int height);

}  // namespace ade
