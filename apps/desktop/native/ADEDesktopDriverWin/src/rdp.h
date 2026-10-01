// The private screen's plumbing on the console side: the Remote Desktop
// ActiveX control that opens the child session.
//
// The Windows SDK ships no header for the Remote Desktop control and the
// Build Tools ship no ATL, so the control is hosted with a minimal OLE site
// written here and driven through late-bound IDispatch by property name. The
// call order is the one the spike proved (docs/plans/windows-desktop.md,
// "Spike results"): `ConnectToChildSession` first, then `Server =
// "localhost"`, then CredSSP on. Server first, or no CredSSP, fails with
// E_INVALIDARG.
//
// An explicitly saved credential is supplied only in native memory. Without
// one, Windows shows its own sign-in prompt in the host window.

#pragma once

#include "common.h"
#include "credentials.h"

#include <condition_variable>
#include <mutex>
#include <string>

namespace ade {

// One child-session connection. Lives on the host's UI thread.
class RdpSession {
 public:
  enum class State { Idle, Connecting, SignedIn, Failed, Ended };

  RdpSession();
  ~RdpSession();
  // Starts connecting inside `hostWindow`. Must run on the UI thread.
  bool begin(HWND hostWindow, int width, int height, std::string* error, const WindowsCredential* credential = nullptr);
  // Closes the control. The caller signs the session out first.
  void end();

  // Waits (off the UI thread) until signed in, failed, or timeout.
  State waitSettled(int timeoutMs);
  State state();
  int disconnectReason();

  // Called by the event sink on the UI thread.
  void onLoginComplete();
  void onDisconnected(int reason);
  void onLogonError(int error);

 private:
  struct Impl;
  Impl* impl_;
  std::mutex mutex_;
  std::condition_variable changed_;
  State state_ = State::Idle;
  int reason_ = 0;
  bool suppliedCredential_ = false;
};

// The child session of this console session, or 0.
DWORD childSessionId();
bool childSessionsEnabled();
bool remoteDesktopAllowed();
// Whether the console session is locked right now.
bool consoleLocked();
// Signs a session out. Only ever called with the child session's id.
bool signOutSession(DWORD sessionId);

}  // namespace ade
