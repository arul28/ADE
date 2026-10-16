// The private screen's plumbing on the console side: the Remote Desktop
// ActiveX control that opens the child session.
//
// The Windows SDK ships no header for the Remote Desktop control and the
// Build Tools ship no ATL, so the control is hosted with a minimal OLE site
// written here and driven through late-bound IDispatch by property name. The
// call order is fixed: `ConnectToChildSession` first, then `Server =
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

// The host posts its UI-thread tasks with this message. RdpSession::end pumps
// every other message while it waits for the control to disconnect, but never
// this one: a nested task would re-enter the worker's request.
constexpr UINT kHostUiTaskMessage = WM_APP + 1;

// One child-session connection. Lives on the host's UI thread.
class RdpSession {
 public:
  enum class State { Idle, Connecting, SignedIn, Failed, Ended };

  RdpSession();
  ~RdpSession();
  // Starts connecting inside `hostWindow`. Must run on the UI thread.
  bool begin(HWND hostWindow, int width, int height, std::string* error, const WindowsCredential* credential = nullptr);
  // Disconnects (waiting, while pumping messages, up to `disconnectWaitMs` for
  // the control's OnDisconnected), then closes the control. Must run on the UI
  // thread. Re-entrant calls (WM_CLOSE during the pump) return at once. The
  // caller signs the child session out by id afterwards, whether or not this
  // returned: the control's own teardown is not interruptible.
  void end(int disconnectWaitMs = 5'000);

  // Waits (off the UI thread) until signed in, failed, or timeout.
  State waitSettled(int timeoutMs);
  State state();
  int disconnectReason();
  int extendedDisconnectReason();
  bool passwordRejected();

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
  int reason_ = 0, extendedReason_ = 0;
  bool passwordRejected_ = false;
  bool suppliedCredential_ = false;
  bool disconnectedEvent_ = false;
  bool ending_ = false;  // UI thread only
};

// The child session of this console session, or 0.
DWORD childSessionId();
bool childSessionsEnabled();
bool remoteDesktopAllowed();
// Whether the console session is locked right now.
bool consoleLocked();
// Signs a session out. Only ever called with the child session's id.
bool signOutSession(DWORD sessionId, int64_t deadline = 0);

// What tells one Windows session from a later one that reuses its id: the
// account and the logon and connect times (FILETIME ticks; 0 when not yet set).
struct SessionIdentity {
  std::wstring user;
  int64_t logonTime = 0;
  int64_t connectTime = 0;
};
// False when Windows cannot describe the session (it is gone).
bool querySessionIdentity(DWORD sessionId, SessionIdentity* out);

}  // namespace ade
