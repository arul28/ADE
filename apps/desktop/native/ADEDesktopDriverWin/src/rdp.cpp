#include "rdp.h"

#include <ocidl.h>
#include <ole2.h>
#include <olectl.h>
#include <wtsapi32.h>

#include <cstdio>

namespace ade {

// The one vtable interface the control needs outside IDispatch. Declared by
// hand: the SDK has no mstsax.h. IID and method order from mstsax.idl.
MIDL_INTERFACE("302D8188-0052-4807-806A-362B628F9AC5")
IMsRdpExtendedSettings : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE put_Property(BSTR name, VARIANT* value) = 0;
  virtual HRESULT STDMETHODCALLTYPE get_Property(BSTR name, VARIANT* value) = 0;
};

// The first method of the documented non-scriptable interface. Credentials
// cannot be set through IDispatch and cannot be read back from this property.
MIDL_INTERFACE("c1e6743a-41c1-4a74-832a-0dd06c1c7a0e")
IMsTscNonScriptable : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE put_ClearTextPassword(BSTR password) = 0;
};

namespace {

// MsRdpClient9NotSafeForScripting, the client the spike used.
const CLSID kRdpClsid = {0x8B918B82, 0x7985, 0x4C24, {0x89, 0xDF, 0xC3, 0x3A, 0xD2, 0xBB, 0xFB, 0xCD}};

HRESULT dispId(IDispatch* d, const wchar_t* name, DISPID* id) {
  LPOLESTR n = const_cast<LPOLESTR>(name);
  return d->GetIDsOfNames(IID_NULL, &n, 1, LOCALE_USER_DEFAULT, id);
}

HRESULT dispPut(IDispatch* d, const wchar_t* name, VARIANT value) {
  DISPID id;
  HRESULT hr = dispId(d, name, &id);
  if (FAILED(hr)) return hr;
  DISPID put = DISPID_PROPERTYPUT;
  DISPPARAMS params = {&value, &put, 1, 1};
  return d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYPUT, &params, nullptr, nullptr, nullptr);
}

HRESULT dispGet(IDispatch* d, const wchar_t* name, VARIANT* out) {
  VariantInit(out);
  DISPID id;
  HRESULT hr = dispId(d, name, &id);
  if (FAILED(hr)) return hr;
  DISPPARAMS none = {nullptr, nullptr, 0, 0};
  VariantInit(out);
  return d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYGET, &none, out, nullptr, nullptr);
}

// Non-scriptable properties cannot use the control's IDispatch. Its own
// type library supplies the verified vtable layout to ITypeInfo::Invoke.
HRESULT nativePromptPolicy(IOleObject* control, bool allow) {
  const IID iid = {0x4f6996d5, 0xd7b1, 0x412c, {0xb0, 0xff, 0x06, 0x37, 0x18, 0x56, 0x69, 0x07}};
  IUnknown* native = nullptr;
  IProvideClassInfo* provider = nullptr;
  ITypeInfo* classInfo = nullptr; ITypeInfo* info = nullptr;
  ITypeLib* library = nullptr; UINT index = 0;
  HRESULT hr = control->QueryInterface(iid, reinterpret_cast<void**>(&native));
  if (SUCCEEDED(hr)) hr = control->QueryInterface(IID_IProvideClassInfo, reinterpret_cast<void**>(&provider));
  if (SUCCEEDED(hr)) hr = provider->GetClassInfo(&classInfo);
  if (SUCCEEDED(hr)) hr = classInfo->GetContainingTypeLib(&library, &index);
  if (SUCCEEDED(hr)) hr = library->GetTypeInfoOfGuid(iid, &info);
  LPOLESTR name = const_cast<LPOLESTR>(L"AllowPromptingForCredentials"); DISPID id;
  if (SUCCEEDED(hr)) hr = info->GetIDsOfNames(&name, 1, &id);
  if (SUCCEEDED(hr)) {
    VARIANT value; VariantInit(&value); value.vt = VT_BOOL; value.boolVal = allow ? VARIANT_TRUE : VARIANT_FALSE;
    DISPID put = DISPID_PROPERTYPUT; DISPPARAMS params{&value, &put, 1, 1};
    hr = info->Invoke(native, id, DISPATCH_PROPERTYPUT, &params, nullptr, nullptr, nullptr);
  }
  if (info) info->Release(); if (library) library->Release();
  if (classInfo) classInfo->Release(); if (provider) provider->Release(); if (native) native->Release();
  return hr;
}

HRESULT dispCall(IDispatch* d, const wchar_t* name) {
  DISPID id;
  HRESULT hr = dispId(d, name, &id);
  if (FAILED(hr)) return hr;
  DISPPARAMS none = {nullptr, nullptr, 0, 0};
  return d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_METHOD, &none, nullptr, nullptr, nullptr);
}

VARIANT vBstr(const wchar_t* s) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BSTR;
  v.bstrVal = SysAllocString(s);
  return v;
}
VARIANT vBool(bool b) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BOOL;
  v.boolVal = b ? VARIANT_TRUE : VARIANT_FALSE;
  return v;
}
VARIANT vLong(long l) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_I4;
  v.lVal = l;
  return v;
}

std::string hrString(const char* what, HRESULT hr) {
  char buf[128];
  std::snprintf(buf, sizeof(buf), "%s (hr=0x%08lx)", what, static_cast<unsigned long>(hr));
  return buf;
}

// The OLE site. One object answers every container interface the control
// asks for; the control needs a window and a frame, nothing more.
class Site : public IOleClientSite, public IOleInPlaceSite, public IOleInPlaceFrame, public IDispatch {
 public:
  explicit Site(HWND hwnd) : hwnd_(hwnd) {}

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (riid == IID_IUnknown || riid == IID_IOleClientSite) *out = static_cast<IOleClientSite*>(this);
    else if (riid == IID_IOleWindow || riid == IID_IOleInPlaceSite) *out = static_cast<IOleInPlaceSite*>(this);
    else if (riid == IID_IOleInPlaceUIWindow || riid == IID_IOleInPlaceFrame)
      *out = static_cast<IOleInPlaceFrame*>(this);
    else if (riid == IID_IDispatch) *out = static_cast<IDispatch*>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }

  // IOleClientSite
  STDMETHODIMP SaveObject() override { return E_NOTIMPL; }
  STDMETHODIMP GetMoniker(DWORD, DWORD, IMoniker**) override { return E_NOTIMPL; }
  STDMETHODIMP GetContainer(IOleContainer** c) override {
    if (c) *c = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP ShowObject() override { return S_OK; }
  STDMETHODIMP OnShowWindow(BOOL) override { return S_OK; }
  STDMETHODIMP RequestNewObjectLayout() override { return E_NOTIMPL; }

  // IOleWindow, shared by the in-place site and the frame.
  STDMETHODIMP GetWindow(HWND* w) override {
    *w = hwnd_;
    return S_OK;
  }
  STDMETHODIMP ContextSensitiveHelp(BOOL) override { return E_NOTIMPL; }

  // IOleInPlaceSite
  STDMETHODIMP CanInPlaceActivate() override { return S_OK; }
  STDMETHODIMP OnInPlaceActivate() override { return S_OK; }
  STDMETHODIMP OnUIActivate() override { return S_OK; }
  STDMETHODIMP GetWindowContext(IOleInPlaceFrame** frame, IOleInPlaceUIWindow** doc, LPRECT pos, LPRECT clip,
                                LPOLEINPLACEFRAMEINFO info) override {
    *frame = static_cast<IOleInPlaceFrame*>(this);
    AddRef();
    *doc = nullptr;
    GetClientRect(hwnd_, pos);
    GetClientRect(hwnd_, clip);
    info->fMDIApp = FALSE;
    info->hwndFrame = hwnd_;
    info->haccel = nullptr;
    info->cAccelEntries = 0;
    return S_OK;
  }
  STDMETHODIMP Scroll(SIZE) override { return E_NOTIMPL; }
  STDMETHODIMP OnUIDeactivate(BOOL) override { return S_OK; }
  STDMETHODIMP OnInPlaceDeactivate() override { return S_OK; }
  STDMETHODIMP DiscardUndoState() override { return S_OK; }
  STDMETHODIMP DeactivateAndUndo() override { return S_OK; }
  STDMETHODIMP OnPosRectChange(LPCRECT) override { return S_OK; }

  // IOleInPlaceUIWindow / IOleInPlaceFrame
  STDMETHODIMP GetBorder(LPRECT) override { return E_NOTIMPL; }
  STDMETHODIMP RequestBorderSpace(LPCBORDERWIDTHS) override { return E_NOTIMPL; }
  STDMETHODIMP SetBorderSpace(LPCBORDERWIDTHS) override { return E_NOTIMPL; }
  STDMETHODIMP SetActiveObject(IOleInPlaceActiveObject*, LPCOLESTR) override { return S_OK; }
  STDMETHODIMP InsertMenus(HMENU, LPOLEMENUGROUPWIDTHS) override { return E_NOTIMPL; }
  STDMETHODIMP SetMenu(HMENU, HOLEMENU, HWND) override { return S_OK; }
  STDMETHODIMP RemoveMenus(HMENU) override { return E_NOTIMPL; }
  STDMETHODIMP SetStatusText(LPCOLESTR) override { return S_OK; }
  STDMETHODIMP EnableModeless(BOOL) override { return S_OK; }
  STDMETHODIMP TranslateAccelerator(LPMSG, WORD) override { return S_FALSE; }

  // IDispatch: ambient properties. None offered; the control uses defaults.
  STDMETHODIMP GetTypeInfoCount(UINT* n) override {
    *n = 0;
    return S_OK;
  }
  STDMETHODIMP GetTypeInfo(UINT, LCID, ITypeInfo**) override { return E_NOTIMPL; }
  STDMETHODIMP GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(DISPID, REFIID, LCID, WORD, DISPPARAMS*, VARIANT*, EXCEPINFO*, UINT*) override {
    return DISP_E_MEMBERNOTFOUND;
  }

 private:
  virtual ~Site() = default;
  LONG refs_ = 1;
  HWND hwnd_;
};

// The event sink. DISPIDs are looked up by name in the control's own type
// information, so this does not depend on remembered numbers.
class Sink : public IDispatch {
 public:
  Sink(RdpSession* owner, IID events) : owner_(owner), events_(events) {}

  void resolve(ITypeInfo* info) {
    auto look = [&](const wchar_t* name) -> DISPID {
      DISPID id = DISPID_UNKNOWN;
      LPOLESTR n = const_cast<LPOLESTR>(name);
      if (info) info->GetIDsOfNames(&n, 1, &id);
      return id;
    };
    loginComplete_ = look(L"OnLoginComplete");
    disconnected_ = look(L"OnDisconnected");
    logonError_ = look(L"OnLogonError");
  }
  void detach() { owner_ = nullptr; }

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (riid == IID_IUnknown || riid == IID_IDispatch || riid == events_) {
      *out = static_cast<IDispatch*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }
  STDMETHODIMP GetTypeInfoCount(UINT* n) override {
    *n = 0;
    return S_OK;
  }
  STDMETHODIMP GetTypeInfo(UINT, LCID, ITypeInfo**) override { return E_NOTIMPL; }
  STDMETHODIMP GetIDsOfNames(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(DISPID id, REFIID, LCID, WORD, DISPPARAMS* params, VARIANT*, EXCEPINFO*, UINT*) override {
    if (!owner_) return S_OK;
    if (id == loginComplete_) {
      owner_->onLoginComplete();
    } else if (id == logonError_ && params && params->cArgs >= 1) {
      VARIANT value; VariantInit(&value);
      if (SUCCEEDED(VariantChangeType(&value, &params->rgvarg[0], 0, VT_I4))) owner_->onLogonError(value.lVal);
      VariantClear(&value);
    } else if (id == disconnected_) {
      int reason = 0;
      if (params && params->cArgs >= 1) {
        VARIANT v;
        VariantInit(&v);
        if (SUCCEEDED(VariantChangeType(&v, &params->rgvarg[0], 0, VT_I4))) reason = v.lVal;
      }
      owner_->onDisconnected(reason);
    }
    return S_OK;
  }

 private:
  virtual ~Sink() = default;
  LONG refs_ = 1;
  RdpSession* owner_;
  IID events_;
  DISPID loginComplete_ = DISPID_UNKNOWN;
  DISPID disconnected_ = DISPID_UNKNOWN;
  DISPID logonError_ = DISPID_UNKNOWN;
};

// The control's default source (event) interface and its type information.
bool findEventInterface(IUnknown* control, IID& iid, ITypeInfo** info) {
  *info = nullptr;
  IProvideClassInfo* pci = nullptr;
  if (FAILED(control->QueryInterface(IID_IProvideClassInfo, reinterpret_cast<void**>(&pci)))) return false;
  ITypeInfo* cls = nullptr;
  bool found = false;
  if (SUCCEEDED(pci->GetClassInfo(&cls)) && cls) {
    TYPEATTR* attr = nullptr;
    if (SUCCEEDED(cls->GetTypeAttr(&attr))) {
      for (UINT i = 0; i < attr->cImplTypes && !found; ++i) {
        INT flags = 0;
        cls->GetImplTypeFlags(i, &flags);
        if ((flags & IMPLTYPEFLAG_FDEFAULT) && (flags & IMPLTYPEFLAG_FSOURCE)) {
          HREFTYPE ref;
          ITypeInfo* ev = nullptr;
          if (SUCCEEDED(cls->GetRefTypeOfImplType(i, &ref)) && SUCCEEDED(cls->GetRefTypeInfo(ref, &ev)) && ev) {
            TYPEATTR* evAttr = nullptr;
            if (SUCCEEDED(ev->GetTypeAttr(&evAttr))) {
              iid = evAttr->guid;
              ev->ReleaseTypeAttr(evAttr);
              *info = ev;
              found = true;
            } else {
              ev->Release();
            }
          }
        }
      }
      cls->ReleaseTypeAttr(attr);
    }
    cls->Release();
  }
  pci->Release();
  return found;
}

}  // namespace

struct RdpSession::Impl {
  Site* site = nullptr;
  Sink* sink = nullptr;
  IOleObject* ole = nullptr;
  IDispatch* disp = nullptr;
  IConnectionPoint* cp = nullptr;
  DWORD cookie = 0;
};

RdpSession::RdpSession() : impl_(new Impl()) {}

RdpSession::~RdpSession() {
  end();
  delete impl_;
}

bool RdpSession::begin(HWND host, int width, int height, std::string* error, const WindowsCredential* credential) {
  end();
  HRESULT hr = CoCreateInstance(kRdpClsid, nullptr, CLSCTX_INPROC_SERVER, IID_IOleObject,
                                reinterpret_cast<void**>(&impl_->ole));
  if (FAILED(hr)) {
    if (error) *error = hrString("the Remote Desktop control is not available", hr);
    return false;
  }
  impl_->site = new Site(host);
  impl_->ole->SetClientSite(impl_->site);
  IPersistStreamInit* persist = nullptr;
  if (SUCCEEDED(impl_->ole->QueryInterface(IID_IPersistStreamInit, reinterpret_cast<void**>(&persist)))) {
    persist->InitNew();
    persist->Release();
  }
  RECT rect;
  GetClientRect(host, &rect);
  hr = impl_->ole->DoVerb(OLEIVERB_INPLACEACTIVATE, nullptr, impl_->site, 0, host, &rect);
  if (FAILED(hr)) {
    if (error) *error = hrString("the Remote Desktop control did not activate", hr);
    end();
    return false;
  }
  impl_->ole->QueryInterface(IID_IDispatch, reinterpret_cast<void**>(&impl_->disp));
  if (!impl_->disp) {
    if (error) *error = "the Remote Desktop control has no automation interface";
    end();
    return false;
  }

  IID eventsIid = {};
  ITypeInfo* eventsInfo = nullptr;
  if (findEventInterface(impl_->ole, eventsIid, &eventsInfo)) {
    impl_->sink = new Sink(this, eventsIid);
    impl_->sink->resolve(eventsInfo);
    eventsInfo->Release();
    IConnectionPointContainer* cpc = nullptr;
    if (SUCCEEDED(impl_->ole->QueryInterface(IID_IConnectionPointContainer, reinterpret_cast<void**>(&cpc)))) {
      if (SUCCEEDED(cpc->FindConnectionPoint(eventsIid, &impl_->cp))) impl_->cp->Advise(impl_->sink, &impl_->cookie);
      cpc->Release();
    }
  } else {
    logLine("rdp: no event interface found; sign-in is detected by polling");
  }

  // The proven order: child-session flag, then the server, then CredSSP.
  IMsRdpExtendedSettings* ext = nullptr;
  hr = impl_->ole->QueryInterface(__uuidof(IMsRdpExtendedSettings), reinterpret_cast<void**>(&ext));
  if (FAILED(hr) || !ext) {
    if (error) *error = hrString("this Windows has no child-session support in the Remote Desktop control", hr);
    end();
    return false;
  }
  BSTR name = SysAllocString(L"ConnectToChildSession");
  VARIANT on = vBool(true);
  hr = ext->put_Property(name, &on);
  SysFreeString(name);
  ext->Release();
  if (FAILED(hr)) {
    if (error) *error = hrString("the control refused ConnectToChildSession", hr);
    end();
    return false;
  }
  VARIANT server = vBstr(L"localhost");
  hr = dispPut(impl_->disp, L"Server", server);
  VariantClear(&server);
  if (FAILED(hr)) {
    if (error) *error = hrString("the control refused the server name", hr);
    end();
    return false;
  }
  dispPut(impl_->disp, L"DesktopWidth", vLong(width));
  dispPut(impl_->disp, L"DesktopHeight", vLong(height));
  dispPut(impl_->disp, L"ColorDepth", vLong(32));
  VARIANT adv;
  if (SUCCEEDED(dispGet(impl_->disp, L"AdvancedSettings9", &adv)) && adv.vt == VT_DISPATCH && adv.pdispVal) {
    hr = dispPut(adv.pdispVal, L"EnableCredSspSupport", vBool(true));
    if (FAILED(hr)) logLine(hrString("rdp: EnableCredSspSupport failed", hr));
    // A dropped loopback link should come back on its own.
    dispPut(adv.pdispVal, L"EnableAutoReconnect", vBool(true));
  }
  VariantClear(&adv);

  hr = nativePromptPolicy(impl_->ole, credential == nullptr);
  if (FAILED(hr)) {
    if (error) *error = "Windows could not configure the sign-in prompt.";
    end(); return false;
  }
  if (credential) {
    std::wstring username = credential->username, domain;
    auto slash = username.find(L'\\');
    if (slash != std::wstring::npos) { domain = username.substr(0, slash); username.erase(0, slash + 1); }
    VARIANT user = vBstr(username.c_str()), realm = vBstr(domain.c_str());
    hr = dispPut(impl_->disp, L"UserName", user);
    if (SUCCEEDED(hr)) hr = dispPut(impl_->disp, L"Domain", realm);
    VariantClear(&user); VariantClear(&realm);
    IMsTscNonScriptable* native = nullptr;
    if (SUCCEEDED(hr)) hr = impl_->ole->QueryInterface(__uuidof(IMsTscNonScriptable), reinterpret_cast<void**>(&native));
    if (SUCCEEDED(hr) && native) {
      BSTR password = SysAllocStringLen(credential->password.data(), static_cast<UINT>(wcslen(credential->password.data())));
      if (!password) hr = E_OUTOFMEMORY;
      else {
        hr = native->put_ClearTextPassword(password);
        SecureZeroMemory(password, SysStringByteLen(password)); SysFreeString(password);
      }
      native->Release();
    }
    if (FAILED(hr)) { if (error) *error = "Windows could not supply the saved credential to Remote Desktop."; end(); return false; }
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    suppliedCredential_ = credential != nullptr;
    state_ = State::Connecting;
    reason_ = 0;
  }
  hr = dispCall(impl_->disp, L"Connect");
  if (FAILED(hr)) {
    if (error) *error = hrString("Connect failed", hr);
    end();
    return false;
  }
  return true;
}

void RdpSession::end() {
  if (impl_->sink) impl_->sink->detach();
  if (impl_->disp) {
    VARIANT connected;
    if (SUCCEEDED(dispGet(impl_->disp, L"Connected", &connected)) && connected.vt == VT_I2 && connected.iVal != 0) {
      dispCall(impl_->disp, L"Disconnect");
    }
    VariantClear(&connected);
  }
  if (impl_->cp) {
    impl_->cp->Unadvise(impl_->cookie);
    impl_->cp->Release();
    impl_->cp = nullptr;
  }
  if (impl_->sink) {
    impl_->sink->Release();
    impl_->sink = nullptr;
  }
  if (impl_->disp) {
    impl_->disp->Release();
    impl_->disp = nullptr;
  }
  if (impl_->ole) {
    impl_->ole->Close(OLECLOSE_NOSAVE);
    impl_->ole->SetClientSite(nullptr);
    impl_->ole->Release();
    impl_->ole = nullptr;
  }
  if (impl_->site) {
    impl_->site->Release();
    impl_->site = nullptr;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  if (state_ == State::Connecting || state_ == State::SignedIn) state_ = State::Ended;
  changed_.notify_all();
}

RdpSession::State RdpSession::waitSettled(int timeoutMs) {
  std::unique_lock<std::mutex> lock(mutex_);
  changed_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return state_ != State::Connecting; });
  return state_;
}

RdpSession::State RdpSession::state() {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_;
}

int RdpSession::disconnectReason() {
  std::lock_guard<std::mutex> lock(mutex_);
  return reason_;
}

void RdpSession::onLogonError(int error) {
  std::lock_guard<std::mutex> lock(mutex_);
  // Other negative codes are session arbitration, not password failures.
  if (suppliedCredential_ && (error == 0 || error == 1 || error == static_cast<int>(0xC000006D) || error == static_cast<int>(0xC0000224))) {
    reason_ = 2055;
    state_ = State::Failed;
    changed_.notify_all();
  }
}

void RdpSession::onLoginComplete() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (state_ != State::Connecting) return;
  state_ = State::SignedIn;
  changed_.notify_all();
}

void RdpSession::onDisconnected(int reason) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (reason_ != 2055) reason_ = reason;
  state_ = state_ == State::Connecting ? State::Failed : State::Ended;
  changed_.notify_all();
}

// ---------------------------------------------------------------------------
// Session facts
// ---------------------------------------------------------------------------

DWORD childSessionId() {
  ULONG id = 0;
  if (!WTSGetChildSessionId(&id)) return 0;
  // No child session reads as 0 or as -1 depending on the build.
  if (id == 0 || id == static_cast<ULONG>(-1)) return 0;
  return id;
}

bool childSessionsEnabled() {
  BOOL enabled = FALSE;
  return WTSIsChildSessionsEnabled(&enabled) && enabled;
}

bool remoteDesktopAllowed() {
  DWORD value = 1;
  DWORD size = sizeof(value);
  LSTATUS rc = RegGetValueW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Terminal Server",
                            L"fDenyTSConnections", RRF_RT_REG_DWORD, nullptr, &value, &size);
  return rc == ERROR_SUCCESS && value == 0;
}

bool consoleLocked() {
  DWORD console = WTSGetActiveConsoleSessionId();
  LPWSTR buffer = nullptr;
  DWORD bytes = 0;
  bool locked = true;
  if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, console, WTSSessionInfoEx, &buffer, &bytes) && buffer) {
    auto* info = reinterpret_cast<WTSINFOEXW*>(buffer);
    if (info->Level == 1) locked = info->Data.WTSInfoExLevel1.SessionFlags != WTS_SESSIONSTATE_UNLOCK;
    WTSFreeMemory(buffer);
  }
  return locked;
}

bool signOutSession(DWORD sessionId) {
  if (!sessionId || sessionId == WTSGetActiveConsoleSessionId()) return false;
  return WTSLogoffSession(WTS_CURRENT_SERVER_HANDLE, sessionId, TRUE) != FALSE;
}

}  // namespace ade
