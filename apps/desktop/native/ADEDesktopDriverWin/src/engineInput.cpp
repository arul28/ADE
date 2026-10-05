#include "engineLane.h"
#include <algorithm>

namespace ade {
namespace {
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


POINT centerOf(const RECT& r) { return POINT{(r.left + r.right) / 2, (r.top + r.bottom) / 2}; }

bool inRect(const RECT& r, POINT p) { return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom; }

// The private seat is the lane's own session: acting on a window there first
// brings it in front of the lane's other windows, as a person's click would.
void raiseOnPrivateSeat(HWND window) {
  if (!window || !IsWindow(window)) return;
  HWND top = GetAncestor(window, GA_ROOT);
  if (!top) top = window;
  if (IsIconic(top)) ShowWindow(top, SW_RESTORE);
  if (GetForegroundWindow() != top) forceForeground(top);
}
}

// A lane window named by the payload's `windowId`, or null.
static HWND payloadWindow(const std::vector<WinInfo>& windows, const Json& payload) {
  if (!payload["windowId"].isNumber()) return nullptr;
  HWND want = hwndFromId(payload["windowId"].asInt());
  for (const auto& w : windows) if (w.hwnd == want) return want;
  fail(code::kWindowNotFound, "Window " + std::to_string(payload["windowId"].asInt()) + " is not on this lane's screen.");
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
    if (priv) raiseOnPrivateSeat(e.window);
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
    const bool canonicalText = payload["typeText"].isString();
    const std::wstring text = widen(canonicalText ? payload["typeText"].str() : payload["text"].str());
    bool clear = payload["clear"].asBool();
    UiaElement e;
    bool haveTarget = false;
    if (payload["target"].isObject() && hasTarget(payload["target"])) {
      e = resolveTarget(lane.laneId, payload["target"]);
      haveTarget = true;
    } else if (!payload["handle"].str().empty() || (canonicalText && !payload["text"].str().empty())) {
      e = resolveTarget(lane.laneId, payload);
      haveTarget = true;
    } else if (HWND named = payloadWindow(laneWindows(lane), payload)) {
      // `--window` without an element: type into that window's focused control.
      if (priv) raiseOnPrivateSeat(named);
      auto observation = uia_.observe(std::vector<WinInfo>{[&] { WinInfo w; describeWindow(named, w); return w; }()}, 400, 1500);
      uia_.remember(lane.laneId, observation);
      haveTarget = uia_.newestFocused(lane.laneId, e);
      if (!haveTarget && priv) {
        if (!forceForeground(named) || currentForeground() != named) fail(code::kNoWindow, "Windows could not focus that window; no text was sent.");
        if (clear && !sendKeys("a", {"ctrl"})) failLocked();
        if (!sendText(text)) failLocked();
        return out;
      }
    } else {
      // Focus may have moved since observe (for example after closing a dialog).
      // Never reuse the previous observation's focused element for typing.
      auto observation = uia_.observe(laneWindows(lane), 400, 1500);
      uia_.remember(lane.laneId, observation);
      // The window in front is where a person's typing goes. A console
      // window reports itself focused even behind another window, and was
      // picked (and raised) over the Notepad the agent had just clicked.
      haveTarget = uia_.newestFocused(lane.laneId, e, priv ? currentForeground() : nullptr);
    }
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
    if (!window) window = payloadWindow(windows, payload);
    if (!window && priv) {
      // The lane's own foreground window, not whichever window lists first.
      HWND fg = currentForeground();
      if (std::any_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == fg; })) window = fg;
    }
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
    HWND scrollWindow = payloadWindow(windows, payload);
    if (!scrollWindow) scrollWindow = windows.front().hwnd;
    RECT frame = windows.front().frame;
    for (const auto& w : windows) if (w.hwnd == scrollWindow) frame = w.frame;
    POINT c = centerOf(frame);
    if (priv) {
      raiseOnPrivateSeat(scrollWindow);
      if (!sendScroll(c.x, c.y, direction, amount)) failLocked();
    } else {
      postScroll(scrollWindow, c.x, c.y, direction, amount);
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
      UiaElement e = resolveTarget(lane.laneId, payload[key].isObject() ? payload[key] : payload);
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
    UiaElement element;
    bool explicitTarget = !payload["handle"].str().empty() || payload["target"].isObject() ||
        (!payload["text"].str().empty() && (command == "press" || payload["typeText"].isString()));
    if (explicitTarget) element = resolveTarget(lane.laneId, payload);
    HWND target = explicitTarget ? element.window : nullptr;
    if (!target) target = payloadWindow(windows, payload);
    if (!target) target = currentForeground();
    if (std::none_of(windows.begin(), windows.end(), [&](const WinInfo& w) { return w.hwnd == target; }))
      target = windows.empty() ? nullptr : windows.front().hwnd;
    HWND user = priv ? nullptr : currentForeground();
    if (!target) fail(code::kNoWindow, "This lane has no window to receive input.");
    if (!forceForeground(target) || currentForeground() != target) fail(code::kNoWindow, "Windows could not focus this lane window; no input was sent.");
    if (explicitTarget) {
      if (!uia_.focus(element)) fail(code::kHandleExpired, "The input target is no longer available. Observe again.");
      out["resolvedIndex"] = element.index;
    }
    if (command == "press") {
      ok = sendKeys(payload["key"].str(), stringList(payload["modifiers"]));
    } else {
      if (payload["clear"].asBool() && !sendKeys("a", {"ctrl"})) failLocked();
      ok = sendText(widen(payload["typeText"].isString() ? payload["typeText"].str() : payload["text"].str()));
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
  const auto holder = requireString(req, "holderId");
  const Json& exp = req["expiresAt"];
  int64_t expiry = 0;
  if (exp.isNumber()) expiry = exp.asInt();
  else if (exp.isString()) {
    const auto value = exp.str();
    // The canonical boundary sends Date.toISOString(), with millisecond UTC.
    if (value.size() != 24 || value[4] != '-' || value[7] != '-' || value[10] != 'T' ||
        value[13] != ':' || value[16] != ':' || value[19] != '.' || value[23] != 'Z')
      fail(code::kInvalidArgument, "expiresAt must be a UTC timestamp.");
    for (size_t i = 0; i < value.size(); ++i) if (i != 4 && i != 7 && i != 10 && i != 13 && i != 16 && i != 19 && i != 23 && (value[i] < '0' || value[i] > '9'))
      fail(code::kInvalidArgument, "expiresAt must be a UTC timestamp.");
    SYSTEMTIME time = {};
    time.wYear = static_cast<WORD>(std::stoi(value.substr(0, 4)));
    time.wMonth = static_cast<WORD>(std::stoi(value.substr(5, 2)));
    time.wDay = static_cast<WORD>(std::stoi(value.substr(8, 2)));
    time.wHour = static_cast<WORD>(std::stoi(value.substr(11, 2)));
    time.wMinute = static_cast<WORD>(std::stoi(value.substr(14, 2)));
    time.wSecond = static_cast<WORD>(std::stoi(value.substr(17, 2)));
    time.wMilliseconds = static_cast<WORD>(std::stoi(value.substr(20, 3)));
    FILETIME file;
    if (!SystemTimeToFileTime(&time, &file)) fail(code::kInvalidArgument, "expiresAt is not a valid timestamp.");
    ULARGE_INTEGER ticks; ticks.LowPart = file.dwLowDateTime; ticks.HighPart = file.dwHighDateTime;
    if (ticks.QuadPart < 116444736000000000ULL) fail(code::kInputLeaseRequired, "The input lease already expired.");
    expiry = static_cast<int64_t>((ticks.QuadPart - 116444736000000000ULL) / 10000);
  } else fail(code::kInvalidArgument, "expiresAt is required.");
  FILETIME file; GetSystemTimeAsFileTime(&file);
  ULARGE_INTEGER ticks; ticks.LowPart = file.dwLowDateTime; ticks.HighPart = file.dwHighDateTime;
  const auto epochMs = static_cast<int64_t>((ticks.QuadPart - 116444736000000000ULL) / 10000);
  if (expiry <= epochMs) fail(code::kInputLeaseRequired, "The input lease already expired.");
  lane->leaseHolder = holder;
  lane->leaseExpiresMs = nowMs() + std::min<int64_t>(expiry - epochMs, 60'000);
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


}  // namespace ade
