#include "engineLane.h"
#include "parkedwindows.h"

#include <algorithm>
#include <cstdio>

namespace ade {

namespace {

constexpr int kShareGap = 200;       // px between the last monitor and a lane area
constexpr int64_t kLaunchWatchMs = 20'000;



const std::set<std::string>& engineOps() {
  static const std::set<std::string> ops = {
      "display.create", "display.destroy", "display.reconcile", "window.list",   "window.park",
      "window.unpark",  "app.launch",      "app.quit",          "present",       "observe",
      "input",          "lease.set",       "lease.clear",       "capture.screenshot", "stream.start",
      "stream.setRate", "stream.setCursorVisible", "stream.stop", "record.start", "record.stop",
      "window.focus",   "window.minimize", "window.close",
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






}  // namespace


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

void Engine::rememberProcess(Lane& lane, DWORD pid, DWORD watchedRoot) {
  FILETIME created = processCreationTime(pid);
  if (!pid || (!created.dwLowDateTime && !created.dwHighDateTime)) return;
  lane.launchedRoots.insert(pid);
  lane.launchedTimes[pid] = created;
  lane.watchedLaunchRoots[pid] = watchedRoot ? watchedRoot : pid;
}

std::map<DWORD, FILETIME> Engine::ownedProcessIdentities(Lane& lane, DWORD watchedRoot) {
  std::map<DWORD, FILETIME> result;
  for (const auto& tracked : lane.launchedTimes) {
    if (watchedRoot && (!lane.watchedLaunchRoots.count(tracked.first) || lane.watchedLaunchRoots.at(tracked.first) != watchedRoot)) continue;
    auto tree = processTreeIdentities(tracked.first, tracked.second);
    result.insert(tree.begin(), tree.end());
  }
  return result;
}

std::set<DWORD> Engine::ownedProcesses(Lane& lane, DWORD watchedRoot) {
  std::set<DWORD> result;
  for (const auto& tracked : ownedProcessIdentities(lane, watchedRoot)) result.insert(tracked.first);
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

Json Engine::windowJson(const WinInfo& w, const Lane* lane, const std::set<DWORD>* owned) {
  if (!lane) return windowToJson(w, "", "", 0);
  std::string origin;
  if (mode_ == Mode::Shared) {
    auto it = lane->origin.find(w.hwnd);
    origin = it == lane->origin.end() ? "claimed" : it->second;
  } else {
    std::set<DWORD> computed;
    if (!owned) { computed = ownedProcesses(*const_cast<Lane*>(lane)); owned = &computed; }
    origin = owned->count(w.pid) ? "ade_launched" : "adopted";
  }
  return windowToJson(w, lane->laneId, origin, lane->displayId);
}

std::set<DWORD> Engine::ownedForListing(Lane& lane) {
  return mode_ == Mode::Private ? ownedProcesses(lane) : std::set<DWORD>{};
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
  if (op == "app.launch") return launch(req, operation);
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
  if (op == "window.focus" || op == "window.minimize" || op == "window.close") return windowCommand(op, req);
  // Both re-take the operation lock only for the short parts; opening and
  // finalizing an MP4 must not stall capture or queue window.list.
  if (op == "record.start") { operation.unlock(); return startRecording(req); }
  if (op == "record.stop") { operation.unlock(); return stopRecording(req); }
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
      if (mode_ == Mode::Private) lane->dataDir = widen(req["laneDataDir"].str());
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
    const auto identities = ownedProcessIdentities(*lane);
    std::set<DWORD> tree, reportedLeftOpen;
    for (const auto& entry : identities) tree.insert(entry.first);
    for (auto& w : laneWindows(*lane)) {
      if (reportedLeftOpen.count(w.pid)) { releaseWindow(*lane, w.hwnd); continue; }
      if (tree.count(w.pid)) {
        FILETIME created = identities.at(w.pid);
        if (!closeWindowGracefully(w.hwnd, 3000) && !terminatePid(w.pid, created)) {
          Json app = Json::object();
          app["pid"] = static_cast<int64_t>(w.pid);
          app["appName"] = narrow(w.appName);
          app["message"] = narrow(w.appName) + " did not quit. It moved to your screen.";
          leftOpen.push(app);
          reportedLeftOpen.insert(w.pid);
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
    // Windows are not process ownership: a launched root or background child
    // can outlive its last window. Preserve identity until all owned PIDs stop.
    for (const auto& [pid, created] : identities) {
      if (reportedLeftOpen.count(pid)) continue;
      FILETIME current = processCreationTime(pid);
      if ((!current.dwLowDateTime && !current.dwHighDateTime) || CompareFileTime(&current, &created) != 0) continue;
      if (!terminatePid(pid, created)) {
        leftOpen.push(Json::Object{{"pid", static_cast<int64_t>(pid)}, {"appName", "Background process"},
            {"message", "An ADE-launched process could not be stopped."}});
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
    if (parked_) parked_->add(hwnd, r);
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
    const RECT target = releaseTargetFor(hwnd, home != lane.home.end() ? &home->second : nullptr);
    SetWindowPos(hwnd, nullptr, target.left, target.top, target.right - target.left, target.bottom - target.top,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  }
  if (parked_ && lane.origin.count(hwnd)) parked_->remove(hwnd);
  lane.origin.erase(hwnd);
  lane.home.erase(hwnd);
}

bool Engine::tryListWindows(const Json& req, Json* result) {
  std::unique_lock<std::recursive_mutex> operation(operationMutex_, std::try_to_lock);
  if (!operation.owns_lock() || !running_) return false;
  *result = listWindowsOp(req);
  return true;
}

Json Engine::listWindowsOp(const Json& req) {
  const std::string laneId = req["laneId"].str();
  Json windows = Json::array();
  if (!laneId.empty()) {
    auto lane = requireLane(laneId);
    const auto owned = ownedForListing(*lane);
    for (auto& w : laneWindows(*lane)) windows.push(windowJson(w, lane.get(), &owned));
  } else {
    // Every window of this session, each tagged with the lane that holds it.
    std::vector<std::shared_ptr<Lane>> lanes;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (auto& kv : lanes_) lanes.push_back(kv.second);
    }
    std::map<const Lane*, std::set<DWORD>> owned;
    for (auto& l : lanes) owned[l.get()] = ownedForListing(*l);
    for (auto& w : listAppWindows()) {
      const Lane* holder = nullptr;
      for (auto& l : lanes) {
        if (mode_ == Mode::Private || l->origin.count(w.hwnd)) holder = l.get();
      }
      windows.push(holder ? windowJson(w, holder, &owned[holder]) : windowJson(w, nullptr));
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
  std::set<DWORD> handedOver;
  Json handedOverPids = Json::array();
  std::set<DWORD> watchedRoots;
  for (const auto& [pid, created] : lane->launchedTimes) {
    FILETIME current = processCreationTime(pid);
    if (CompareFileTime(&current, &created) != 0) continue;
    auto tree = processTreeIdentities(pid, created);
    if (tree.count(w.pid)) {
      watchedRoots.insert(lane->watchedLaunchRoots.count(pid) ? lane->watchedLaunchRoots.at(pid) : pid);
      for (const auto& entry : tree) handedOver.insert(entry.first);
    }
  }
  if (!handedOver.empty()) {
    // A launcher may have exited after creating the GUI process. Keep its
    // original watch identity while handing over every still-owned group member.
    for (const auto& [pid, root] : lane->watchedLaunchRoots) if (watchedRoots.count(root)) handedOver.insert(pid);
    for (DWORD root : watchedRoots) handedOverPids.push(static_cast<int64_t>(root));
    for (const auto& window : laneWindows(*lane)) if (handedOver.count(window.pid)) {
      releaseWindow(*lane, window.hwnd); ids.push(windowIdOf(window.hwnd));
    }
    for (DWORD pid : handedOver) { lane->launchedRoots.erase(pid); lane->launchedTimes.erase(pid); lane->watchedLaunchRoots.erase(pid); }
    lane->watches.erase(std::remove_if(lane->watches.begin(), lane->watches.end(), [&](const LaunchWatch& watch) { return handedOver.count(watch.pid) > 0 || watchedRoots.count(watch.pid) > 0; }), lane->watches.end());
  } else { releaseWindow(*lane, hwnd); ids.push(windowIdOf(hwnd)); }
  out["window"] = windowToJson(w, "", "", 0);
  out["releasedWindowIds"] = ids;
  out["handedOverPids"] = handedOverPids;
  out["handedOverPid"] = handedOverPids.items().size() ? handedOverPids.items().front() : Json();
  return out;
}

Json Engine::launch(const Json& req, std::unique_lock<std::recursive_mutex>& operation) {
  auto lane = requireLane(requireString(req, "laneId"));
  std::wstring target = widen(requireString(req, "target"));
  std::vector<std::wstring> args;
  for (const auto& a : stringList(req["args"])) args.push_back(widen(a));
  // "chrome" reaches chrome.exe through App Paths, as it would from Run.
  const std::wstring resolved = resolveAppPath(target);
  if (!resolved.empty()) target = resolved;
  // The private seat: a browser gets this lane's own profile.
  const Json profileDir = mode_ == Mode::Private ? addLaneBrowserProfile(target, lane->dataDir, args) : Json();
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
  // Wait briefly for the first window, so the reply can name it. The operation
  // lock is released while sleeping so capture and other requests keep going.
  std::vector<WinInfo> fresh;
  for (int i = 0; i < 40 && fresh.empty(); ++i) {
    operation.unlock();
    Sleep(125);
    operation.lock();
    if (!running_) fail(code::kCancelled, "The Windows screen stopped while the app was starting.");
    std::set<DWORD> tree = launched.pid ? ownedProcesses(*lane, launched.pid) : std::set<DWORD>{};
    for (auto& w : listAppWindows()) {
      if (before.count(w.hwnd)) continue;
      bool ours = tree.count(w.pid) > 0;
      if (ours) fresh.push_back(w);
    }
  }
  if (mode_ == Mode::Shared) {
    for (auto& w : fresh) {
      parkWindow(*lane, w.hwnd, "ade_launched");
      rememberProcess(*lane, w.pid, launched.pid);
    }
    // Launching takes the foreground on Windows. Give it back.
    if (userForeground && currentForeground() != userForeground) forceForeground(userForeground);
  } else {
    for (auto& w : fresh) rememberProcess(*lane, w.pid, launched.pid);
    // The private session is the lane's own, but the driver there is not the
    // foreground process, so Windows may open the app behind whatever the
    // user's startup apps put in front (a WSL console took the clicks and the
    // keys meant for Notepad). An app the agent just opened is the one it
    // acts on next: bring it to the front, as macOS does.
    if (!fresh.empty() && !forceForeground(fresh.front().hwnd)) logLine("launch: the new window did not come to the front");
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
  // No window, and nothing of the launch left running: Windows passed it to an
  // instance that was already running (for the private seat, outside it).
  const bool rootGone = launched.pid && ownedProcesses(*lane, launched.pid).empty();
  const bool handedOff = fresh.empty() && (rootGone || !launched.pid);
  out["handedOff"] = handedOff;
  out["message"] = handedOff
      ? Json(mode_ == Mode::Private
            ? "No window opened on this lane's screen: Windows handed the launch to an instance that was already running, which may be on your own desktop. Quit that app on the lane's screen, or pass the app's own new-instance or profile flag."
            : "No new window opened: Windows handed the launch to an instance that was already running.")
      : Json();
  out["profileDir"] = profileDir;
  out["resolvedPath"] = resolved.empty() ? Json() : Json(narrow(resolved));
  if (handedOff) logLine("launch: handed off; no window from the launched process");
  return out;
}

Json Engine::quitApp(const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  const std::string app = lowerA(req["app"].str());
  const int64_t appPid = req["app"].isNumber() ? req["app"].asInt() : (app.empty() ? 0 : atoll(app.c_str()));
  const auto owned = ownedProcessIdentities(*lane);
  std::set<DWORD> selected;
  for (const auto& [pid, created] : owned) {
    auto path = processImagePath(pid);
    const auto name = lowerA(narrow(baseName(path)));
    if (app.empty() || (appPid && pid == appPid) || name == app || name == app + ".exe" || lowerA(narrow(appNameForExe(path))) == app) {
      for (const auto& child : processTreeIdentities(pid, created)) if (owned.count(child.first)) selected.insert(child.first);
    }
  }
  std::map<DWORD, FILETIME> identities;
  std::map<DWORD, std::pair<std::string, std::string>> names;
  for (DWORD pid : selected) {
    identities[pid] = owned.at(pid);
    auto path = processImagePath(pid);
    names[pid] = {narrow(appNameForExe(path)), narrow(baseName(path))};
  }
  for (const auto& window : laneWindows(*lane)) if (selected.count(window.pid)) closeWindowGracefully(window.hwnd, 3000);
  Json quit = Json::array();
  for (const auto& [pid, created] : identities) {
    FILETIME current = processCreationTime(pid);
    if (current.dwLowDateTime || current.dwHighDateTime) {
      if (CompareFileTime(&current, &created) != 0) continue;
      if (!terminatePid(pid, created)) fail(code::kDriverUnavailable, "Windows could not stop an ADE-launched process.");
    }
    quit.push(Json::Object{{"pid", static_cast<int64_t>(pid)}, {"appName", names.at(pid).first},
        {"bundleId", names.at(pid).second}, {"released", false}});
    lane->launchedRoots.erase(pid); lane->launchedTimes.erase(pid); lane->watchedLaunchRoots.erase(pid);
  }
  touch(*lane);
  return Json::Object{{"quit", quit}};
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

HWND Engine::requireLaneWindow(Lane& lane, int64_t windowId) {
  HWND hwnd = hwndFromId(windowId);
  if (!IsWindow(hwnd)) fail(code::kWindowNotFound, "Window " + std::to_string(windowId) + " is not open.");
  const auto windows = laneWindows(lane);
  if (std::any_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == hwnd; })) return hwnd;
  if (mode_ == Mode::Shared) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& kv : lanes_) {
      if (kv.first != lane.laneId && kv.second->origin.count(hwnd))
        fail(code::kAppOwnedByOtherLane, "Lane " + kv.first + " holds window " + std::to_string(windowId) + ".");
    }
    // No lane holds it (a window of the user's own desktop): not one of this
    // lane's windows, so not found, never "another lane's".
  }
  fail(code::kWindowNotFound, "Window " + std::to_string(windowId) + " is not on lane " + lane.laneId + "'s screen.");
}

// Window management without the pointer. On the private seat the session is
// the lane's own, so focus really activates the window there. On the shared
// seat nothing may take the user's foreground: focus only raises the parked
// window inside the lane's area (what the lane's view and capture show).
Json Engine::windowCommand(const std::string& op, const Json& req) {
  auto lane = requireLane(requireString(req, "laneId"));
  const int64_t windowId = requireInt(req, "windowId");
  HWND hwnd = requireLaneWindow(*lane, windowId);
  Json out = Json::Object{{"windowId", windowId}};
  if (op == "window.focus") {
    if (IsIconic(hwnd)) ShowWindow(hwnd, mode_ == Mode::Private ? SW_RESTORE : SW_SHOWNOACTIVATE);
    bool focused;
    if (mode_ == Mode::Private) {
      focused = forceForeground(hwnd) && currentForeground() == hwnd;
      if (!focused) fail(code::kNoWindow, "Windows did not bring window " + std::to_string(windowId) + " to the front.");
    } else {
      focused = SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) != FALSE;
    }
    out["focused"] = focused;
  } else if (op == "window.minimize") {
    ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
    out["minimized"] = IsIconic(hwnd) != FALSE;
  } else {
    // WM_CLOSE asks; it never forces. An app with unsaved work may answer
    // with its own prompt, which then shows on the lane's screen.
    out["closed"] = closeWindowGracefully(hwnd, 2'000);
  }
  touch(*lane);
  return out;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

bool Engine::captureLane(Lane& lane, Frame& frame, HWND onlyWindow, std::string* error) {
  if (mode_ == Mode::Private && !onlyWindow) {
    return captureScreenRect(lane.area, frame, lane.cursorVisible, error);
  }
  if (onlyWindow) {
    const auto windows = laneWindows(lane);
    if (std::none_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == onlyWindow; })) {
      if (error) *error = "The requested window does not belong to this lane.";
      return false;
    }
    return captureWindow(onlyWindow, frame, error);
  }
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
  const auto owned = ownedForListing(*lane);
  for (auto& w : windows) wins.push(windowJson(w, lane.get(), &owned));
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
          std::set<DWORD> tree = it->pid ? ownedProcesses(*lane, it->pid) : std::set<DWORD>{};
          for (auto& w : all) {
            if (it->before.count(w.hwnd) || lane->origin.count(w.hwnd)) continue;
            bool owned = false;
            for (auto& other : lanes_) owned = owned || other.second->origin.count(w.hwnd);
            if (owned) continue;
            if (tree.count(w.pid)) {
              HWND user = currentForeground();
              parkWindow(*lane, w.hwnd, "ade_launched");
              rememberProcess(*lane, w.pid, it->pid);
              if (user && currentForeground() != user) forceForeground(user);
            }
          }
          ++it;
        }
        // Forget windows that closed.
        for (auto it = lane->origin.begin(); it != lane->origin.end();) {
          if (!IsWindow(it->first)) {
            if (parked_) parked_->remove(it->first);
            lane->home.erase(it->first);
            it = lane->origin.erase(it);
          } else {
            ++it;
          }
        }
      }
      auto windows = laneWindows(*lane);
      const auto owned = ownedForListing(*lane);
      std::string sig;
      for (auto& w : windows) {
        sig += std::to_string(windowIdOf(w.hwnd)) + ":" + narrow(w.title) + ":" + std::to_string(w.minimized) + ":" +
               std::to_string(owned.count(w.pid)) + ";";
      }
      if (sig != lane->windowsSignature) {
        lane->windowsSignature = sig;
        Json list = Json::array();
        for (auto& w : windows) list.push(windowJson(w, lane.get(), &owned));
        emit_(eventLine("windows-changed", Json::Object{{"laneId", lane->laneId}, {"windows", list}}));
      }
    }
  }
  CoUninitialize();
}

}  // namespace ade
