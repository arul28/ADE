// The session engine: every per-lane op of the driver wire, for one session.
//
// Two modes, one op table:
//
// * Private (Mode A). The engine runs inside the Remote Desktop child session
//   and that whole desktop is the one holder lane's screen. Every app window
//   in the session belongs to the lane. Real input needs no lease: nobody
//   else uses this desktop.
// * Shared (Mode B). The engine runs in the user's console session. Each lane
//   gets an area to the right of every monitor; the lane's windows are parked
//   there and captured with PrintWindow. Actions are quiet first (UI
//   Automation, posted messages); keys that need the foreground borrow it and
//   hand the user's window back. Real input needs the lease, as on macOS.

#pragma once

#include "capture.h"
#include "common.h"
#include "desk.h"
#include "uia.h"
#include "video.h"

#include <condition_variable>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace ade {

using EventSink = std::function<void(const Json&)>;

class Engine {
 public:
  enum class Mode { Private, Shared };

  Engine(Mode mode, EventSink emit);
  ~Engine();
  bool init(std::string* error);
  void shutdown();
  void cancelRequests() { running_ = false; }

  // Handles one request. Throws DriverError. `op` is already known to be one
  // this engine serves (see `serves`).
  Json handle(const Json& req);
  static bool serves(const std::string& op);

  bool hasLane(const std::string& laneId);
  std::vector<std::string> laneIds();
  // Any lane acted on within `withinMs`, or is streaming to a reader, or is
  // recording. The host's keep-awake reads this.
  bool busy(int64_t withinMs);
  int64_t lastActionMs() const { return lastActionMs_.load(); }

  // Private mode: pids ADE launched in this session (the startup cleanup
  // must never close them), and the first launch time.
  std::set<DWORD> launchedPidTrees();
  int64_t firstLaunchMs() const { return firstLaunchMs_.load(); }
  // Wall clock of the first launch, zero before it.
  FILETIME firstLaunchTime() {
    std::lock_guard<std::mutex> lock(mutex_);
    return firstLaunchTime_;
  }

 private:
  struct Lane;

  // Ops.
  Json createDisplay(const Json& req);
  Json destroyDisplay(const Json& req);
  Json reconcile(const Json& req);
  Json listWindowsOp(const Json& req);
  Json park(const Json& req);
  Json unpark(const Json& req);
  Json launch(const Json& req);
  Json quitApp(const Json& req);
  Json present(const Json& req);
  Json observe(const Json& req);
  Json input(const Json& req);
  Json setLease(const Json& req);
  Json clearLease(const Json& req);
  Json screenshot(const Json& req);
  Json startStream(const Json& req);
  Json setStreamRate(const Json& req);
  Json setStreamCursor(const Json& req);
  Json stopStream(const Json& req);
  Json startRecording(const Json& req);
  Json stopRecording(const Json& req);

  // Input halves.
  Json accessibilityInput(Lane& lane, const std::string& command, const Json& payload);
  Json realInput(Lane& lane, const std::string& command, const Json& payload, const Json& req);
  Json waitFor(const std::string& laneId, const Json& payload);
  UiaElement resolveTarget(const std::string& laneId, const Json& payload);
  static bool hasTarget(const Json& payload);

  // Lanes and windows.
  std::shared_ptr<Lane> requireLane(const std::string& laneId);
  std::vector<WinInfo> laneWindows(Lane& lane);
  Json windowJson(const WinInfo& w, const Lane* lane);
  Json displayJson(Lane& lane);
  void parkWindow(Lane& lane, HWND hwnd, const char* origin);
  void releaseWindow(Lane& lane, HWND hwnd);
  bool captureLane(Lane& lane, Frame& frame, HWND onlyWindow, std::string* error);
  void touch(Lane& lane);
  std::set<DWORD> ownedProcesses(Lane& lane, DWORD watchedRoot = 0);
  std::map<DWORD, FILETIME> ownedProcessIdentities(Lane& lane, DWORD watchedRoot = 0);
  void rememberProcess(Lane& lane, DWORD pid, DWORD watchedRoot = 0);

  // Media.
  void mediaLoop(std::shared_ptr<Lane> lane);
  void ensureMediaThread(const std::shared_ptr<Lane>& lane);
  void stopMedia(Lane& lane);

  // Background watchers.
  void watchLoop();

  Mode mode_;
  EventSink emit_;
  Uia uia_;
  std::mutex mutex_;
  std::recursive_mutex operationMutex_;
  std::map<std::string, std::shared_ptr<Lane>> lanes_;
  std::atomic<int64_t> lastActionMs_{0};
  std::atomic<int64_t> firstLaunchMs_{0};
  FILETIME firstLaunchTime_ = {};
  std::atomic<bool> running_{true};
  std::atomic<bool> shutdownStarted_{false};
  std::thread watcher_;
  int nextSlot_ = 0;
};

// Serializes a window for the wire.
Json windowToJson(const WinInfo& w, const std::string& laneId, const std::string& origin, int64_t displayId);

inline int64_t windowIdOf(HWND hwnd) { return static_cast<int64_t>(reinterpret_cast<uintptr_t>(hwnd) & 0xFFFFFFFF); }
inline HWND hwndFromId(int64_t id) { return reinterpret_cast<HWND>(static_cast<uintptr_t>(static_cast<uint32_t>(id))); }

}  // namespace ade
