#include "uia.h"

#include <algorithm>
#include <cstdio>

using Microsoft::WRL::ComPtr;

namespace ade {

namespace {

constexpr int kObservationsPerLane = 6;

std::string bstrToUtf8(BSTR b) {
  if (!b) return "";
  return narrow(std::wstring(b, SysStringLen(b)));
}

std::string cachedString(IUIAutomationElement* e, PROPERTYID id) {
  VARIANT v;
  VariantInit(&v);
  std::string out;
  if (SUCCEEDED(e->GetCachedPropertyValue(id, &v)) && v.vt == VT_BSTR) out = bstrToUtf8(v.bstrVal);
  VariantClear(&v);
  return out;
}

bool cachedBool(IUIAutomationElement* e, PROPERTYID id) {
  VARIANT v;
  VariantInit(&v);
  bool out = false;
  if (SUCCEEDED(e->GetCachedPropertyValue(id, &v)) && v.vt == VT_BOOL) out = v.boolVal == VARIANT_TRUE;
  VariantClear(&v);
  return out;
}

int cachedInt(IUIAutomationElement* e, PROPERTYID id) {
  VARIANT v;
  VariantInit(&v);
  int out = 0;
  if (SUCCEEDED(e->GetCachedPropertyValue(id, &v)) && v.vt == VT_I4) out = v.lVal;
  VariantClear(&v);
  return out;
}

const char* roleName(int controlType) {
  switch (controlType) {
    case UIA_ButtonControlTypeId: return "Button";
    case UIA_CalendarControlTypeId: return "Calendar";
    case UIA_CheckBoxControlTypeId: return "CheckBox";
    case UIA_ComboBoxControlTypeId: return "ComboBox";
    case UIA_EditControlTypeId: return "Edit";
    case UIA_HyperlinkControlTypeId: return "Hyperlink";
    case UIA_ImageControlTypeId: return "Image";
    case UIA_ListItemControlTypeId: return "ListItem";
    case UIA_ListControlTypeId: return "List";
    case UIA_MenuControlTypeId: return "Menu";
    case UIA_MenuBarControlTypeId: return "MenuBar";
    case UIA_MenuItemControlTypeId: return "MenuItem";
    case UIA_ProgressBarControlTypeId: return "ProgressBar";
    case UIA_RadioButtonControlTypeId: return "RadioButton";
    case UIA_ScrollBarControlTypeId: return "ScrollBar";
    case UIA_SliderControlTypeId: return "Slider";
    case UIA_SpinnerControlTypeId: return "Spinner";
    case UIA_StatusBarControlTypeId: return "StatusBar";
    case UIA_TabControlTypeId: return "Tab";
    case UIA_TabItemControlTypeId: return "TabItem";
    case UIA_TextControlTypeId: return "Text";
    case UIA_ToolBarControlTypeId: return "ToolBar";
    case UIA_ToolTipControlTypeId: return "ToolTip";
    case UIA_TreeControlTypeId: return "Tree";
    case UIA_TreeItemControlTypeId: return "TreeItem";
    case UIA_CustomControlTypeId: return "Custom";
    case UIA_GroupControlTypeId: return "Group";
    case UIA_ThumbControlTypeId: return "Thumb";
    case UIA_DataGridControlTypeId: return "DataGrid";
    case UIA_DataItemControlTypeId: return "DataItem";
    case UIA_DocumentControlTypeId: return "Document";
    case UIA_SplitButtonControlTypeId: return "SplitButton";
    case UIA_WindowControlTypeId: return "Window";
    case UIA_PaneControlTypeId: return "Pane";
    case UIA_HeaderControlTypeId: return "Header";
    case UIA_HeaderItemControlTypeId: return "HeaderItem";
    case UIA_TableControlTypeId: return "Table";
    case UIA_TitleBarControlTypeId: return "TitleBar";
    case UIA_SeparatorControlTypeId: return "Separator";
    case UIA_SemanticZoomControlTypeId: return "SemanticZoom";
    case UIA_AppBarControlTypeId: return "AppBar";
    default: return "Element";
  }
}

// Containers with no name and no action add nothing an agent can use; they
// are walked through but not listed, so the limit spends itself on controls.
bool isNoise(const UiaElement& e) {
  if (!e.actions.empty()) return false;
  if (!e.title.empty() || !e.value.empty()) return false;
  return e.role == "Pane" || e.role == "Group" || e.role == "Custom" || e.role == "Element" ||
         e.role == "Separator" || e.role == "Image";
}

}  // namespace

bool Uia::init(std::string* error) {
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia_));
  if (FAILED(hr)) hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia_));
  if (FAILED(hr)) {
    if (error) *error = "UI Automation is not available";
    return false;
  }
  ComPtr<IUIAutomation2> uia2;
  if (SUCCEEDED(uia_.As(&uia2))) {
    // An app that stopped answering must cost a bounded wait, not the request.
    uia2->put_ConnectionTimeout(2000);
    uia2->put_TransactionTimeout(4000);
  }
  uia_->CreateCacheRequest(&cache_);
  const PROPERTYID props[] = {UIA_ControlTypePropertyId,
                              UIA_NamePropertyId,
                              UIA_AutomationIdPropertyId,
                              UIA_BoundingRectanglePropertyId,
                              UIA_IsEnabledPropertyId,
                              UIA_HasKeyboardFocusPropertyId,
                              UIA_HelpTextPropertyId,
                              UIA_LocalizedControlTypePropertyId,
                              UIA_IsOffscreenPropertyId,
                              UIA_ProcessIdPropertyId,
                              UIA_IsInvokePatternAvailablePropertyId,
                              UIA_IsTogglePatternAvailablePropertyId,
                              UIA_IsValuePatternAvailablePropertyId,
                              UIA_IsSelectionItemPatternAvailablePropertyId,
                              UIA_IsExpandCollapsePatternAvailablePropertyId,
                              UIA_IsScrollPatternAvailablePropertyId,
                              UIA_ValueValuePropertyId,
                              UIA_ValueIsReadOnlyPropertyId};
  for (PROPERTYID p : props) cache_->AddProperty(p);
  cache_->put_TreeScope(TreeScope_Subtree);
  ComPtr<IUIAutomationCondition> control;
  uia_->get_ControlViewCondition(&control);
  cache_->put_TreeFilter(control.Get());
  cache_->put_AutomationElementMode(AutomationElementMode_Full);
  return true;
}

void Uia::walk(IUIAutomationElement* e, int parentIndex, HWND window, UiaObservation& obs, int limit,
               int64_t deadline, int depth) {
  if (depth > 60) return;
  if (nowMs() > deadline) {
    obs.truncated = true;
    if (obs.truncatedReason.empty()) obs.truncatedReason = "timeout";
    return;
  }
  UiaElement el;
  el.role = roleName(cachedInt(e, UIA_ControlTypePropertyId));
  el.subrole = cachedString(e, UIA_LocalizedControlTypePropertyId);
  el.title = cachedString(e, UIA_NamePropertyId);
  el.label = cachedString(e, UIA_HelpTextPropertyId);
  el.identifier = cachedString(e, UIA_AutomationIdPropertyId);
  el.enabled = cachedBool(e, UIA_IsEnabledPropertyId);
  el.focused = cachedBool(e, UIA_HasKeyboardFocusPropertyId);
  el.hasInvoke = cachedBool(e, UIA_IsInvokePatternAvailablePropertyId);
  el.hasToggle = cachedBool(e, UIA_IsTogglePatternAvailablePropertyId);
  el.hasValue = cachedBool(e, UIA_IsValuePatternAvailablePropertyId);
  el.hasSelect = cachedBool(e, UIA_IsSelectionItemPatternAvailablePropertyId);
  el.hasExpand = cachedBool(e, UIA_IsExpandCollapsePatternAvailablePropertyId);
  el.hasScroll = cachedBool(e, UIA_IsScrollPatternAvailablePropertyId);
  if (el.hasValue) {
    el.value = cachedString(e, UIA_ValueValuePropertyId);
    el.valueReadOnly = cachedBool(e, UIA_ValueIsReadOnlyPropertyId);
  }
  if (el.hasInvoke) el.actions.push_back("Invoke");
  if (el.hasToggle) el.actions.push_back("Toggle");
  if (el.hasSelect) el.actions.push_back("Select");
  if (el.hasExpand) el.actions.push_back("ExpandCollapse");
  if (el.hasValue && !el.valueReadOnly) el.actions.push_back("SetValue");
  if (el.hasScroll) el.actions.push_back("Scroll");
  e->get_CachedBoundingRectangle(&el.frame);
  el.pid = static_cast<DWORD>(cachedInt(e, UIA_ProcessIdPropertyId));
  el.window = window;
  el.element = e;

  bool offscreen = cachedBool(e, UIA_IsOffscreenPropertyId);
  bool hasSize = el.frame.right - el.frame.left > 0 && el.frame.bottom - el.frame.top > 0;
  int myIndex = parentIndex;
  if (hasSize && !offscreen && (depth == 0 || !isNoise(el))) {
    ++obs.elementCount;
    if (static_cast<int>(obs.elements.size()) < limit) {
      el.index = static_cast<int>(obs.elements.size());
      el.parentIndex = parentIndex;
      obs.elements.push_back(el);
      myIndex = el.index;
    } else {
      obs.truncated = true;
      if (obs.truncatedReason.empty()) obs.truncatedReason = "limit";
    }
  }
  ComPtr<IUIAutomationElementArray> children;
  if (FAILED(e->GetCachedChildren(&children)) || !children) return;
  int count = 0;
  children->get_Length(&count);
  for (int i = 0; i < count; ++i) {
    ComPtr<IUIAutomationElement> child;
    if (SUCCEEDED(children->GetElement(i, &child)) && child) {
      walk(child.Get(), myIndex, window, obs, limit, deadline, depth + 1);
    }
  }
}

UiaObservation Uia::observe(const std::vector<WinInfo>& windows, int limit, int budgetMs) {
  static std::atomic<uint32_t> counter{0};
  UiaObservation obs;
  char id[48];
  std::snprintf(id, sizeof(id), "w%lx%x", static_cast<unsigned long>(GetTickCount()), ++counter);
  obs.id = id;
  int64_t start = nowMs();
  int64_t deadline = start + budgetMs;
  for (const auto& w : windows) {
    if (w.minimized) continue;
    ComPtr<IUIAutomationElement> root;
    if (FAILED(uia_->ElementFromHandle(w.hwnd, &root)) || !root) continue;
    ComPtr<IUIAutomationElement> cached;
    int64_t before = nowMs();
    HRESULT hr = root->BuildUpdatedCache(cache_.Get(), &cached);
    if (FAILED(hr) || !cached) {
      // UIA_E_TIMEOUT or a dead provider: this app did not answer.
      obs.stalledApps.push_back(narrow(w.appName));
      obs.truncated = true;
      if (obs.truncatedReason.empty() || obs.truncatedReason == "limit") obs.truncatedReason = "stalled";
      continue;
    }
    if (nowMs() - before > 3000) obs.stalledApps.push_back(narrow(w.appName));
    walk(cached.Get(), -1, w.hwnd, obs, limit, deadline, 0);
    if (nowMs() > deadline) break;
  }
  obs.walkMs = static_cast<int>(nowMs() - start);
  return obs;
}

void Uia::remember(const std::string& laneId, const UiaObservation& obs) {
  std::lock_guard<std::mutex> lock(mutex_);
  byId_[obs.id] = obs;
  auto& ids = byLane_[laneId];
  ids.push_back(obs.id);
  while (ids.size() > kObservationsPerLane) {
    byId_.erase(ids.front());
    ids.pop_front();
  }
}

void Uia::forgetLane(const std::string& laneId) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = byLane_.find(laneId);
  if (it == byLane_.end()) return;
  for (const auto& id : it->second) byId_.erase(id);
  byLane_.erase(it);
}

std::string Uia::makeHandle(const std::string& obsId, int index) {
  return "obs-" + obsId + ":e:" + std::to_string(index);
}

bool Uia::matches(const UiaElement& e, const std::string& needle) {
  return lowerA(e.title).find(needle) != std::string::npos || lowerA(e.label).find(needle) != std::string::npos ||
         lowerA(e.value).find(needle) != std::string::npos || lowerA(e.identifier) == needle;
}

UiaElement Uia::resolveHandle(const std::string& laneId, const std::string& handle) {
  if (handle.rfind("obs-", 0) != 0) {
    fail(code::kInvalidArgument, "\"" + handle + "\" is not an element handle. Handles look like obs-<id>:e:<n>.");
  }
  size_t sep = handle.rfind(":e:");
  if (sep == std::string::npos) fail(code::kInvalidArgument, "\"" + handle + "\" is not an element handle.");
  std::string obsId = handle.substr(4, sep - 4);
  const auto digits = handle.substr(sep + 3);
  if (digits.empty() || digits.size() > 9 || digits.find_first_not_of("0123456789") != std::string::npos) fail(code::kInvalidArgument, "Invalid element index.");
  int index = std::stoi(digits);
  std::lock_guard<std::mutex> lock(mutex_);
  auto lane = byLane_.find(laneId);
  if (lane == byLane_.end() || std::find(lane->second.begin(), lane->second.end(), obsId) == lane->second.end()) {
    fail(code::kHandleExpired, "That handle does not belong to this lane. Observe this lane again.");
  }
  auto it = byId_.find(obsId);
  if (it == byId_.end() || index < 0 || index >= static_cast<int>(it->second.elements.size())) {
    fail(code::kHandleExpired, "Handle " + handle + " is from an old observation. Observe again and use a new handle.");
  }
  return it->second.elements[index];
}

UiaElement Uia::resolveText(const std::string& laneId, const std::string& text) {
  std::string needle = lowerA(text);
  std::lock_guard<std::mutex> lock(mutex_);
  auto lane = byLane_.find(laneId);
  if (lane == byLane_.end() || lane->second.empty()) {
    fail(code::kHandleExpired, "Nothing observed on this lane yet. Observe first.");
  }
  const auto& obs = byId_[lane->second.back()];
  // Prefer an exact title match, then an actionable element, then any.
  const UiaElement* best = nullptr;
  for (const auto& e : obs.elements) {
    if (lowerA(e.title) == needle && !e.actions.empty()) return e;
  }
  for (const auto& e : obs.elements) {
    if (!matches(e, needle)) continue;
    if (!best || (best->actions.empty() && !e.actions.empty())) best = &e;
  }
  if (!best) fail(code::kWindowNotFound, "No element matches \"" + text + "\". Observe again.");
  return *best;
}

bool Uia::newestFocused(const std::string& laneId, UiaElement& out, HWND preferWindow) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto lane = byLane_.find(laneId);
  if (lane == byLane_.end() || lane->second.empty()) return false;
  const auto& elements = byId_[lane->second.back()].elements;
  const UiaElement* first = nullptr;
  for (const auto& e : elements) {
    if (!e.focused) continue;
    if (preferWindow && e.window == preferWindow) { out = e; return true; }
    if (!first) first = &e;
  }
  if (!first) return false;
  out = *first;
  return true;
}

bool Uia::invoke(const UiaElement& e) {
  if (!e.element) return false;
  if (e.hasInvoke) {
    ComPtr<IUIAutomationInvokePattern> p;
    if (SUCCEEDED(e.element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&p))) && p &&
        SUCCEEDED(p->Invoke())) {
      return true;
    }
  }
  if (e.hasToggle) {
    ComPtr<IUIAutomationTogglePattern> p;
    if (SUCCEEDED(e.element->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(&p))) && p &&
        SUCCEEDED(p->Toggle())) {
      return true;
    }
  }
  if (e.hasSelect) {
    ComPtr<IUIAutomationSelectionItemPattern> p;
    if (SUCCEEDED(e.element->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(&p))) && p &&
        SUCCEEDED(p->Select())) {
      return true;
    }
  }
  if (e.hasExpand) {
    ComPtr<IUIAutomationExpandCollapsePattern> p;
    if (SUCCEEDED(e.element->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, IID_PPV_ARGS(&p))) && p) {
      ExpandCollapseState state = ExpandCollapseState_Collapsed;
      p->get_CurrentExpandCollapseState(&state);
      HRESULT hr = state == ExpandCollapseState_Expanded ? p->Collapse() : p->Expand();
      if (SUCCEEDED(hr)) return true;
    }
  }
  return false;
}

bool Uia::setValue(const UiaElement& e, const std::wstring& value) {
  if (!e.element || !e.hasValue) return false;
  ComPtr<IUIAutomationValuePattern> p;
  if (FAILED(e.element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&p))) || !p) return false;
  BSTR b = SysAllocStringLen(value.data(), static_cast<UINT>(value.size()));
  HRESULT hr = p->SetValue(b);
  SysFreeString(b);
  return SUCCEEDED(hr);
}

bool Uia::appendValue(const UiaElement& e, const std::wstring& text, bool clear) {
  if (!e.element || !e.hasValue) return false;
  ComPtr<IUIAutomationValuePattern> p;
  if (FAILED(e.element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&p))) || !p) return false;
  std::wstring next = text;
  if (!clear) {
    BSTR current = nullptr;
    if (SUCCEEDED(p->get_CurrentValue(&current)) && current) {
      next = std::wstring(current, SysStringLen(current)) + text;
      SysFreeString(current);
    }
  }
  BSTR b = SysAllocStringLen(next.data(), static_cast<UINT>(next.size()));
  HRESULT hr = p->SetValue(b);
  SysFreeString(b);
  return SUCCEEDED(hr);
}

bool Uia::focus(const UiaElement& e) { return e.element && SUCCEEDED(e.element->SetFocus()); }

bool Uia::scroll(const UiaElement& e, const std::string& direction, int amount) {
  if (!e.element || !e.hasScroll) return false;
  ComPtr<IUIAutomationScrollPattern> p;
  if (FAILED(e.element->GetCurrentPatternAs(UIA_ScrollPatternId, IID_PPV_ARGS(&p))) || !p) return false;
  ScrollAmount h = ScrollAmount_NoAmount, v = ScrollAmount_NoAmount;
  ScrollAmount step = amount >= 5 ? (direction == "up" || direction == "left" ? ScrollAmount_LargeDecrement
                                                                               : ScrollAmount_LargeIncrement)
                                  : (direction == "up" || direction == "left" ? ScrollAmount_SmallDecrement
                                                                               : ScrollAmount_SmallIncrement);
  if (direction == "left" || direction == "right") h = step;
  else v = step;
  int times = amount >= 5 ? std::max(1, amount / 5) : std::max(1, amount);
  for (int i = 0; i < times; ++i) {
    if (FAILED(p->Scroll(h, v))) return i > 0;
  }
  return true;
}

bool Uia::closeWindow(HWND hwnd) {
  ComPtr<IUIAutomationElement> root;
  if (FAILED(uia_->ElementFromHandle(hwnd, &root)) || !root) return false;
  ComPtr<IUIAutomationWindowPattern> p;
  if (FAILED(root->GetCurrentPatternAs(UIA_WindowPatternId, IID_PPV_ARGS(&p))) || !p) return false;
  return SUCCEEDED(p->Close());
}

Json elementJson(const UiaElement& e, const std::string& obsId) {
  Json j = Json::object();
  j["index"] = e.index;
  j["handle"] = Uia::makeHandle(obsId, e.index);
  j["role"] = e.role;
  j["subrole"] = e.subrole.empty() ? Json() : Json(e.subrole);
  j["title"] = e.title.empty() ? Json() : Json(e.title);
  j["label"] = e.label.empty() ? Json() : Json(e.label);
  j["value"] = e.value.empty() ? Json() : Json(e.value);
  j["identifier"] = e.identifier.empty() ? Json() : Json(e.identifier);
  j["help"] = Json();
  j["enabled"] = e.enabled;
  j["focused"] = e.focused;
  Json actions = Json::array();
  for (const auto& a : e.actions) actions.push(a);
  j["actions"] = actions;
  Json frame = Json::object();
  frame["x"] = static_cast<int>(e.frame.left);
  frame["y"] = static_cast<int>(e.frame.top);
  frame["width"] = static_cast<int>(e.frame.right - e.frame.left);
  frame["height"] = static_cast<int>(e.frame.bottom - e.frame.top);
  j["frame"] = frame;
  Json center = Json::object();
  center["x"] = static_cast<int>((e.frame.left + e.frame.right) / 2);
  center["y"] = static_cast<int>((e.frame.top + e.frame.bottom) / 2);
  j["center"] = center;
  j["windowId"] = static_cast<int64_t>(reinterpret_cast<uintptr_t>(e.window) & 0xFFFFFFFF);
  j["pid"] = static_cast<int64_t>(e.pid);
  j["parentIndex"] = e.parentIndex < 0 ? Json() : Json(e.parentIndex);
  return j;
}

}  // namespace ade
