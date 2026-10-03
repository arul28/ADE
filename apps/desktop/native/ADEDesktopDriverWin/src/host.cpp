// Console-session lifecycle and the NDJSON bridge. The RDP control lives on
// the STA thread; pipe I/O and engine requests never block its message pump.
#include "engine.h"
#include "modes.h"
#include "rdp.h"
#include "credentials.h"

#include <sddl.h>
#include <shellapi.h>
#include <wtsapi32.h>
#include <algorithm>
#include <chrono>
#include <fstream>
#include <future>
#include <condition_variable>
#include <deque>
#include <map>
#include <optional>

namespace ade {
namespace {
constexpr UINT kUiTask = WM_APP + 1;

LRESULT CALLBACK hostProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kUiTask) {
    auto* task = reinterpret_cast<std::packaged_task<void()>*>(lp);
    (*task)();
    delete task;
    return 0;
  }
  // Closing the sign-in window cancels sign-in, never closes the user's apps.
  if (msg == WM_CLOSE) {
    auto* rdp = reinterpret_cast<RdpSession*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (rdp) rdp->end();
    ShowWindow(hwnd, SW_HIDE); return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

class Host {
 public:
  Host(HWND window, std::wstring home)
      : window_(window), home_(std::move(home)), output_(GetStdHandle(STD_OUTPUT_HANDLE)),
        shared_(Engine::Mode::Shared, [this](const Json& e) { output_.write(e); }) {
    SetWindowLongPtrW(window_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&rdp_));
    refreshStatus();
  }

  void ui(std::function<void()> fn) {
    auto task = new std::packaged_task<void()>(std::move(fn));
    auto result = task->get_future();
    if (!PostMessageW(window_, kUiTask, 0, reinterpret_cast<LPARAM>(task))) {
      delete task;
      fail(code::kDriverUnavailable, "The Windows screen host stopped.");
    }
    result.get();
  }

  Json buildStatus() {
    Json s = Json::object();
    const bool children = childSessionsEnabled(), allowed = remoteDesktopAllowed();
    const bool console = currentSessionId() == consoleSessionId(), locked = consoleLocked();
    s["childSessionsEnabled"] = children;
    s["remoteDesktopAllowed"] = allowed;
    s["passwordSaved"] = credentialSaved(credentialTarget(home_));
    s["consoleSessionId"] = consoleSessionId();
    s["sessionId"] = currentSessionId();
    s["inConsoleSession"] = console;
    s["locked"] = locked;
    s["holderLaneId"] = holder_.empty() ? Json() : Json(holder_);
    s["heldByLaneName"] = holderName_.empty() ? Json() : Json(holderName_);
    s["childSessionId"] = childId_ ? Json(childId_) : Json();
    s["seatMode"] = !holder_.empty() ? Json("private") : shared_.laneIds().empty() ? Json() : Json("shared");
    auto rdpState = rdp_.state();
    s["state"] = !console ? "not_console_session"
        : !children || !allowed ? "setup_required"
        : rdpState == RdpSession::State::Connecting ? "signing_in"
        : !holder_.empty() ? (rdpState == RdpSession::State::SignedIn ? "held" : "unavailable")
        : shared_.laneIds().empty() ? "ready" : "shared";
    wchar_t edition[128] = {}; DWORD bytes = sizeof(edition);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
        L"EditionID", RRF_RT_REG_SZ, nullptr, edition, &bytes) == ERROR_SUCCESS) {
      s["edition"] = narrow(edition);
    }
    return s;
  }

  void refreshStatus() {
    Json next = buildStatus();
    Json lanes = Json::array();
    for (const auto& lane : shared_.laneIds()) lanes.push(lane);
    if (!holder_.empty()) lanes.push(holder_);
    std::lock_guard<std::mutex> lock(statusMutex_);
    cachedStatus_ = std::move(next);
    cachedLanes_ = std::move(lanes);
  }
  Json status() {
    std::lock_guard<std::mutex> lock(statusMutex_);
    Json result = Json::parse(cachedStatus_.dump());
    if (!result["holderLaneId"].str().empty() && (childDisconnected_ || rdp_.state() != RdpSession::State::SignedIn)) result["state"] = "unavailable";
    result["signInWaiting"] = signInWaiting_.load();
    const auto rdpState = rdp_.state();
    if (rdpState == RdpSession::State::Connecting || signInWaiting_) result["state"] = "signing_in";
    else if (result["state"].str() == "signing_in") {
      // The completion event can reach the reader before the worker refreshes
      // its snapshot. Never carry a completed prompt's cached waiting state.
      result["state"] = !result["holderLaneId"].str().empty()
          ? (rdpState == RdpSession::State::SignedIn ? "held" : "unavailable")
          : result["seatMode"].str() == "shared" ? "shared" : "ready";
    }
    const bool locked = consoleLocked();
    result["locked"] = locked;
    result["childSessionsEnabled"] = childSessionsEnabled();
    result["remoteDesktopAllowed"] = remoteDesktopAllowed();
    if (result["state"].str() != "not_console_session") {
      if (locked) result["state"] = "locked";
      else if (!result["childSessionsEnabled"].asBool() || !result["remoteDesktopAllowed"].asBool()) result["state"] = "setup_required";
    }
    return result;
  }
  Json ping() {
    Json result = Json::Object{{"version", kDriverVersion}, {"pid", GetCurrentProcessId()}, {"displayMode", "virtual"},
        {"permissions", Json::Object{{"screenRecording", "granted"}, {"accessibility", "granted"}}}, {"windowsDesktop", status()}};
    std::lock_guard<std::mutex> lock(statusMutex_);
    result["displays"] = cachedLanes_;
    return result;
  }
  void replyBusy(const Json& req) {
    output_.write(errorReply(req["id"].str(), {code::kDriverUnavailable, "Windows Desktop is busy; retry the request.", Json()}));
  }

  bool rejectSetupWhileBusy(const Json& req) {
    if (req["op"].str() != "windows.setup" || !executing_) return false;
    output_.write(errorReply(req["id"].str(), {code::kSignInFailed,
        signInWaiting_ ? "Finish or close the Windows sign-in window, then try setup again."
                       : "Windows Desktop is busy. Finish the current operation, then try setup again.", Json()}));
    return true;
  }
  void setSignInWaiting(bool waiting) {
    signInWaiting_ = waiting;
    output_.write(Json::Object{{"event", "windows-state-changed"}, {"signInWaiting", waiting}});
  }

  bool replyRead(const Json& req) {
    const auto op = req["op"].str();
    if (op == "windows.status" || op == "ping") { replyStatus(req); return true; }
    if (op == "watch-permissions" || op == "request-permission") {
      output_.write(okReply(req["id"].str(), Json::Object{{"permissions", Json::Object{{"screenRecording", "granted"}, {"accessibility", "granted"}}}}));
      return true;
    }
    if (op != "window.list" && op != "observe" && op != "capture.screenshot") return false;
    const auto lane = req["laneId"].str();
    bool sharedLane = false, hasShared = false;
    Json result = Json::Object{{"windows", Json::array()}};
    {
      std::lock_guard<std::mutex> lock(statusMutex_);
      const auto holder = cachedStatus_["holderLaneId"].str();
      if (privateActive_ && !holder.empty() && holder == lane) return false;
      for (const auto& id : cachedLanes_.items()) {
        if (id.str() == holder) continue;
        hasShared = true;
        if (id.str() == lane) sharedLane = true;
      }
      auto cached = cachedWindows_.find(lane);
      if (cached != cachedWindows_.end()) result = Json::parse(cached->second.dump());
    }
    if (op != "window.list") {
      if (sharedLane) return false;
      output_.write(errorReply(req["id"].str(), {code::kNoDisplay, "This lane has no Windows screen.", Json()}));
      return true;
    }
    // No seat is an empty list, not a poll queued behind a password dialog.
    if (!sharedLane && !(lane.empty() && hasShared)) result = Json::Object{{"windows", Json::array()}};
    else {
      try {
        Json fresh;
        if (shared_.tryListWindows(req, &fresh)) {
          result = std::move(fresh);
          std::lock_guard<std::mutex> lock(statusMutex_);
          cachedWindows_[lane] = Json::parse(result.dump());
        }
      } catch (const DriverError& error) { output_.write(errorReply(req["id"].str(), error)); return true; }
    }
    output_.write(okReply(req["id"].str(), result));
    return true;
  }

  void replyStatus(const Json& req) {
    output_.write(okReply(req["id"].str(), req["op"].str() == "ping" ? ping() : status()));
  }

  Json handle(const Json& req) {
    std::lock_guard<std::mutex> lock(requestMutex_);
    const auto op = requireString(req, "op");
    if (op == "windows.status") return status();
    if (op == "ping") return ping();
    if (op == "watch-permissions" || op == "request-permission") {
      return Json::Object{{"permissions", Json::Object{{"screenRecording", "granted"}, {"accessibility", "granted"}}}};
    }
    if (stopping_) fail(code::kCancelled, "The Windows screen host is stopping.");
    if (currentSessionId() != consoleSessionId()) fail(code::kNotConsoleSession, "The Windows screen host must run in the console session.");
    if (op == "windows.setup") {
      if (!req["allowPrompt"].asBool()) fail(code::kSetupRequired, "Open Windows Desktop setup on this PC.");
      if (req["savePassword"].asBool() && req["forgetPassword"].asBool()) fail(code::kInvalidArgument, "Choose Save or Forget, not both.");
      if (req["forgetPassword"].asBool()) {
        forgetCredential(credentialTarget(home_));
      } else {
        if (!childSessionsEnabled() || !remoteDesktopAllowed()) {
          if (req["savePassword"].asBool()) fail(code::kSetupRequired, "Set up private screens first, then save your Windows password.");
          setup();
        }
        if (req["savePassword"].asBool()) savePassword();
      }
      refreshStatus();
      return Json::Object{{"requiresAdmin", false}, {"status", status()}};
    }
    if (!Engine::serves(op)) fail(code::kUnknownOp, "Unknown Windows screen operation.");
    const auto lane = req["laneId"].str();
    if (op == "display.create") {
      requireString(req, "laneId");
      const auto mode = req["seatMode"].str("private");
      if (mode != "private" && mode != "shared") fail(code::kInvalidArgument, "seatMode must be private or shared.");
      if (shared_.hasLane(lane)) return shared_.handle(req);
      if (mode == "shared") {
        if (holder_ == lane) fail(code::kInvalidArgument, "Stop this lane's private screen before using the main desktop.");
        if (!req["sharedDesktopConsent"].asBool()) fail(code::kConsentRequired, "Using the main Windows desktop requires the user's consent.");
        ensureShared();
        return shared_.handle(req);
      }
      if (!holder_.empty() && holder_ != lane) {
        throw DriverError{code::kHeld, "Another lane holds the private Windows screen. Ask the user to take over or use the main desktop.",
                          Json::Object{{"holderLaneId", holder_}}};
      }
      if (holder_.empty()) startPrivate(req);
      return childRequest(req, 10'000);
    }
    if (op == "display.reconcile") {
      bool live = holder_.empty();
      for (auto& id : req["liveLaneIds"].items()) if (id.str() == holder_) live = true;
      if (!live) stopPrivate();
      if (sharedReady_) shared_.handle(req);
      return Json::object();
    }
    if (!lane.empty() && lane == holder_) {
      if (op == "display.destroy") {
        Json result;
        try { result = childRequest(req, 5'000); }
        catch (...) {
          // A dead child cannot answer, but successful session sign-out still
          // fulfils Stop and does not strand an artificial service display.
          result = Json::Object{{"destroyed", true}, {"releasedWindows", 0}, {"quitApps", Json::array()}, {"appsLeftOpen", Json::array()}};
        }
        stopPrivate();
        return result;
      }
      if (consoleLocked()) fail(code::kLocked, "This PC is locked. Unlock it to continue.");
      activeUntil_ = nowMs() + 120'000;
      auto result = childRequest(req);
      if (op == "record.start") recording_ = true;
      if (op == "record.stop") recording_ = false;
      return result;
    }
    if (!lane.empty() && !shared_.hasLane(lane)) fail(code::kNoDisplay, "This lane has no Windows screen.");
    // Unscoped listing never discloses the user's console windows until a
    // shared seat was explicitly created.
    if (!sharedReady_) return Json::Object{{"windows", Json::array()}};
    if (consoleLocked() && op != "display.destroy") fail(code::kLocked, "This PC is locked. Unlock it to continue.");
    return shared_.handle(req);
  }

  void reply(const Json& req) {
    const auto id = req["id"].str(), op = req["op"].str();
    const bool interactive = op == "windows.setup" || op == "display.create" || op == "display.destroy";
    // One budget includes the prompt, sign-in, IPC handshake and teardown.
    operationDeadline_ = interactive ? nowMs() + 120'000 : 0;
    hardDeadline_ = interactive ? operationDeadline_ + 15'000 : 0;
    std::mutex deadlineMutex;
    std::condition_variable finished;
    bool complete = false;
    std::thread watchdog;
    if (interactive) watchdog = std::thread([&, id, op] {
      std::unique_lock<std::mutex> lock(deadlineMutex);
      if (finished.wait_for(lock, std::chrono::milliseconds(120'000), [&] { return complete; })) return;
      logLine(op + ": operation deadline; cancelling owned UI");
      struct OwnedUi { DWORD pid; HWND host; } ownedUi{GetCurrentProcessId(), window_};
      EnumWindows([](HWND hwnd, LPARAM context) -> BOOL {
        const auto* owned = reinterpret_cast<OwnedUi*>(context);
        DWORD owner = 0; GetWindowThreadProcessId(hwnd, &owner);
        // Do not re-enter RdpSession::end from inside a hung COM call. The
        // worker performs normal teardown once the native dialog returns.
        if (owner == owned->pid && hwnd != owned->host) {
          PostMessageW(hwnd, WM_COMMAND, MAKEWPARAM(IDCANCEL, BN_CLICKED), 0);
          PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        return TRUE;
      }, reinterpret_cast<LPARAM>(&ownedUi));
      if (finished.wait_for(lock, std::chrono::milliseconds(15'000), [&] { return complete; })) return;
      // In-process COM/Windows RPC is not safely interruptible. If it ignores
      // cancellation, retire only this driver, after replying; the brain will
      // recreate it on the next request. Never leave executing_ stuck forever.
      logLine(op + ": hard deadline; retiring unresponsive native driver");
      if (op == "display.create") DeleteFileW(joinPath(joinPath(home_, L"windows-desktop"), L"child-launch.json").c_str());
      const DWORD child = cleanupSession_.load();
      if (child) {
        auto command = L"\"" + exePath() + L"\" cleanup-child --session " + std::to_wstring(child);
        STARTUPINFOW startup{sizeof(startup)}; PROCESS_INFORMATION process{};
        if (CreateProcessW(exePath().c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
          CloseHandle(process.hThread); CloseHandle(process.hProcess);
        }
      }
      setSignInWaiting(false);
      output_.write(errorReply(id, {code::kCancelled, "Windows Desktop timed out. Its native host was reset; try again.", Json()}));
      TerminateProcess(GetCurrentProcess(), 1);
    });
    executing_ = true;
    logLine(op + ": request begin");
    try { auto result = handle(req); refreshStatus(); output_.write(okReply(id, result)); logLine(op + ": request complete"); }
    catch (const DriverError& e) { logLine(op + ": failed code=" + e.code + " message=" + e.message); refreshStatus(); output_.write(errorReply(id, e)); }
    catch (const std::exception& e) { logLine(op + ": native exception=" + std::string(e.what())); refreshStatus(); output_.write(errorReply(id, {code::kInternalError, e.what(), Json()})); }
    executing_ = false;
    { std::lock_guard<std::mutex> lock(deadlineMutex); complete = true; }
    finished.notify_one();
    if (watchdog.joinable()) watchdog.join();
    operationDeadline_ = 0; hardDeadline_ = 0;
  }

  void stop() {
    std::lock_guard<std::mutex> lock(requestMutex_);
    try { stopPrivate(); }
    catch (const DriverError& e) { logLine(e.message); }
    catch (const std::exception& e) { logLine(e.what()); }
    shared_.shutdown();
  }
  void updateAwake() {
    // Must be called from the same console thread for both acquire/release.
    bool busy = privateActive_ && (executing_ || recording_ || activeUntil_.load() > nowMs());
    SetThreadExecutionState(ES_CONTINUOUS | (busy ? ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED : 0));
    const bool locked = consoleLocked();
    if (locked != lastLocked_) {
      lastLocked_ = locked;
      output_.write(eventLine("windows-state-changed", Json::Object{{"locked", locked}}));
    }
  }
  void cancel() { stopping_ = true; childReplyReady_.notify_all(); shared_.cancelRequests(); }

 private:
  void setup() {
    auto command = L"\"" + exePath() + L"\" setup-prompt";
    STARTUPINFOW startup = {sizeof(startup)};
    PROCESS_INFORMATION process = {};
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) fail(code::kSetupRequired, "Windows could not create a cancellable setup prompt.");
    struct Job { HANDLE value; ~Job() { CloseHandle(value); } } ownedJob{job};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
      fail(code::kSetupRequired, "Windows could not protect setup prompt cleanup.");
    if (!CreateProcessW(exePath().c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
        nullptr, nullptr, &startup, &process)) fail(code::kSetupRequired, "Windows could not open the setup prompt.");
    if (!AssignProcessToJobObject(job, process.hProcess)) {
      TerminateProcess(process.hProcess, 1); CloseHandle(process.hProcess); CloseHandle(process.hThread);
      fail(code::kSetupRequired, "Windows could not track its setup prompt.");
    }
    ResumeThread(process.hThread); CloseHandle(process.hThread);
    struct Process { HANDLE value; ~Process() { CloseHandle(value); } } owned{process.hProcess};
    logLine("setup: prompt opened pid=" + std::to_string(process.dwProcessId));
    auto deadline = operationDeadline_;
    while (!stopping_ && nowMs() < deadline) {
      DWORD wait = WaitForSingleObject(process.hProcess, 100);
      if (wait == WAIT_FAILED) fail(code::kSetupRequired, "Windows could not wait for setup.");
      if (wait == WAIT_OBJECT_0) {
        DWORD exit = 1; GetExitCodeProcess(process.hProcess, &exit);
        logLine("setup: prompt result=" + std::to_string(exit));
        if (exit == 2) fail(code::kCancelled, "Windows Desktop setup was cancelled.");
        if (exit != 0) fail(code::kSetupRequired, "Windows Desktop setup did not complete.");
        return;
      }
    }
    logLine("setup: deadline/cancellation; terminating owned prompt helper");
    TerminateProcess(process.hProcess, 1);
    WaitForSingleObject(process.hProcess, 1'000);
    fail(code::kCancelled, "Windows Desktop setup timed out or was cancelled. Close any remaining Windows prompt and try again.");
  }

  void savePassword() {
    if (holder_.empty() && childId_) stopPrivate();  // Retry cleanup of our own failed attempt.
    if (consoleLocked()) fail(code::kLocked, "Unlock this PC before saving the Windows password.");
    if (!holder_.empty() || childSessionId()) fail(code::kHeld, "Stop the private Windows screen before changing its saved password.");
    if (rdp_.state() == RdpSession::State::Connecting || signInWaiting_)
      fail(code::kSignInFailed, "Finish or close the Windows sign-in window before saving your password.");
    setSignInWaiting(true);
    struct Waiting { Host& host; ~Waiting() { host.setSignInWaiting(false); } } waiting{*this};
    auto credential = promptCredential(window_, stopping_, std::min<int64_t>(operationDeadline_, nowMs() + 90'000));
    setSignInWaiting(false);
    bool connected = false; std::string error;
    try {
      ui([&] { ShowWindow(window_, SW_HIDE); connected = rdp_.begin(window_, 1280, 800, &error, credential.get());
        if (connected) signInStarted_ = true; });
      refreshStatus();
      logLine("save: rdp begin result=" + std::to_string(connected));
      if (!connected) fail(code::kSignInFailed, error);
      auto deadline = std::min<int64_t>(operationDeadline_, nowMs() + 30'000);
      auto settled = rdp_.state();
      while (!stopping_ && settled == RdpSession::State::Connecting && nowMs() < deadline) {
        if (const DWORD partial = childSessionId()) cleanupSession_ = partial;
        settled = rdp_.waitSettled(100);
      }
      childId_ = childSessionId(); cleanupSession_ = childId_;
      logLine("save: sign-in outcome state=" + std::to_string(static_cast<int>(settled)) + " child=" + std::to_string(childId_) + " reason=" + std::to_string(rdp_.disconnectReason()) + " extended=" + std::to_string(rdp_.extendedDisconnectReason()));
      if (settled != RdpSession::State::SignedIn || !childId_) {
        if (rdp_.passwordRejected()) fail(code::kWrongPassword, "Windows rejected that password. Nothing was saved.");
        fail(code::kSignInFailed, "Windows could not verify the password. Nothing was saved.");
      }
      stopPrivate();
      saveCredential(credentialTarget(home_), *credential);
      logLine("save: password verified and saved (value omitted)");
    } catch (...) {
      setSignInWaiting(false);
      if (!childId_ && signInStarted_) childId_ = childSessionId();
      cleanupSession_ = childId_;
      stopPrivate();
      throw;
    }
  }

  void ensureShared() {
    if (sharedReady_) return;
    std::string error;
    if (!shared_.init(&error)) fail(code::kDriverUnavailable, error);
    sharedReady_ = true;
  }

  HANDLE makePipe(const std::wstring& name, DWORD access) {
    // Same-user ACL, local clients only, and no pre-existing pipe accepted.
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) fail(code::kDriverUnavailable, "Cannot read screen host identity.");
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<BYTE> user(size);
    bool ok = GetTokenInformation(token, TokenUser, user.data(), size, &size) != FALSE;
    CloseHandle(token);
    LPWSTR sid = nullptr;
    if (!ok || !ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid))
      fail(code::kDriverUnavailable, "Cannot secure screen host pipe.");
    std::wstring acl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
    LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
      fail(code::kDriverUnavailable, "Cannot secure screen host pipe.");
    SECURITY_ATTRIBUTES sa{sizeof(sa), descriptor, FALSE};
    HANDLE pipe = CreateNamedPipeW(name.c_str(), access | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &sa);
    LocalFree(descriptor);
    if (pipe == INVALID_HANDLE_VALUE) fail(code::kDriverUnavailable, "Cannot open private screen pipe.");
    return pipe;
  }

  void startPrivate(const Json& req) {
    if (holder_.empty() && childId_) stopPrivate();  // Never strand a retry behind our stale child.
    if (currentSessionId() != consoleSessionId()) fail(code::kNotConsoleSession, "The Windows screen host must run in the console session.");
    if (consoleLocked()) fail(code::kLocked, "This PC is locked. Unlock it to continue.");
    if (!childSessionsEnabled() || !remoteDesktopAllowed()) fail(code::kSetupRequired, "Open Windows Desktop setup on this PC first.");
    if (childSessionId()) fail(code::kHeld, "A private Windows session already exists. Stop it before starting an ADE screen.");
    GUID guid;
    if (FAILED(CoCreateGuid(&guid))) fail(code::kDriverUnavailable, "Cannot create screen connection identity.");
    wchar_t id[40];
    StringFromGUID2(guid, id, 40);
    auto base = L"\\\\.\\pipe\\ade-screen-" + std::wstring(id);
    auto dir = joinPath(home_, L"windows-desktop");
    if (!ensureDir(dir)) fail(code::kDriverUnavailable, "Cannot create Windows Desktop state directory.");
    launchFile_ = joinPath(dir, L"child-launch.json");
    const auto createDeadline = operationDeadline_;
    logLine("start: private session begin");
    try {
      toChild_ = makePipe(pipeToChild(base), PIPE_ACCESS_OUTBOUND);
      fromChild_ = makePipe(pipeFromChild(base), PIPE_ACCESS_INBOUND);
      Json args = Json::array(); args.push("child"); args.push("--pipe"); args.push(narrow(base));
      Json launch = Json::Object{{"driverPath", narrow(exePath())}, {"args", args},
          {"expiresAt", isoFromExpiry()}, {"hostPid", GetCurrentProcessId()}};
      std::ofstream file(launchFile_, std::ios::binary | std::ios::trunc);
      file << launch.dump(); file.close();
      if (!file) fail(code::kDriverUnavailable, "Cannot write private screen launch descriptor.");
      auto credential = readCredential(credentialTarget(home_));
      bool connected = false;
      std::string error;
      int width = static_cast<int>(std::clamp<int64_t>(req["width"].asInt(2560), 640, 3840));
      int height = static_cast<int>(std::clamp<int64_t>(req["height"].asInt(1440), 480, 2160));
      setSignInWaiting(!credential);
      ui([&] {
        SetWindowPos(window_, nullptr, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER);
        SetWindowTextW(window_, L"Sign in to your ADE private screen");
        ShowWindow(window_, credential ? SW_HIDE : SW_SHOWNORMAL);
        if (!credential) {
          const DWORD foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
          const DWORD ownThread = GetCurrentThreadId();
          const bool attached = foregroundThread && foregroundThread != ownThread &&
              AttachThreadInput(ownThread, foregroundThread, TRUE);
          BringWindowToTop(window_);
          SetForegroundWindow(window_);
          if (attached) AttachThreadInput(ownThread, foregroundThread, FALSE);
          FLASHWINFO flash{sizeof(flash), window_, FLASHW_TRAY, 3, 0}; FlashWindowEx(&flash);
        }
        connected = rdp_.begin(window_, width, height, &error, credential.get());
        if (connected) signInStarted_ = true;
      });
      setSignInWaiting(!credential && connected);
      refreshStatus();
      logLine("start: rdp begin result=" + std::to_string(connected));
      if (!connected) fail(code::kSignInFailed, error);
      auto settled = rdp_.state();
      auto deadline = std::min<int64_t>(createDeadline - 15'000, nowMs() + 90'000);
      while (!stopping_ && settled == RdpSession::State::Connecting && nowMs() < deadline) {
        if (const DWORD partial = childSessionId()) cleanupSession_ = partial;
        settled = rdp_.waitSettled(100);
      }
      setSignInWaiting(false);
      childId_ = childSessionId(); cleanupSession_ = childId_;
      logLine("start: sign-in outcome state=" + std::to_string(static_cast<int>(settled)) + " child=" + std::to_string(childId_) + " reason=" + std::to_string(rdp_.disconnectReason()) + " extended=" + std::to_string(rdp_.extendedDisconnectReason()));
      if (settled != RdpSession::State::SignedIn || !childId_) {
        if (credential && rdp_.passwordRejected()) {
          forgetCredential(credentialTarget(home_));
          fail(code::kWrongPassword, "Windows rejected the saved password. It was forgotten; save your current password in Windows Desktop.");
        }
        fail(code::kSignInFailed, "Windows sign-in did not complete. Try again from Windows Desktop.");
      }
      credential.reset();
      const auto pipeDeadline = std::min<int64_t>(createDeadline, nowMs() + 30'000);
      connectPipe(toChild_, pipeDeadline);
      connectPipe(fromChild_, pipeDeadline);
      ULONG pid = 0; DWORD session = 0;
      if (!GetNamedPipeClientProcessId(fromChild_, &pid) || !ProcessIdToSessionId(pid, &session) || session != childId_)
        fail(code::kDriverUnavailable, "The private screen pipe connected from the wrong session.");
      ULONG inputPid = 0;
      if (!GetNamedPipeClientProcessId(toChild_, &inputPid) || inputPid != pid)
        fail(code::kDriverUnavailable, "Private screen pipes connected from different processes.");
      childOutput_ = std::make_unique<LineWriter>(toChild_);
      std::string hello;
      if (!readChildLine(hello, std::max<int64_t>(0, std::min<int64_t>(10'000, createDeadline - nowMs()))) || Json::parse(hello)["event"].str() != "child-hello")
        fail(code::kDriverUnavailable, "The private screen driver did not answer.");
      holder_ = requireString(req, "laneId");
      holderName_ = req["name"].str();
      privateActive_ = true;
      startChildReader();
      DeleteFileW(launchFile_.c_str());
      ui([&] { ShowWindow(window_, SW_HIDE); });
    } catch (...) {
      setSignInWaiting(false);
      if (!childId_ && signInStarted_) childId_ = childSessionId();
      cleanupSession_ = childId_;
      stopPrivate();
      throw;
    }
  }

  std::string isoFromExpiry() {
    FILETIME now; GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER time; time.LowPart = now.dwLowDateTime; time.HighPart = now.dwHighDateTime;
    time.QuadPart += 180ULL * 10'000'000;
    FILETIME expiry{time.LowPart, time.HighPart};
    return isoFromFileTime(expiry);
  }

  void startChildReader() {
    childDisconnected_ = false;
    childReadRun_ = true;
    childReader_ = std::thread([this] {
      try {
      while (childReadRun_ && !stopping_) {
        std::string line; bool disconnected = false;
        if (!readChildLine(line, 250, &disconnected)) {
          if (!disconnected) continue;
          break;
        }
        try {
          auto reply = Json::parse(line);
          if (reply.has("event")) { output_.write(reply); continue; }
          std::lock_guard<std::mutex> lock(childReplyMutex_);
          auto pending = childReplies_.find(reply["id"].str());
          if (pending != childReplies_.end()) { pending->second = std::move(reply); childReplyReady_.notify_all(); }
        } catch (const std::exception&) { logLine("invalid private screen reply"); break; }
      }
      } catch (const DriverError& e) { logLine(e.message); }
      catch (const std::exception& e) { logLine(e.what()); }
      childDisconnected_ = true;
      childReplyReady_.notify_all();
    });
  }

  Json childRequest(const Json& req, int64_t timeout = 130'000) {
    if (operationDeadline_) timeout = std::max<int64_t>(0, std::min<int64_t>(timeout, operationDeadline_ - nowMs()));
    const auto id = requireString(req, "id");
    std::unique_lock<std::mutex> lock(childReplyMutex_);
    childReplies_[id] = std::nullopt;
    struct Pending { std::map<std::string, std::optional<Json>>& replies; std::string id; ~Pending() { replies.erase(id); } } pending{childReplies_, id};
    if (childDisconnected_ || !childOutput_ || !childOutput_->write(req)) fail(code::kDriverUnavailable, "The private screen disconnected.");
    bool answered = childReplyReady_.wait_for(lock, std::chrono::milliseconds(timeout), [&] {
      return stopping_ || childDisconnected_ || childReplies_[id].has_value();
    });
    if (!answered || !childReplies_[id]) fail(code::kDriverUnavailable, "The private screen disconnected or did not answer.");
    const Json reply = *childReplies_[id];
    if (!reply["ok"].asBool()) throw DriverError{reply["error"]["code"].str(code::kInternalError), reply["error"]["message"].str(), reply["error"]};
    return reply["result"];
  }

  void connectPipe(HANDLE pipe, int64_t deadline) {
    while (!stopping_ && nowMs() < deadline) {
      if (ConnectNamedPipe(pipe, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED) return;
      auto error = GetLastError();
      if (error != ERROR_PIPE_LISTENING && error != ERROR_NO_DATA) break;
      Sleep(25);
    }
    fail(code::kDriverUnavailable, "The private screen driver did not connect.");
  }

  bool readChildLine(std::string& line, int64_t timeout, bool* disconnected = nullptr) {
    auto deadline = nowMs() + timeout;
    while (!stopping_ && nowMs() < deadline) {
      auto newline = childBuffer_.find('\n');
      if (newline != std::string::npos) {
        line = childBuffer_.substr(0, newline); childBuffer_.erase(0, newline + 1); return true;
      }
      DWORD available = 0;
      if (!PeekNamedPipe(fromChild_, nullptr, 0, nullptr, &available, nullptr)) { if (disconnected) *disconnected = true; return false; }
      if (!available) { Sleep(10); continue; }
      char bytes[8192]; DWORD read = 0;
      if (!ReadFile(fromChild_, bytes, std::min<DWORD>(available, sizeof(bytes)), &read, nullptr)) { if (disconnected) *disconnected = true; return false; }
      childBuffer_.append(bytes, read);
      if (childBuffer_.size() > 8 * 1024 * 1024) fail(code::kProtocolError, "Private screen reply exceeded the wire limit.");
    }
    return false;
  }

  void stopPrivate() {
    logLine("teardown: begin child=" + std::to_string(childId_));
    if (!launchFile_.empty()) DeleteFileW(launchFile_.c_str());
    if (childOutput_) childOutput_->write(Json::Object{{"id", "shutdown"}, {"op", "child.quit"}});
    childReadRun_ = false;
    if (childReader_.joinable()) childReader_.join();
    childOutput_.reset(); childBuffer_.clear();
    if (toChild_ != INVALID_HANDLE_VALUE) { CloseHandle(toChild_); toChild_ = INVALID_HANDLE_VALUE; }
    if (fromChild_ != INVALID_HANDLE_VALUE) { CloseHandle(fromChild_); fromChild_ = INVALID_HANDLE_VALUE; }
    // Disconnect first so a still-connecting control cannot create a child
    // after the cleanup query. Windows logoff itself is asynchronous/bounded.
    ui([&] { rdp_.end(); ShowWindow(window_, SW_HIDE); });
    if (!childId_ && signInStarted_) childId_ = childSessionId();
    cleanupSession_ = childId_;
    const auto deadline = hardDeadline_ ? std::min<int64_t>(hardDeadline_, nowMs() + 10'000) : nowMs() + 10'000;
    const bool signedOut = !childId_ || signOutSession(childId_, deadline);
    if (!signedOut) {
      privateActive_ = false; recording_ = false;
      fail(code::kDriverUnavailable, "Windows could not sign out the private screen. Its session is retained; retry Stop before starting another screen.");
    }
    signInStarted_ = false;
    childId_ = 0; cleanupSession_ = 0; holder_.clear(); holderName_.clear(); activeUntil_ = 0; privateActive_ = false; recording_ = false;
    logLine("teardown: complete");
  }

  HWND window_;
  std::wstring home_, launchFile_;
  LineWriter output_;
  Engine shared_;
  bool sharedReady_ = false;
  std::mutex requestMutex_, statusMutex_;
  Json cachedStatus_, cachedLanes_;
  std::map<std::string, Json> cachedWindows_;
  int64_t operationDeadline_ = 0, hardDeadline_ = 0;
  std::atomic<DWORD> cleanupSession_{0};
  RdpSession rdp_;
  std::string holder_, holderName_;
  // A global Windows child session is not ours unless our RDP begin succeeded.
  bool signInStarted_ = false;
  DWORD childId_ = 0;
  HANDLE toChild_ = INVALID_HANDLE_VALUE, fromChild_ = INVALID_HANDLE_VALUE;
  std::unique_ptr<LineWriter> childOutput_;
  std::string childBuffer_;
  std::thread childReader_;
  std::atomic<bool> childReadRun_{false}, childDisconnected_{false};
  std::mutex childReplyMutex_;
  std::condition_variable childReplyReady_;
  std::map<std::string, std::optional<Json>> childReplies_;
  std::atomic<int64_t> activeUntil_{0};
  std::atomic<bool> stopping_{false}, signInWaiting_{false};
  std::atomic<bool> executing_{false}, recording_{false}, privateActive_{false};
  bool lastLocked_ = false;
};
}  // namespace

int runHost(const std::wstring& home) {
  uint64_t homeHash = 14695981039346656037ULL;
  for (wchar_t c : lower(home)) { homeHash ^= static_cast<uint64_t>(c); homeHash *= 1099511628211ULL; }
  const auto mutexName = L"Local\\ade-screen-host-" + std::to_wstring(homeHash);
  HANDLE mutex = CreateMutexW(nullptr, TRUE, mutexName.c_str());
  if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (mutex) CloseHandle(mutex);
    logLine("another screen host already owns this ADE home, or the host lock could not be created");
    return 2;
  }
  struct HostLock { HANDLE handle; ~HostLock() { ReleaseMutex(handle); CloseHandle(handle); } } hostLock{mutex};
  if (FAILED(OleInitialize(nullptr))) return 3;
  WNDCLASSW wc = {}; wc.lpfnWndProc = hostProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"ADEWindowsScreenHost";
  RegisterClassW(&wc);
  HWND window = CreateWindowExW(WS_EX_APPWINDOW, wc.lpszClassName, L"ADE private Windows screen — sign in",
      WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800, nullptr, nullptr, wc.hInstance, nullptr);
  if (!window) { OleUninitialize(); return 4; }
  Host host(window, home);
  std::atomic<bool> done{false};
  std::mutex queueMutex;
  std::condition_variable queued;
  std::deque<Json> requests;
  bool inputClosed = false;
  std::thread reader([&] {
    LineReader input(GetStdHandle(STD_INPUT_HANDLE));
    std::string line;
    while (input.next(line)) {
      try {
        auto req = Json::parse(line);
        if (req["type"].str() == "quit") break;
        if (!req["id"].str().empty()) {
          if (host.replyRead(req)) continue;
          if (host.rejectSetupWhileBusy(req)) continue;
          std::lock_guard<std::mutex> lock(queueMutex);
          if (requests.size() >= 128) { host.replyBusy(req); continue; }
          requests.push_back(req); queued.notify_one();
        }
      } catch (const std::exception&) { logLine("invalid screen host request"); }
    }
    host.cancel();
    { std::lock_guard<std::mutex> lock(queueMutex); inputClosed = true; }
    queued.notify_one();
  });
  std::thread worker([&] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    while (true) {
      Json req;
      {
        std::unique_lock<std::mutex> lock(queueMutex);
        queued.wait(lock, [&] { return inputClosed || !requests.empty(); });
        // Every request that arrived before stdin closed is owed a reply;
        // `cancel()` already made long waits give up, so draining is quick.
        if (requests.empty()) break;
        req = requests.front(); requests.pop_front();
      }
      host.reply(req);
    }
    host.stop(); CoUninitialize(); done = true;
    PostMessageW(window, WM_NULL, 0, 0);
  });
  while (!done) {
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 250, QS_ALLINPUT);
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg); DispatchMessageW(&msg);
    }
    host.updateAwake();
  }
  reader.join();
  worker.join();
  SetThreadExecutionState(ES_CONTINUOUS);
  DestroyWindow(window);
  OleUninitialize();
  return 0;
}
}  // namespace ade
