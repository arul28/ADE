// UI Automation: the element walk behind `observe`, and element actions.
//
// One walk per window, cached in bulk (one cross-process round trip for the
// whole subtree), with bounded connection and transaction timeouts so an app
// that stopped answering costs seconds, not the request. Handles use the
// macOS driver's format, `obs-<observationId>:e:<index>`, and stay valid only
// for their own observation.

#pragma once

#include "common.h"
#include "desk.h"

#include <ole2.h>
#include <uiautomation.h>
#include <wrl/client.h>

#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace ade {

struct UiaElement {
  int index = 0;
  Microsoft::WRL::ComPtr<IUIAutomationElement> element;
  std::string role;
  std::string subrole;  // localized control type
  std::string title;    // Name
  std::string label;    // HelpText or ItemStatus when Name is empty
  std::string value;
  std::string identifier;  // AutomationId
  bool enabled = true;
  bool focused = false;
  std::vector<std::string> actions;
  RECT frame = {};
  HWND window = nullptr;
  DWORD pid = 0;
  int parentIndex = -1;
  bool hasInvoke = false, hasToggle = false, hasValue = false, hasSelect = false, hasExpand = false,
       hasScroll = false, valueReadOnly = true;
};

struct UiaObservation {
  std::string id;
  std::vector<UiaElement> elements;
  int elementCount = 0;
  bool truncated = false;
  std::string truncatedReason;  // "", "limit", "timeout", "stalled"
  std::vector<std::string> stalledApps;
  int walkMs = 0;
};

class Uia {
 public:
  // Must run on a thread with COM initialized (MTA recommended).
  bool init(std::string* error);
  UiaObservation observe(const std::vector<WinInfo>& windows, int limit, int budgetMs);
  // Stores the observation for later handle lookups. Keeps the last few.
  void remember(const std::string& laneId, const UiaObservation& obs);
  void forgetLane(const std::string& laneId);

  // Resolves a handle, or throws `MAC_DESKTOP_HANDLE_EXPIRED`.
  UiaElement resolveHandle(const std::string& laneId, const std::string& handle);
  // Resolves a case-insensitive text match in the lane's newest observation.
  UiaElement resolveText(const std::string& laneId, const std::string& text);
  // The focused element of the newest observation, if any.
  bool newestFocused(const std::string& laneId, UiaElement& out);

  // Actions. Each returns false when the element has no pattern for it.
  bool invoke(const UiaElement& e);
  bool setValue(const UiaElement& e, const std::wstring& value);
  bool appendValue(const UiaElement& e, const std::wstring& text, bool clear);
  bool focus(const UiaElement& e);
  bool scroll(const UiaElement& e, const std::string& direction, int amount);
  bool closeWindow(HWND hwnd);

  static std::string makeHandle(const std::string& obsId, int index);
  static bool matches(const UiaElement& e, const std::string& needleLower);

 private:
  void walk(IUIAutomationElement* cached, int parentIndex, HWND window, UiaObservation& obs, int limit,
            int64_t deadline, int depth);
  Microsoft::WRL::ComPtr<IUIAutomation> uia_;
  Microsoft::WRL::ComPtr<IUIAutomationCacheRequest> cache_;
  std::mutex mutex_;
  std::map<std::string, UiaObservation> byId_;
  std::map<std::string, std::deque<std::string>> byLane_;
};

Json elementJson(const UiaElement& e, const std::string& obsId);

}  // namespace ade
