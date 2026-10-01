#include "engine.h"

#include <algorithm>
#include <cstdio>

namespace ade {

namespace {

constexpr int kShareGap = 200;       // px between the last monitor and a lane area
constexpr int64_t kLaunchWatchMs = 20'000;
constexpr int64_t kIdleCutAfterMs = 1'500;

struct LaunchWatch {
  DWORD pid = 0;
  int64_t sinceMs = 0;
  FILETIME since = {};
  std::set<HWND> before;
};

const std::set<std::string>& engineOps() {
  static const std::set<std::string> ops = {
      "display.create", "display.destroy", "display.reconcile", "window.list",   "window.park",
      "window.unpark",  "app.launch",      "app.quit",          "present",       "observe",
      "input",          "lease.set",       "lease.clear",       "capture.screenshot", "stream.start",
      "stream.setRate", "stream.setCursorVisible", "stream.stop", "record.start", "record.stop",
  };
  return ops;
}

RECT virtualScreen() {
  RECT r;
  r.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  r.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  r.right = r.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  r.bottom = r.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  return r;
}

Json frameJson(const RECT& r) {
  Json f = Json::object();
  f["x"] = static_cast<int>(r.left);
  f["y"] = static_cast<int>(r.top);
  f["width"] = static_cast<int>(r.right - r.left);
  f["height"] = static_cast<int>(r.bottom - r.top);
  return f;
}

bool pointFrom(const Json& payload, const char* key, POINT& out) {
  const Json& p = payload[key];
  if (p.isObject() && p["x"].isNumber() && p["y"].isNumber()) {
    out.x = static_cast<LONG>(p["x"].asDouble());
    out.y = static_cast<LONG>(p["y"].asDouble());
    return true;
  }
  if (payload["x"].isNumber() && payload["y"].isNumber()) {
    out.x = static_cast<LONG>(payload["x"].asDouble());
    out.y = static_cast<LONG>(payload["y"].asDouble());
    return true;
  }
  return false;
}

std::vector<std::string> stringList(const Json& value) {
  std::vector<std::string> out;
  for (const auto& v : value.items()) {
    if (v.isString() && !v.asString().empty()) out.push_back(v.asString());
  }
  return out;
}

POINT centerOf(const RECT& r) { return POINT{(r.left + r.right) / 2, (r.top + r.bottom) / 2}; }

bool inRect(const RECT& r, POINT p) { return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }

[[noreturn]] void failLocked() {
  fail(code::kLocked, "This PC is locked, so the private screen cannot take input. The agent waits until it is unlocked.");
}

}  // namespace

struct Engine::Lane {
  std::string laneId;
  std::string name;
  RECT area = {};
  int width = 0;
  int height = 0;
  int64_t displayId = 0;
  std::string createdAt;
  std::string lastActivityAt;
  int64_t lastActivityMs = 0;
  int slot = 0;
  // Shared mode: the windows parked here, what put them here, and where each
  // one came from so a release puts it back.
  std::map<HWND, std::string> origin;
  std::map<HWND, RECT> home;
  // Apps this lane launched (root pids) and the late-window watches.
  std::set<DWORD> launchedRoots;
  std::map<DWORD, FILETIME> launchedTimes;
  std::vector<LaunchWatch> watches;
  // Lease (shared mode real input).
  std::string leaseHolder;
  int64_t leaseExpiresMs = 0;
  // Media.
  std::mutex media;
  std::unique_ptr<StreamByteServer> server;
  std::unique_ptr<H264Encoder> encoder;
  bool streaming = false;
  int streamFps = 30;
  bool cursorVisible = false;
  std::string codec;
  std::atomic<bool> wantKeyframe{false};
  std::unique_ptr<Mp4Recorder> recorder;
  std::wstring recordPath;
  int recordFps = 30;
  bool keepIdle = false;
  HWND recordWindow = nullptr;
  int64_t recordStartMs = 0;
  int64_t recordIdleCutMs = 0;
  int64_t recordLastChangeMs = 0;
  int64_t recordMediaMs = 0;  // media time written so far
  int64_t recordLastWallMs = 0;
  uint64_t recordLastHash = 0;
  std::string recordError;
  std::thread mediaThread;
  std::atomic<bool> mediaRun{false};
  int64_t lastStreamErrorMs = 0;
  std::string windowsSignature;
};

Engine::Engine(Mode mode, EventSink emit) : mode_(mode), emit_(std::move(emit)) {}

Engine::~Engine() { shutdown(); }

bool Engine::init(std::string* error) {
  if (!uia_.init(error)) return false;
  watcher_ = std::thread([this] { watchLoop(); });
  return true;
}

void Engine::shutdown() {
  if (shutdownStarted_.exchange(true)) return;
  running_ = false;
  if (watcher_.joinable()) watcher_.join();
  std::vector<std::shared_ptr<Lane>> lanes;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : lanes_) lanes.push_back(kv.second);
  }
  for (auto& lane : lanes) {
    try {
      Json stop = Json::Object{{"op", "display.destroy"}, {"laneId", lane->laneId}};
      destroyDisplay(stop);
    } catch (...) {
      // Always finish media teardown even if an app refuses to close.
      stopMedia(*lane);
      logLine("screen shutdown could not finish a lane's app cleanup");
    }
  }
}

bool Engine::serves(const std::string& op) { return engineOps().count(op) > 0; }

bool Engine::hasLane(const std::string& laneId) {
  std::lock_guard<std::mutex> lock(mutex_);
  return lanes_.count(laneId) > 0;
}

std::vector<std::string> Engine::laneIds() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> out;
  for (auto& kv : lanes_) out.push_back(kv.first);
  return out;
}

bool Engine::busy(int64_t withinMs) {
  if (nowMs() - lastActionMs_.load() < withinMs) return true;
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto& kv : lanes_) {
    std::lock_guard<std::mutex> media(kv.second->media);
    if (kv.second->recorder) return true;
    if (kv.second->streaming && kv.second->server && kv.second->server->clientCount() > 0) return true;
  }
  return false;
}

std::set<DWORD> Engine::launchedPidTrees() {
  std::lock_guard<std::recursive_mutex> operation(operationMutex_);
  std::set<DWORD> roots;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : lanes_) {
      auto owned = ownedProcesses(*kv.second);
      roots.insert(owned.begin(), owned.end());
    }
  }
  return roots;
}

void Engine::rememberProcess(Lane& lane, DWORD pid) {
  FILETIME created = processCreationTime(pid);
  if (!pid || (!created.dwLowDateTime && !created.dwHighDateTime)) return;
  lane.launchedRoots.insert(pid);
  lane.launchedTimes[pid] = created;
}

std::set<DWORD> Engine::ownedProcesses(Lane& lane) {
  std::set<DWORD> result;
  for (auto& tracked : lane.launchedTimes) {
    FILETIME current = processCreationTime(tracked.first);
    if (CompareFileTime(&current, &tracked.second) != 0) continue;
    auto tree = processTree(tracked.first);
    result.insert(tree.begin(), tree.end());
  }
  return result;
}

std::shared_ptr<Engine::Lane> Engine::requireLane(const std::string& laneId) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = lanes_.find(laneId);
  if (it == lanes_.end()) {
    fail(code::kNoDisplay, "Lane " + laneId + " has no Windows screen. Start one first.");
  }
  return it->second;
}

void Engine::touch(Lane& lane) {
  lane.lastActivityMs = nowMs();
  lane.lastActivityAt = isoNow();
  lastActionMs_ = lane.lastActivityMs;
}

Json windowToJson(const WinInfo& w, const std::string& laneId, const std::string& origin, int64_t displayId) {
  Json j = Json::object();
  j["id"] = windowIdOf(w.hwnd);
  j["pid"] = static_cast<int64_t>(w.pid);
  j["appName"] = narrow(w.appName.empty() ? w.exeName : w.appName);
  j["bundleId"] = w.exeName.empty() ? Json() : Json(narrow(w.exeName));
  j["title"] = w.title.empty() ? Json() : Json(narrow(w.title));
  j["frame"] = frameJson(w.frame);
  j["laneId"] = laneId.empty() ? Json() : Json(laneId);
  j["origin"] = origin.empty() ? "claimed" : origin;
  j["onDisplayId"] = laneId.empty() ? Json() : Json(displayId);
  j["minimized"] = w.minimized;
  j["singleInstance"] = false;
  j["iconPng"] = Json();
  return j;
}

Json Engine::windowJson(const WinInfo& w, const Lane* lane) {
  if (!lane) return windowToJson(w, "", "", 0);
  std::string origin = "ade_launched";
  if (mode_ == Mode::Shared) {
    auto it = lane->origin.find(w.hwnd);
    origin = it == lane->origin.end() ? "claimed" : it->second;
  }
  return windowToJson(w, lane->laneId, origin, lane->displayId);
}

std::vector<WinInfo> Engine::laneWindows(Lane& lane) {
  std::vector<WinInfo> all = listAppWindows();
  if (mode_ == Mode::Private) return all;
  std::vector<WinInfo> out;
  for (auto& w : all) {
    if (lane.origin.count(w.hwnd)) out.push_back(w);
  }
  // Owned dialogs of parked windows follow their owner.
  for (auto& w : all) {
    if (lane.origin.count(w.hwnd)) continue;
    HWND owner = GetWindow(w.hwnd, GW_OWNER);
    if (owner && lane.origin.count(owner)) out.push_back(w);
  }
  return out;
}

Json Engine::displayJson(Lane& lane) {
  Json d = Json::object();
  d["laneId"] = lane.laneId;
  d["displayId"] = lane.displayId;
  d["name"] = lane.name;
  d["mode"] = mode_ == Mode::Private ? "virtual" : "offscreen-region";
  d["width"] = lane.width;
  d["height"] = lane.height;
  d["scale"] = 1;
  Json origin = Json::object();
  origin["x"] = static_cast<int>(lane.area.left);
  origin["y"] = static_cast<int>(lane.area.top);
  d["origin"] = origin;
  d["createdAt"] = lane.createdAt;
  d["windowCount"] = static_cast<int64_t>(laneWindows(lane).size());
  d["lastActivityAt"] = lane.lastActivityAt;
  return d;
}

Json Engine::handle(const Json& req) {
  std::unique_lock<std::recursive_mutex> operation(operationMutex_);
  if (!running_) fail(code::kCancelled, "The Windows screen is stopping.");
  const std::string op = req["op"].str();
  if (op == "display.create") return createDisplay(req);
  if (op == "display.destroy") return destroyDisplay(req);
  if (op == "display.reconcile") return reconcile(req);
  if (op == "window.list") return listWindowsOp(req);
  if (op == "window.park") return park(req);
  if (op == "window.unpark") return unpark(req);
  if (op == "app.launch") return launch(req);
  if (op == "app.quit") return quitApp(req);
  if (op == "present") return present(req);
  if (op == "observe") return observe(req);
  if (op == "input" && req["command"].str() == "wait") {
    operation.unlock();
    return waitFor(requireString(req, "laneId"), req["payload"]);
  }
  if (op == "input") return input(req);
  if (op == "lease.set") return setLease(req);
  if (op == "lease.clear") return clearLease(req);
  if (op == "capture.screenshot") return screenshot(req);
  if (op == "stream.start") return startStream(req);
  if (op == "stream.setRate") return setStreamRate(req);
  if (op == "stream.setCursorVisible") return setStreamCursor(req);
  if (op == "stream.stop") return stopStream(req);
  if (op == "record.start") return startRecording(req);
  if (op == "record.stop") return stopRecording(req);
  fail(code::kUnknownOp, "This ade-desktop-driver build does not implement \"" + op + "\".");
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

Json Engine::createDisplay(const Json& req) {
  const std::string laneId = requireString(req, "laneId");
  std::shared_ptr<Lane> lane;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = lanes_.find(laneId);
    if (it != lanes_.end()) {
      lane = it->second;
    } else {
      if (mode_ == Mode::Private && !lanes_.empty()) {
        // One holder per private screen; the host enforces this first, so
        // reaching here means the host changed holder without a fresh sign-in.
        fail(code::kHeld, "The private Windows screen already has a holder lane.");
      }
      lane = std::make_shared<Lane>();
      lane->laneId = laneId;
      lane->name = req["name"].str("ADE lane");
      lane->createdAt = isoNow();
      if (mode_ == Mode::Private) {
        lane->area = virtualScreen();
        lane->displayId = static_cast<int64_t>(currentSessionId());
      } else {
        lane->slot = nextSlot_++;
        RECT vs = virtualScreen();
        int w = static_cast<int>(std::max<int64_t>(640, std::min<int64_t>(3840, req["width"].asInt(1920))));
        int h = static_cast<int>(std::max<int64_t>(480, std::min<int64_t>(2160, req["height"].asInt(1080))));
        // Lane areas sit right of every monitor, one after another. Nothing
        // is ever drawn there, so a window parked there is off every screen.
        lane->area.left = vs.right + kShareGap + lane->slot * (w + kShareGap);
        lane->area.top = vs.top;
        lane->area.right = lane->area.left + w;
        lane->area.bottom = lane->area.top + h;
        lane->displayId = 0;
      }
      lane->width = lane->area.right - lane->area.left;
      lane->height = lane->area.bottom - lane->area.top;
      lanes_[laneId] = lane;
    }
  }
  touch(*lane);
  Json display = displayJson(*lane);
  emit_(eventLine("display-created", Json::Object{{"laneId", laneId}, {"display", display}}));
  return display;
}

Json Engine::destroyDisplay(const Json& req) {
  const std::string laneId = requireString(req, "laneId");
  std::shared_ptr<Lane> lane;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = lanes_.find(laneId);
    if (it == lanes_.end()) {
      Json r = Json::object();
      r["destroyed"] = false;
      r["releasedWindows"] = 0;
      r["quitApps"] = Json::array();
      r["appsLeftOpen"] = Json::array();
      return r;
    }
    lane = it->second;
  }
  stopMedia(*lane);
  Json quit = Json::array();
  Json leftOpen = Json::array();
  int released = 0;
  if (mode_ == Mode::Shared) {
    // Quit what the lane opened, then give claimed windows back.
    std::set<DWORD> tree = ownedProcesses(*lane);
    for (auto& w : laneWindows(*lane)) {
      if (tree.count(w.pid)) {
        FILETIME created = processCreationTime(w.pid);
        if (!closeWindowGracefully(w.hwnd, 3000) && !terminatePid(w.pid, created)) {
          Json app = Json::object();
          app["pid"] = static_cast<int64_t>(w.pid);
          app["appName"] = narrow(w.appName);
          app["message"] = narrow(w.appName) + " did not quit. It moved to your screen.";
          leftOpen.push(app);
          releaseWindow(*lane, w.hwnd);
        } else {
          Json q = Json::object();
          q["pid"] = static_cast<int64_t>(w.pid);
          q["appName"] = narrow(w.appName);
          q["bundleId"] = narrow(w.exeName);
          q["released"] = false;
          quit.push(q);
        }
      } else {
        releaseWindow(*lane, w.hwnd);
        ++released;
      }
    }
  }
  uia_.forgetLane(laneId);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    lanes_.erase(laneId);
  }
  Json r = Json::object();
  r["destroyed"] = true;
  r["releasedWindows"] = released;
  r["quitApps"] = quit;
  r["appsLeftOpen"] = leftOpen;
  emit_(eventLine("display-destroyed", Json::Object{{"laneId", laneId}, {"reason", req["reason"].str("stopped")}}));
  return r;
}

Json Engine::reconcile(const Json& req) {
  std::set<std::string> live;
  for (const auto& v : req["liveLaneIds"].items()) live.insert(v.str());
  Json destroyed = Json::array();
  for (const auto& id : laneIds()) {
    if (live.count(id)) continue;
    Json r = Json::object();
    r["op"] = "display.destroy";
    r["laneId"] = id;
    r["reason"] = "reconciled";
    destroyDisplay(r);
    destroyed.push(id);
  }
  Json out = Json::object();
  out["destroyed"] = destroyed;
  return out;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

void Engine::parkWindow(Lane& lane, HWND hwnd, const char* origin) {
  if (mode_ == Mode::Private) return;
  if (!lane.origin.count(hwnd)) {
    RECT r;
    GetWindowRect(hwnd, &r);
    lane.home[hwnd] = r;
  }
  lane.origin[hwnd] = origin;
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  RECT r;
  GetWindowRect(hwnd, &r);
  int w = std::min<int>(r.right - r.left, lane.width);
  int h = std::min<int>(r.bottom - r.top, lane.height);
  int offset = 24 * static_cast<int>((lane.origin.size() - 1) % 8);
  SetWindowPos(hwnd, nullptr, lane.area.left + offset, lane.area.top + offset, w, h,
               SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
}

void Engine::releaseWindow(Lane& lane, HWND hwnd) {
  auto home = lane.home.find(hwnd);
  if (IsWindow(hwnd)) {
    RECT target;
    if (home != lane.home.end() && home->second.left < virtualScreen().right) {
      target = home->second;
    } else {
      // A window that started off-screen (a lane launch) comes back to the
      // primary monitor's work area.
      RECT work;
      SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
      RECT cur;
      GetWindowRect(hwnd, &cur);
      target = {work.left + 80, work.top + 80, work.left + 80 + (cur.right - cur.left),
                work.top + 80 + (cur.bottom - cur.top)};
    }
    SetWindowPos(hwnd, nullptr, target.left, target.top, target.right - target.left, target.bottom - target.top,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  }
  lane.origin.erase(hwnd);
  lane.home.erase(hwnd);
}

Json Engine::listWindowsOp(const Json& req) {
  const std::string laneId = req["laneId"].str();
  Json windows = Json::array();
  if (!laneId.empty()) {
    auto lane = requireLane(laneId);
    for (auto& w : laneWindows(*lane)) windows.push(windowJson(w, lane.get()));
  } else {
    // Every window of this session, each tagged with the lane that holds it.
    std::vector<std::shared_ptr<Lane>> lanes;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto& kv : lanes_) lanes.push_back(kv.second);
    }
    for (auto& w : listAppWindows()) {
      const Lane* holder = nullptr;
      for (auto& l : lanes) {
        if (mode_ == Mode::Private || l->origin.count(w.hwnd)) holder = l.get();
      }
      windows.push(windowJson(w, holder));
    }
  }
  Json out = Json::object();
  out["windows"] = windows;
  return out;
}

Json Engine::park(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  HWND hwnd = hwndFromId(requireInt(req, "windowId"));
  WinInfo w;
  if (!describeWindow(hwnd, w) || !isAppWindow(hwnd)) {
    fail(code::kWindowNotFound, "Window " + std::to_string(windowIdOf(hwnd)) + " is not open.");
  }
  if (mode_ == Mode::Shared) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : lanes_) {
      if (kv.first != lane->laneId && kv.second->origin.count(hwnd)) {
        fail(code::kAppOwnedByOtherLane, "Lane " + kv.first + " holds that window.");
      }
    }
  }
  parkWindow(*lane, hwnd, "claimed");
  touch(*lane);
  describeWindow(hwnd, w);
  Json out = windowJson(w, lane.get());
  Json wrapped = Json::object();
  wrapped["window"] = out;
  return wrapped;
}

Json Engine::unpark(const Json& req) {
  HWND hwnd = hwndFromId(requireInt(req, "windowId"));
  const std::string laneId = req["laneId"].str();
  if (mode_ == Mode::Private) {
    fail(code::kInvalidArgument, "Windows on the private screen stay on it. Quit the app instead.");
  }
  std::shared_ptr<Lane> lane;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : lanes_) {
      if (kv.second->origin.count(hwnd)) lane = kv.second;
    }
  }
  Json out = Json::object();
  Json ids = Json::array();
  if (!lane) {
    out["releasedWindowIds"] = ids;
    out["handedOverPid"] = Json();
    return out;
  }
  if (!laneId.empty() && lane->laneId != laneId) {
    fail(code::kAppOwnedByOtherLane, "Lane " + lane->laneId + " holds that window.");
  }
  WinInfo w;
  describeWindow(hwnd, w);
  releaseWindow(*lane, hwnd);
  ids.push(windowIdOf(hwnd));
  out["window"] = windowToJson(w, "", "", 0);
  out["releasedWindowIds"] = ids;
  out["handedOverPid"] = Json();
  return out;
}

Json Engine::launch(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::wstring target = widen(requireString(req, "target"));
  std::vector<std::wstring> args;
  for (const auto& a : stringList(req["args"])) args.push_back(widen(a));
  std::set<HWND> before;
  for (auto& w : listAppWindows()) before.insert(w.hwnd);
  FILETIME since;
  GetSystemTimeAsFileTime(&since);
  HWND userForeground = currentForeground();
  int64_t startMs = nowMs();
  if (firstLaunchMs_.load() == 0) {
    std::lock_guard<std::mutex> lock(mutex_);
    firstLaunchMs_ = startMs;
    firstLaunchTime_ = since;
  }
  LaunchResult launched = launchTarget(target, args);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    FILETIME created = processCreationTime(launched.pid);
    if (launched.pid && CompareFileTime(&created, &since) >= 0) rememberProcess(*lane, launched.pid);
    LaunchWatch watch;
    watch.pid = launched.pid;
    watch.sinceMs = startMs;
    watch.since = since;
    watch.before = before;
    lane->watches.push_back(watch);
  }
  touch(*lane);
  // Wait briefly for the first window, so the reply can name it.
  std::vector<WinInfo> fresh;
  for (int i = 0; i < 40 && fresh.empty(); ++i) {
    Sleep(125);
    std::set<DWORD> tree = ownedProcesses(*lane);
    for (auto& w : listAppWindows()) {
      if (before.count(w.hwnd)) continue;
      bool ours = tree.count(w.pid) > 0;
      if (ours) fresh.push_back(w);
    }
  }
  if (mode_ == Mode::Shared) {
    for (auto& w : fresh) {
      parkWindow(*lane, w.hwnd, "ade_launched");
      rememberProcess(*lane, w.pid);
    }
    // Launching takes the foreground on Windows. Give it back.
    if (userForeground && currentForeground() != userForeground) forceForeground(userForeground);
  } else {
    for (auto& w : fresh) rememberProcess(*lane, w.pid);
  }
  Json windows = Json::array();
  for (auto& w : fresh) {
    WinInfo now;
    if (describeWindow(w.hwnd, now)) windows.push(windowJson(now, lane.get()));
  }
  Json out = Json::object();
  out["laneId"] = lane->laneId;
  out["pid"] = launched.pid ? Json(static_cast<int64_t>(launched.pid))
                            : (fresh.empty() ? Json() : Json(static_cast<int64_t>(fresh.front().pid)));
  out["appName"] = fresh.empty() ? Json(narrow(target)) : Json(narrow(fresh.front().appName));
  out["bundleId"] = fresh.empty() ? Json() : Json(narrow(fresh.front().exeName));
  out["windows"] = windows;
  out["watching"] = true;
  return out;
}

Json Engine::quitApp(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::string app = lowerA(req["app"].str());
  int64_t appPid = req["app"].isNumber() ? req["app"].asInt() : (app.empty() ? 0 : atoll(app.c_str()));
  std::set<DWORD> tree = ownedProcesses(*lane);
  Json quit = Json::array();
  std::set<DWORD> done;
  for (auto& w : laneWindows(*lane)) {
    bool launched = tree.count(w.pid) > 0;
    if (!launched) continue;
    if (!app.empty()) {
      bool match = lowerA(narrow(w.appName)) == app || lowerA(narrow(w.exeName)) == app ||
                   lowerA(narrow(w.exeName)) == app + ".exe" || (appPid && static_cast<int64_t>(w.pid) == appPid);
      if (!match) continue;
    }
    if (done.count(w.pid)) continue;
    FILETIME created = processCreationTime(w.pid);
    if (!closeWindowGracefully(w.hwnd, 3000)) terminatePid(w.pid, created);
    done.insert(w.pid);
    Json q = Json::object();
    q["pid"] = static_cast<int64_t>(w.pid);
    q["appName"] = narrow(w.appName);
    q["bundleId"] = narrow(w.exeName);
    q["released"] = false;
    quit.push(q);
    lane->origin.erase(w.hwnd);
  }
  touch(*lane);
  Json out = Json::object();
  out["quit"] = quit;
  return out;
}

Json Engine::present(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  if (mode_ == Mode::Private) {
    fail(code::kInvalidArgument, "The private screen is a separate Windows session. Watch it in ADE instead.");
  }
  bool toMain = req["destination"].str("main") == "main";
  int moved = 0;
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  for (auto& w : laneWindows(*lane)) {
    if (toMain) {
      int width = w.frame.right - w.frame.left, height = w.frame.bottom - w.frame.top;
      SetWindowPos(w.hwnd, nullptr, work.left + 60 + 24 * moved, work.top + 60 + 24 * moved, width, height,
                   SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    } else {
      parkWindow(*lane, w.hwnd, lane->origin[w.hwnd].c_str());
    }
    ++moved;
  }
  Json out = Json::object();
  out["moved"] = moved;
  return out;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

bool Engine::captureLane(Lane& lane, Frame& frame, HWND onlyWindow, std::string* error) {
  if (mode_ == Mode::Private && !onlyWindow) {
    return captureScreenRect(lane.area, frame, lane.cursorVisible, error);
  }
  if (onlyWindow) return captureWindow(onlyWindow, frame, error);
  // Shared: compose the lane's windows, bottom of the z-order first.
  frame.resize(evenDown(lane.width), evenDown(lane.height));
  for (size_t i = 0; i < frame.bgra.size(); i += 4) {
    frame.bgra[i] = 0x1c;
    frame.bgra[i + 1] = 0x19;
    frame.bgra[i + 2] = 0x17;
    frame.bgra[i + 3] = 255;
  }
  auto windows = laneWindows(lane);
  std::reverse(windows.begin(), windows.end());
  bool any = false;
  for (auto& w : windows) {
    if (w.minimized) continue;
    Frame wf;
    std::string err;
    RECT r;
    GetWindowRect(w.hwnd, &r);
    if (!captureWindow(w.hwnd, wf, &err)) {
      if (error) *error = err;
      continue;
    }
    blit(wf, frame, r.left - lane.area.left, r.top - lane.area.top);
    any = true;
  }
  return any || windows.empty();
}

Json Engine::screenshot(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::wstring path = widen(requireString(req, "path"));
  HWND only = req["windowId"].isNumber() ? hwndFromId(req["windowId"].asInt()) : nullptr;
  Frame frame;
  std::string err;
  if (!captureLane(*lane, frame, only, &err)) {
    if (mode_ == Mode::Private && err.find("handle is invalid") != std::string::npos) failLocked();
    fail(code::kDisplayUnavailable, "No frame from the Windows screen: " + err);
  }
  if (!savePng(frame, path, &err)) fail(code::kInternalError, err);
  touch(*lane);
  Json out = Json::object();
  out["laneId"] = lane->laneId;
  out["filePath"] = narrow(path);
  out["width"] = frame.width;
  out["height"] = frame.height;
  out["capturedAt"] = isoNow();
  return out;
}

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

Json Engine::observe(const Json& req) {
  const std::string laneId = requireString(req, "laneId");
  auto lane = requireLane(laneId);
  int limit = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(2000, req["limit"].asInt(200))));
  auto windows = laneWindows(*lane);
  if (req["windowId"].isNumber()) {
    HWND want = hwndFromId(req["windowId"].asInt());
    windows.erase(std::remove_if(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd != want; }),
                  windows.end());
    if (windows.empty()) {
      fail(code::kWindowNotFound, "Window " + std::to_string(windowIdOf(want)) + " is not on lane " + laneId + ".");
    }
  }
  std::wstring shotPath = widen(req["screenshotPath"].str());
  if (shotPath.empty()) {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    shotPath = joinPath(tmp, L"ade-observe-" + std::to_wstring(nowMs()) + L".png");
  }
  Frame frame;
  std::string captureError;
  bool captured = captureLane(*lane, frame, nullptr, &captureError);
  if (captured) {
    std::string err;
    if (!savePng(frame, shotPath, &err)) {
      captured = false;
      captureError = err;
    }
  }
  if (!captured) logLine("observe on lane " + laneId + " captured no frame: " + captureError);

  UiaObservation obs = uia_.observe(windows, limit, 6000);
  uia_.remember(laneId, obs);

  Json mapPath;
  if (req["map"].asBool() && captured) {
    std::wstring path = widen(req["mapPath"].str());
    if (path.empty()) path = shotPath.substr(0, shotPath.size() - 4) + L"-map.png";
    std::vector<MapBox> boxes;
    for (auto& e : obs.elements) {
      if (e.actions.empty() && e.title.empty()) continue;
      RECT r = e.frame;
      OffsetRect(&r, -lane->area.left, -lane->area.top);
      boxes.push_back(MapBox{r, e.index});
    }
    std::string err;
    if (saveElementMap(frame, boxes, path, &err)) mapPath = narrow(path);
    else logLine("element map for lane " + laneId + " failed: " + err);
  }
  touch(*lane);
  Json out = Json::object();
  out["id"] = obs.id;
  out["laneId"] = laneId;
  out["capturedAt"] = isoNow();
  out["screenshotPath"] = narrow(shotPath);
  out["mapPath"] = mapPath;
  Json display = Json::object();
  display["width"] = frame.width > 0 ? frame.width : lane->width;
  display["height"] = frame.height > 0 ? frame.height : lane->height;
  display["scale"] = 1;
  out["display"] = display;
  Json wins = Json::array();
  for (auto& w : windows) wins.push(windowJson(w, lane.get()));
  out["windows"] = wins;
  Json elements = Json::array();
  for (auto& e : obs.elements) elements.push(elementJson(e, obs.id));
  out["elements"] = elements;
  out["elementCount"] = obs.elementCount;
  out["truncated"] = obs.truncated;
  out["truncatedReason"] = obs.truncatedReason.empty() ? Json() : Json(obs.truncatedReason);
  Json stalled = Json::array();
  for (auto& s : obs.stalledApps) stalled.push(s);
  out["stalledApps"] = stalled;
  out["walkMs"] = obs.walkMs;
  out["caption"] = req["caption"].isString() ? req["caption"] : Json();
  if (!captured) out["captureError"] = captureError;
  return out;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

bool Engine::hasTarget(const Json& payload) {
  if (!payload["handle"].str().empty()) return true;
  if (!payload["text"].str().empty()) return true;
  if (payload["target"].isObject()) return hasTarget(payload["target"]);
  return false;
}

UiaElement Engine::resolveTarget(const std::string& laneId, const Json& payload) {
  UiaElement element;
  if (!payload["handle"].str().empty()) element = uia_.resolveHandle(laneId, payload["handle"].str());
  else if (!payload["text"].str().empty()) {
    try { element = uia_.resolveText(laneId, payload["text"].str()); }
    catch (const DriverError&) {
      if (!payload["target"].isObject()) throw;
      return resolveTarget(laneId, payload["target"]);
    }
  } else if (payload["target"].isObject()) return resolveTarget(laneId, payload["target"]);
  else fail(code::kInvalidArgument, "This command needs a handle or a text match. Observe first.");
  auto lane = requireLane(laneId);
  const auto windows = laneWindows(*lane);
  if (std::none_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == element.window; })) {
    fail(code::kHandleExpired, "The element's window no longer belongs to this lane. Observe again.");
  }
  return element;
}

Json Engine::input(const Json& req) {
  const std::string laneId = requireString(req, "laneId");
  const std::string command = requireString(req, "command");
  const std::string mode = req["mode"].str("accessibility");
  const Json& payload = req["payload"];
  auto lane = requireLane(laneId);
  touch(*lane);
  Json result;
  if (command == "wait") {
    result = waitFor(laneId, payload);
  } else if (mode == "real") {
    result = realInput(*lane, command, payload, req);
  } else {
    result = accessibilityInput(*lane, command, payload);
  }
  touch(*lane);
  return result;
}

Json Engine::accessibilityInput(Lane& lane, const std::string& command, const Json& payload) {
  Json out = Json::object();
  out["resolvedIndex"] = Json();
  const bool priv = mode_ == Mode::Private;
  if (command == "click") {
    UiaElement e = resolveTarget(lane.laneId, payload);
    out["resolvedIndex"] = e.index;
    if (uia_.invoke(e)) return out;
    POINT c = centerOf(e.frame);
    int count = static_cast<int>(payload["count"].asInt(1));
    std::string button = payload["button"].str("left");
    if (priv) {
      if (!sendClick(c.x, c.y, button, count)) failLocked();
    } else {
      postClick(e.window, c.x, c.y, button, count);
    }
    return out;
  }
  if (command == "type") {
    const Json& target = payload["target"].isObject() ? payload["target"] : payload;
    std::wstring text = widen(payload["text"].isString() && !payload["target"].isObject()
                                  ? payload["value"].str(payload["text"].str())
                                  : payload["text"].str());
    // `type` carries its text in `text`, and an optional target beside it.
    if (payload["target"].isObject()) text = widen(payload["text"].str());
    bool clear = payload["clear"].asBool();
    UiaElement e;
    bool haveTarget = false;
    if (payload["target"].isObject() && hasTarget(payload["target"])) {
      e = resolveTarget(lane.laneId, payload["target"]);
      haveTarget = true;
    } else if (!payload["handle"].str().empty()) {
      e = resolveTarget(lane.laneId, payload);
      haveTarget = true;
    } else {
      // Focus may have moved since observe (for example after closing a dialog).
      // Never reuse the previous observation's focused element for typing.
      auto observation = uia_.observe(laneWindows(lane), 400, 1500);
      uia_.remember(lane.laneId, observation);
      haveTarget = uia_.newestFocused(lane.laneId, e);
    }
    (void)target;
    if (haveTarget) out["resolvedIndex"] = e.index;
    if (priv) {
      auto windows = laneWindows(lane);
      HWND window = haveTarget ? e.window : currentForeground();
      if (!window || std::none_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == window; }))
        fail(code::kNoWindow, "Focus a window belonging to this lane before typing.");
      if (!forceForeground(window) || currentForeground() != window)
        fail(code::kNoWindow, "Windows could not focus this lane's window; no text was sent.");
      if (haveTarget && !uia_.focus(e)) fail(code::kHandleExpired, "The text target is no longer available. Observe again.");
      if (clear && !sendKeys("a", {"ctrl"})) failLocked();
      if (!sendText(text)) failLocked();
      return out;
    }
    if (haveTarget && uia_.appendValue(e, text, clear)) return out;
    HWND window = haveTarget ? e.window : nullptr;
    if (!window) {
      auto windows = laneWindows(lane);
      if (windows.empty()) fail(code::kNoWindow, "Lane " + lane.laneId + " has no window to type into.");
      window = windows.front().hwnd;
    }
    if (clear) fail(code::kInputLeaseRequired, "Clearing this control requires real input under the input lease.");
    if (!postText(window, text)) fail(code::kNoWindow, "No focused control in this lane window accepted text.");
    return out;
  }
  if (command == "setValue") {
    UiaElement e = resolveTarget(lane.laneId, payload);
    out["resolvedIndex"] = e.index;
    if (!uia_.setValue(e, widen(payload["value"].str()))) {
      fail(code::kInvalidArgument, e.role + " refused a value.");
    }
    return out;
  }
  if (command == "press") {
    std::string key = payload["key"].str();
    auto modifiers = stringList(payload["modifiers"]);
    HWND window = nullptr;
    if (hasTarget(payload)) {
      try {
        UiaElement e = resolveTarget(lane.laneId, payload);
        out["resolvedIndex"] = e.index;
        uia_.focus(e);
        window = e.window;
      } catch (const DriverError&) {
      }
    }
    auto windows = laneWindows(lane);
    if (!window && !windows.empty()) window = windows.front().hwnd;
    if (!window) fail(code::kNoWindow, "Lane " + lane.laneId + " has a screen but no window to send a key to.");
    if (priv) {
      if (!forceForeground(window) || currentForeground() != window) fail(code::kNoWindow, "Windows could not focus the requested window; no key was sent.");
      if (!sendKeys(key, modifiers)) failLocked();
      return out;
    }
    fail(code::kInputLeaseRequired, "Sending a key on the main desktop needs mode real and an input lease.");
    return out;
  }
  if (command == "scroll") {
    std::string direction = payload["direction"].str("down");
    int amount = static_cast<int>(payload["amount"].asInt(3));
    if (hasTarget(payload)) {
      UiaElement e = resolveTarget(lane.laneId, payload);
      out["resolvedIndex"] = e.index;
      if (uia_.scroll(e, direction, amount)) return out;
      POINT c = centerOf(e.frame);
      if (priv) {
        if (!sendScroll(c.x, c.y, direction, amount)) failLocked();
      } else {
        postScroll(e.window, c.x, c.y, direction, amount);
      }
      return out;
    }
    auto windows = laneWindows(lane);
    if (windows.empty()) fail(code::kNoWindow, "Lane " + lane.laneId + " has a screen but no window to scroll.");
    POINT c = centerOf(windows.front().frame);
    if (priv) {
      if (!sendScroll(c.x, c.y, direction, amount)) failLocked();
    } else {
      postScroll(windows.front().hwnd, c.x, c.y, direction, amount);
    }
    return out;
  }
  if (command == "drag") {
    if (priv) return realInput(lane, command, payload, Json());
    fail(code::kInputLeaseRequired, "A drag has no UI Automation equivalent; it needs mode \"real\" and an input lease.");
  }
  fail(code::kInvalidArgument, "\"" + command + "\" is not an input command this driver knows.");
}

Json Engine::realInput(Lane& lane, const std::string& command, const Json& payload, const Json& req) {
  const bool priv = mode_ == Mode::Private;
  if (!priv) {
    std::string holder = req["lease"]["holderId"].str();
    if (lane.leaseHolder.empty() || holder != lane.leaseHolder || nowMs() > lane.leaseExpiresMs) {
      fail(code::kInputLeaseRequired, "Real input on the main desktop needs the input lease.");
    }
  }
  Json out = Json::object();
  out["resolvedIndex"] = Json();
  auto point = [&](const char* key) -> POINT {
    POINT p;
    if (!pointFrom(payload, key, p)) {
      UiaElement e = resolveTarget(lane.laneId, payload);
      out["resolvedIndex"] = e.index;
      p = centerOf(e.frame);
    }
    p.x = std::max<LONG>(lane.area.left, std::min<LONG>(lane.area.right - 1, p.x));
    p.y = std::max<LONG>(lane.area.top, std::min<LONG>(lane.area.bottom - 1, p.y));
    return p;
  };
  // The topmost lane window under a point, for posted input on the shared desktop.
  auto windowAt = [&](POINT p) -> HWND {
    for (auto& w : laneWindows(lane)) {
      if (!w.minimized && inRect(w.frame, p)) return w.hwnd;
    }
    fail(code::kNoWindow, "There is no lane window at that point.");
  };
  bool ok = true;
  if (command == "move") {
    POINT p = point("to");
    if (priv) ok = sendMove(p.x, p.y);
  } else if (command == "click") {
    POINT p = point("at");
    std::string button = payload["button"].str("left");
    int count = static_cast<int>(payload["count"].asInt(1));
    ok = priv ? sendClick(p.x, p.y, button, count) : postClick(windowAt(p), p.x, p.y, button, count);
  } else if (command == "drag") {
    POINT from = point("from");
    POINT to = point("to");
    int duration = static_cast<int>(payload["durationMs"].asInt(300));
    if (priv) {
      ok = sendDrag(from.x, from.y, to.x, to.y, duration);
    } else {
      HWND w = windowAt(from);
      POINT c = from;
      ScreenToClient(w, &c);
      PostMessageW(w, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(c.x, c.y));
      for (int i = 1; i <= 12; ++i) {
        POINT s = {from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12};
        ScreenToClient(w, &s);
        PostMessageW(w, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(s.x, s.y));
        Sleep(std::max(1, duration / 12));
      }
      POINT e = to;
      ScreenToClient(w, &e);
      PostMessageW(w, WM_LBUTTONUP, 0, MAKELPARAM(e.x, e.y));
    }
  } else if (command == "scroll") {
    POINT p = point("at");
    std::string direction = payload["direction"].str("down");
    int amount = static_cast<int>(payload["amount"].asInt(3));
    ok = priv ? sendScroll(p.x, p.y, direction, amount) : postScroll(windowAt(p), p.x, p.y, direction, amount);
  } else if (command == "press" || command == "type") {
    auto windows = laneWindows(lane);
    HWND target = windows.empty() ? nullptr : windows.front().hwnd;
    HWND user = priv ? nullptr : currentForeground();
    if (!target) fail(code::kNoWindow, "This lane has no window to receive input.");
    if (!forceForeground(target) || currentForeground() != target) fail(code::kNoWindow, "Windows could not focus this lane window; no input was sent.");
    if (command == "press") {
      ok = sendKeys(payload["key"].str(), stringList(payload["modifiers"]));
    } else {
      ok = sendText(widen(payload["text"].str()));
    }
    if (user && user != target) {
      Sleep(30);
      forceForeground(user);
    }
  } else if (command == "releaseCursor") {
    // No cursor hold on Windows: the private screen has its own pointer.
  } else if (command == "releaseInput") {
    if (priv) releaseAllButtons();
  } else {
    fail(code::kInvalidArgument, "\"" + command + "\" is not a real-input command this driver knows.");
  }
  if (!ok) failLocked();
  return out;
}

Json Engine::waitFor(const std::string& laneId, const Json& payload) {
  std::string text = lowerA(payload["text"].str());
  std::string gone = lowerA(payload["gone"].str());
  std::string title = lowerA(payload["windowTitle"].str());
  if (text.empty() && gone.empty() && title.empty()) {
    fail(code::kInvalidArgument, "wait needs one of \"text\", \"gone\", or \"windowTitle\".");
  }
  int64_t timeout = std::max<int64_t>(250, std::min<int64_t>(120'000, payload["timeoutMs"].asInt(10'000)));
  int64_t deadline = nowMs() + timeout;
  Json out = Json::object();
  std::string lastStop;
  std::vector<std::string> stalled;
  for (;;) {
    std::unique_lock<std::recursive_mutex> operation(operationMutex_);
    if (!running_) fail(code::kCancelled, "The Windows screen stopped while waiting.");
    auto lane = requireLane(laneId);
    auto windows = laneWindows(*lane);
    bool met = false;
    Json index;
    if (!title.empty()) {
      for (auto& w : windows) {
        if (lowerA(narrow(w.title)).find(title) != std::string::npos) met = true;
      }
    } else {
      std::string needle = text.empty() ? gone : text;
      UiaObservation obs = uia_.observe(windows, 400, 1500);
      lastStop = obs.truncatedReason;
      stalled = obs.stalledApps;
      bool found = false;
      for (auto& e : obs.elements) {
        if (Uia::matches(e, needle)) {
          found = true;
          index = e.index;
          uia_.remember(laneId, obs);
          break;
        }
      }
      met = text.empty() ? !found : found;
    }
    if (met) {
      out["ok"] = true;
      out["resolvedIndex"] = index;
      break;
    }
    if (nowMs() >= deadline) {
      out["ok"] = false;
      out["resolvedIndex"] = Json();
      break;
    }
    operation.unlock();
    Sleep(250);
  }
  out["truncatedReason"] = lastStop.empty() ? Json() : Json(lastStop);
  Json s = Json::array();
  for (auto& a : stalled) s.push(a);
  out["stalledApps"] = s;
  return out;
}

Json Engine::setLease(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  lane->leaseHolder = requireString(req, "holderId");
  const Json& exp = req["expiresAt"];
  int64_t ttl = 60'000;
  if (exp.isNumber()) {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    int64_t epochMs = static_cast<int64_t>((u.QuadPart - 116444736000000000ULL) / 10000);
    ttl = std::max<int64_t>(0, exp.asInt() - epochMs);
  }
  lane->leaseExpiresMs = nowMs() + ttl;
  Json out = Json::object();
  out["laneId"] = lane->laneId;
  out["holderId"] = lane->leaseHolder;
  out["expiresAt"] = exp;
  return out;
}

Json Engine::clearLease(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  lane->leaseHolder.clear();
  lane->leaseExpiresMs = 0;
  Json out = Json::object();
  out["cleared"] = true;
  return out;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

void Engine::ensureMediaThread(const std::shared_ptr<Lane>& lane) {
  if (lane->mediaRun.exchange(true)) return;
  if (lane->mediaThread.joinable()) lane->mediaThread.join();
  lane->mediaThread = std::thread([this, lane] { mediaLoop(lane); });
}

void Engine::stopMedia(Lane& lane) {
  {
    std::lock_guard<std::mutex> lock(lane.media);
    lane.streaming = false;
    if (lane.recorder) {
      std::string err;
      lane.recorder->finish(&err);
      lane.recorder.reset();
    }
  }
  lane.mediaRun = false;
  if (lane.mediaThread.joinable() && lane.mediaThread.get_id() != std::this_thread::get_id()) lane.mediaThread.join();
  std::lock_guard<std::mutex> lock(lane.media);
  if (lane.server) lane.server->stop();
  lane.server.reset();
  lane.encoder.reset();
}

void Engine::mediaLoop(std::shared_ptr<Lane> lane) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
  const int64_t start = nowMs();
  std::vector<uint8_t> nv12;
  while (lane->mediaRun && running_) {
    int fps;
    bool streaming, recording, readers;
    HWND recordWindow;
    {
      std::lock_guard<std::mutex> lock(lane->media);
      streaming = lane->streaming && lane->server && lane->encoder;
      readers = streaming && lane->server->clientCount() > 0;
      recording = lane->recorder != nullptr;
      recordWindow = lane->recordWindow;
      fps = std::max(streaming ? lane->streamFps : 0, recording ? lane->recordFps : 0);
    }
    if (!streaming && !recording) break;
    int64_t frameStart = nowMs();
    if (readers || recording) {
      Frame frame;
      std::string err;
      std::unique_lock<std::recursive_mutex> operation(operationMutex_, std::try_to_lock);
      if (!operation.owns_lock()) { Sleep(10); continue; }
      bool ok = captureLane(*lane, frame, recording && recordWindow ? recordWindow : nullptr, &err);
      operation.unlock();
      if (!ok) {
        if (nowMs() - lane->lastStreamErrorMs > 5000) {
          lane->lastStreamErrorMs = nowMs();
          std::string message = err.find("handle is invalid") != std::string::npos
                                    ? "This PC is locked, so the private screen shows no picture. It resumes after unlock."
                                    : "No frame from the Windows screen: " + err;
          emit_(eventLine("stream-error", Json::Object{{"laneId", lane->laneId}, {"message", message}}));
        }
      } else {
        // Frames must match the encoder's size; a window recording keeps the
        // window's first size and crops or pads later frames.
        std::lock_guard<std::mutex> lock(lane->media);
        if (streaming && readers && !recordWindow && lane->streaming && lane->server && lane->encoder) {
          Frame sized = frame;
          if (sized.width != lane->encoder->width() || sized.height != lane->encoder->height()) {
            Frame canvas;
            canvas.resize(lane->encoder->width(), lane->encoder->height());
            blit(frame, canvas, 0, 0);
            sized = std::move(canvas);
          }
          bgraToNv12(sized, nv12);
          if (lane->wantKeyframe.exchange(false)) lane->encoder->forceKeyframe();
          std::string encErr;
          int64_t ts = (nowMs() - start) * 10'000;
          auto* server = lane->server.get();
          auto& codec = lane->codec;
          bool encoded = lane->encoder->encode(nv12, ts, [&](const std::vector<uint8_t>& unit, bool key) {
            if (key && codec.empty()) {
              codec = avcCodecString(unit);
              if (!codec.empty()) server->setConfig(codec);
            }
            server->broadcast(2, key, unit);
          }, &encErr);
          if (!encoded && nowMs() - lane->lastStreamErrorMs > 5000) {
            lane->lastStreamErrorMs = nowMs();
            emit_(eventLine("stream-error", Json::Object{{"laneId", lane->laneId}, {"message", encErr}}));
          }
        }
        if (lane->recorder) {
          Frame sized = frame;
          if (sized.width != lane->recorder->width() || sized.height != lane->recorder->height()) {
            Frame canvas;
            canvas.resize(lane->recorder->width(), lane->recorder->height());
            blit(frame, canvas, 0, 0);
            sized = std::move(canvas);
          }
          int64_t now = nowMs();
          uint64_t hash = frameHash(sized);
          if (hash != lane->recordLastHash) {
            lane->recordLastHash = hash;
            lane->recordLastChangeMs = now;
          }
          int64_t step = now - lane->recordLastWallMs;
          lane->recordLastWallMs = now;
          bool idle = !lane->keepIdle && now - lane->recordLastChangeMs > kIdleCutAfterMs;
          if (idle) {
            lane->recordIdleCutMs += step;
          } else {
            bgraToNv12(sized, nv12);
            std::string recErr;
            int64_t duration = std::max<int64_t>(1, step) * 10'000;
            if (!lane->recorder->write(nv12, lane->recordMediaMs * 10'000, duration, &recErr)) {
              lane->recordError = recErr;
            }
            lane->recordMediaMs += std::max<int64_t>(1, step);
          }
        }
      }
    }
    int64_t budget = 1000 / std::max(1, fps);
    int64_t spent = nowMs() - frameStart;
    if (spent < budget) Sleep(static_cast<DWORD>(budget - spent));
  }
  lane->mediaRun = false;
  CoUninitialize();
}

Json Engine::startStream(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, req["fps"].asInt(30))));
  int port = 0;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (!lane->server) {
      lane->server = std::make_unique<StreamByteServer>();
      Lane* raw = lane.get();
      port = lane->server->start([raw] { raw->wantKeyframe = true; });
      if (!port) {
        lane->server.reset();
        fail(code::kDisplayUnavailable, "The stream could not open a loopback port.");
      }
      lane->encoder = std::make_unique<H264Encoder>();
      std::string err;
      // About 0.08 bit per pixel per frame at the active rate.
      int kbps = static_cast<int>(std::max<int64_t>(2000, std::min<int64_t>(
                                                                24000, static_cast<int64_t>(lane->width) * lane->height * 30 / 12500)));
      if (!lane->encoder->open(lane->width, lane->height, 30, kbps, &err)) {
        lane->server->stop();
        lane->server.reset();
        lane->encoder.reset();
        fail(code::kDisplayUnavailable, "The H.264 encoder did not start: " + err);
      }
      lane->codec.clear();
    } else {
      port = lane->server->port();
    }
    lane->streaming = true;
    lane->streamFps = fps;
  }
  lane->wantKeyframe = true;
  ensureMediaThread(lane);
  touch(*lane);
  Json out = Json::object();
  out["port"] = port;
  out["width"] = evenDown(lane->width);
  out["height"] = evenDown(lane->height);
  out["codec"] = lane->codec.empty() ? Json() : Json(lane->codec);
  return out;
}

Json Engine::setStreamRate(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, requireInt(req, "fps"))));
  std::lock_guard<std::mutex> lock(lane->media);
  lane->streamFps = fps;
  Json out = Json::object();
  out["fps"] = fps;
  return out;
}

Json Engine::setStreamCursor(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  bool visible = req["visible"].asBool();
  std::lock_guard<std::mutex> lock(lane->media);
  lane->cursorVisible = visible;
  Json out = Json::object();
  out["visible"] = visible;
  return out;
}

Json Engine::stopStream(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  bool stopped = false;
  bool keepThread;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    stopped = lane->streaming;
    lane->streaming = false;
    keepThread = lane->recorder != nullptr;
    if (lane->server) lane->server->stop();
    lane->server.reset();
    lane->encoder.reset();
    lane->codec.clear();
  }
  if (!keepThread) {
    lane->mediaRun = false;
    if (lane->mediaThread.joinable()) lane->mediaThread.join();
  }
  Json out = Json::object();
  out["stopped"] = stopped;
  return out;
}

Json Engine::startRecording(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::wstring path = widen(requireString(req, "filePath"));
  int fps = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(60, req["fps"].asInt(30))));
  HWND window = req["windowId"].isNumber() ? hwndFromId(req["windowId"].asInt()) : nullptr;
  int width = lane->width, height = lane->height;
  if (window) {
    RECT r;
    if (!GetWindowRect(window, &r)) fail(code::kWindowNotFound, "That window is not open.");
    width = r.right - r.left;
    height = r.bottom - r.top;
  }
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (lane->recorder) fail(code::kInvalidArgument, "Lane " + lane->laneId + " is already recording.");
    auto recorder = std::make_unique<Mp4Recorder>();
    std::string err;
    if (!recorder->open(path, width, height, fps, &err)) fail(code::kInternalError, err);
    lane->recorder = std::move(recorder);
    lane->recordPath = path;
    lane->recordFps = fps;
    lane->keepIdle = req["keepIdle"].asBool();
    lane->recordWindow = window;
    lane->recordStartMs = nowMs();
    lane->recordIdleCutMs = 0;
    lane->recordLastChangeMs = nowMs();
    lane->recordLastWallMs = nowMs();
    lane->recordMediaMs = 0;
    lane->recordLastHash = 0;
    lane->recordError.clear();
  }
  ensureMediaThread(lane);
  touch(*lane);
  Json out = Json::object();
  out["startedAt"] = isoNow();
  return out;
}

Json Engine::stopRecording(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::unique_ptr<Mp4Recorder> recorder;
  int64_t wall = 0, idleCut = 0, media = 0;
  std::wstring path;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    if (!lane->recorder) fail(code::kRecordingNotRunning, "Lane " + lane->laneId + " is not recording.");
    recorder = std::move(lane->recorder);
    wall = nowMs() - lane->recordStartMs;
    idleCut = lane->recordIdleCutMs;
    media = lane->recordMediaMs;
    path = lane->recordPath;
    lane->recordWindow = nullptr;
  }
  std::string err;
  if (!recorder->finish(&err)) fail(code::kInternalError, err);
  bool streaming;
  {
    std::lock_guard<std::mutex> lock(lane->media);
    streaming = lane->streaming;
  }
  if (!streaming) {
    lane->mediaRun = false;
    if (lane->mediaThread.joinable()) lane->mediaThread.join();
  }
  Json out = Json::object();
  out["filePath"] = narrow(path);
  out["durationMs"] = media;
  out["wallDurationMs"] = wall;
  out["idleCutMs"] = idleCut;
  return out;
}

// ---------------------------------------------------------------------------
// Watcher: late windows, dead windows, and windows-changed events.
// ---------------------------------------------------------------------------

void Engine::watchLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  while (running_) {
    Sleep(500);
    std::lock_guard<std::recursive_mutex> operation(operationMutex_);
    if (!running_) break;
    std::vector<std::shared_ptr<Lane>> lanes;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto& kv : lanes_) lanes.push_back(kv.second);
    }
    if (lanes.empty()) continue;
    std::vector<WinInfo> all = listAppWindows();
    for (auto& lane : lanes) {
      if (mode_ == Mode::Shared) {
        std::lock_guard<std::mutex> lock(mutex_);
        // Late windows of apps this lane launched.
        int64_t now = nowMs();
        for (auto it = lane->watches.begin(); it != lane->watches.end();) {
          if (now - it->sinceMs > kLaunchWatchMs) {
            it = lane->watches.erase(it);
            continue;
          }
          std::set<DWORD> tree = ownedProcesses(*lane);
          for (auto& w : all) {
            if (it->before.count(w.hwnd) || lane->origin.count(w.hwnd)) continue;
            bool owned = false;
            for (auto& other : lanes_) owned = owned || other.second->origin.count(w.hwnd);
            if (owned) continue;
            if (tree.count(w.pid)) {
              HWND user = currentForeground();
              parkWindow(*lane, w.hwnd, "ade_launched");
              rememberProcess(*lane, w.pid);
              if (user && currentForeground() != user) forceForeground(user);
            }
          }
          ++it;
        }
        // Forget windows that closed.
        for (auto it = lane->origin.begin(); it != lane->origin.end();) {
          if (!IsWindow(it->first)) {
            lane->home.erase(it->first);
            it = lane->origin.erase(it);
          } else {
            ++it;
          }
        }
      }
      auto windows = laneWindows(*lane);
      std::string sig;
      for (auto& w : windows) {
        sig += std::to_string(windowIdOf(w.hwnd)) + ":" + narrow(w.title) + ":" + std::to_string(w.minimized) + ";";
      }
      if (sig != lane->windowsSignature) {
        lane->windowsSignature = sig;
        Json list = Json::array();
        for (auto& w : windows) list.push(windowJson(w, lane.get()));
        emit_(eventLine("windows-changed", Json::Object{{"laneId", lane->laneId}, {"windows", list}}));
      }
    }
  }
  CoUninitialize();
}

}  // namespace ade
